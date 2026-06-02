import type Database from 'better-sqlite3'
import type { ForgeAdapter, ForgeComment } from '../forge/types.js'
import type { RepoConfig } from '../config/schema.js'
import type { UpdateStrategy } from '../git/worktree.js'
import { coerceConflictSnapshot, type ConflictSnapshot } from './conflict-types.js'
import type { Reaction, ReactionCursor, ReactionType } from '../reactions/types.js'
import { clearResumeDecisionArtifacts } from '../loop/checkpoint.js'
import { RunManager } from '../state/runs.js'
import { LeaseManager } from '../state/leases.js'
import { createFollowupAttempt } from '../state/attempts.js'
import { recordUserAction } from '../state/run-log-events.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { scanForReactions } from '../reactions/scanner.js'
import { parseUtcTimestampMs, nowUtcIso } from '../utils/time.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { upsertBotComment, markerTag } from '../forge/bot-comment.js'
import { logger } from '../utils/logger.js'
import { z } from 'zod'

const STATUS_MARKER = markerTag('status')
const COMMENT_COMMAND_RE = /^\s*\/(?:orch|night-orch)\b/im
const EMPTY_CURSOR: ReactionCursor = {
  lastReviewId: 0,
  lastCommentId: 0,
  lastIssueCommentId: 0,
  lastCheckConclusion: null,
  lastMergeableState: null,
}

const CONTINUABLE_STATUSES = new Set(['blocked', 'review_ready', 'error'])
const PHASE_CHECKPOINT_FALLBACK_ORDER = ['decide', 'review', 'verify', 'code', 'plan'] as const

interface ContinueConflictExcerpt {
  path: string
  preview: string
}

const ContinueControlPayloadSchema = z.object({
  conflictSummary: z.unknown().optional().transform((value) => typeof value === 'string' ? value : undefined),
  conflictFiles: z.unknown().optional().transform((value) => toStringArray(value)),
  conflictExcerpts: z.unknown().optional().transform((value) => toConflictExcerpts(value)),
  conflictSnapshot: z.unknown().optional(),
}).passthrough()

type ContinueControlPayload = z.infer<typeof ContinueControlPayloadSchema>

const EMPTY_CONTINUE_CONTROL_PAYLOAD: ContinueControlPayload = {
  conflictFiles: [],
  conflictExcerpts: [],
}

export interface QueueContinueOptions {
  issueRepo?: string
  dryRun?: boolean
  strategyOverride?: UpdateStrategy
  actor?: string
  maxAttemptChainLength?: number
}

export async function queueContinue(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  issueNumber: number,
  botUser: string,
  options: QueueContinueOptions = {},
): Promise<{ queued: boolean; reason: string }> {
  const runManager = new RunManager(db)
  const leaseManager = new LeaseManager(db)

  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run) {
    return { queued: false, reason: 'No run found for this issue' }
  }

  if (run.status === 'running' || run.status === 'queued') {
    return { queued: false, reason: `Run is already ${run.status}` }
  }

  if (!CONTINUABLE_STATUSES.has(run.status)) {
    return { queued: false, reason: `Continue supports blocked/review_ready/error runs (current: ${run.status})` }
  }

  const issueRepo = options.issueRepo ?? resolveIssueRepo(run.phaseData, repoConfig.repo)
  if (options.dryRun) {
    return { queued: true, reason: 'Would queue a context-aware continue pass' }
  }

  const applyStrategyDuringResume = run.manualState === 'awaiting_rebase_resolution' && options.strategyOverride !== undefined
  const followup = await buildFollowupContext({
    forge,
    issueRepo,
    issueNumber,
    prNumber: run.prNumber,
    runEndedAt: run.endedAt,
    previousError: run.lastError,
    botUser,
    manualState: run.manualState,
    controlPayload: run.controlPayload,
  })

  const existingPhaseData = clearResumeDecisionArtifacts(run.phaseData)
  const resumePhase = resolveResumePhase(run.currentPhase, existingPhaseData, run.manualState)

  // Atomic state transition: finalize the previous attempt + INSERT a
  // new one + release leases in a single DB transaction. Previously this
  // called subtractRunCostFromDaily to avoid the per-run cost check
  // re-blocking the same mutated row — under the attempts model, the new
  // row starts with a zero cost ledger and the old row's costs remain
  // attributed to it, so the subtract-and-zero dance is unnecessary.
  const newAttemptId = (() => {
    try {
      const tx = db.transaction((): string => {
        const result = createFollowupAttempt(db, {
          previousAttemptId: run.id,
          intent: 'continue',
          resetBranch: false,
          ...(options.maxAttemptChainLength !== undefined
            ? { maxSequenceNumber: options.maxAttemptChainLength }
            : {}),
          phaseData: {
            ...existingPhaseData,
            issueRepo,
            reactionType: followup.primaryType,
            reactionSummary: followup.summary,
            reactionContext: followup.context,
            reactionConflictSnapshot: followup.conflictSnapshot,
            continueRequestedAt: nowUtcIso(),
          },
          controlPayload: {
            source: run.manualState === 'awaiting_rebase_resolution' ? 'rebase_conflict' : 'manual_continue',
            issueRepo,
            preserveBranchState: applyStrategyDuringResume ? false : true,
            requestedAt: nowUtcIso(),
            ...(options.strategyOverride ? { updateStrategy: options.strategyOverride } : {}),
          },
        })
        // Seed the resume phase on the new attempt so the engine picks up
        // where the previous one left off. createFollowupAttempt starts
        // with current_phase=NULL and iteration=0 by design.
        if (resumePhase) {
          runManager.updatePhaseCheckpoint(result.attemptId, resumePhase, null, 0)
        }
        leaseManager.release(issueRepo, issueNumber)
        if (issueRepo !== repoConfig.repo) {
          leaseManager.release(repoConfig.repo, issueNumber)
        }
        return result.attemptId
      })
      return tx()
    } catch (err) {
      logger.warn({ runId: run.id, err }, 'Failed to queue continue attempt')
      return null
    }
  })()

  if (newAttemptId === null) {
    return { queued: false, reason: 'Run state changed while queuing continue' }
  }

  recordUserAction(db, {
    runId: newAttemptId,
    kind: 'continue',
    actor: options.actor ?? 'manual',
    details: options.strategyOverride ? { strategy: options.strategyOverride } : null,
  })

  try {
    const issue = await forge.getIssue(issueRepo, issueNumber)
    await transitionLabels(
      forge,
      issueRepo,
      issueNumber,
      issue.labels,
      run.status,
      'queued',
      buildLabelConfig(repoConfig, issue.labels),
    )
  } catch (err) {
    logger.warn({ repo: issueRepo, issueNumber, err }, 'Failed to transition labels for continue queue')
  }

  await commentStatus(
    forge,
    issueRepo,
    issueNumber,
    botUser,
    `Queued continue pass. ${followup.summary}`,
  )

  logger.info(
    {
      repo: issueRepo,
      issueNumber,
      runId: run.id,
      primaryType: followup.primaryType,
      strategyOverride: options.strategyOverride,
    },
    'Queued issue for continue pass',
  )

  return { queued: true, reason: `Queued for continue pass (${followup.summary})` }
}

function resolveResumePhase(
  currentPhase: string | null,
  phaseData: Record<string, unknown>,
  manualState: 'none' | 'awaiting_rebase_resolution',
): string | null {
  if (manualState === 'awaiting_rebase_resolution') {
    return isCheckpointArtifact(phaseData['plan']) ? 'code' : 'plan'
  }

  if (
    typeof currentPhase === 'string'
    && currentPhase.trim().length > 0
    && currentPhase !== 'blocked'
    && currentPhase !== 'completed'
  ) {
    return currentPhase
  }

  for (const phase of PHASE_CHECKPOINT_FALLBACK_ORDER) {
    if (isCheckpointArtifact(phaseData[phase])) {
      return phase
    }
  }

  return null
}

function isCheckpointArtifact(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface BuildFollowupContextParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  prNumber: number | null
  runEndedAt: string | null
  previousError: string | null
  botUser: string
  manualState: 'none' | 'awaiting_rebase_resolution'
  controlPayload: Record<string, unknown> | null
}

interface FollowupContextPayload {
  primaryType: string
  summary: string
  context: string
  conflictSnapshot: ConflictSnapshot | null
}

async function buildFollowupContext(params: BuildFollowupContextParams): Promise<FollowupContextPayload> {
  const {
    forge,
    issueRepo,
    issueNumber,
    prNumber,
    runEndedAt,
    previousError,
    botUser,
    manualState,
    controlPayload,
  } = params
  const parsedControlPayload = parseContinueControlPayload(controlPayload)

  const sections: string[] = []
  const summaryParts: string[] = []

  if (previousError?.trim()) {
    sections.push(`## Previous Run State\n\n${previousError.trim()}`)
  }

  if (manualState === 'awaiting_rebase_resolution') {
    const rebaseContext = formatRebaseResolutionContext(parsedControlPayload)
    const snapshot = coerceConflictSnapshot(parsedControlPayload.conflictSnapshot)
    sections.push(rebaseContext)
    summaryParts.push(snapshot?.source === 'branch_refresh' ? 'branch refresh conflict resolution' : 'rebase conflict resolution')
  }

  const reactions = await collectReactions({
    forge,
    issueRepo,
    issueNumber,
    prNumber,
  })
  if (reactions.length > 0) {
    sections.push(formatReactionSection(reactions))
    summaryParts.push(...summarizeReactionTypes(reactions.map((reaction) => reaction.type)))
  }

  const comments = await collectConversationComments({
    forge,
    issueRepo,
    issueNumber,
    runEndedAt,
    botUser,
  })
  if (comments.length > 0) {
    sections.push(formatConversationComments(comments))
    summaryParts.push('new PR comments')
  }

  if (sections.length === 0) {
    sections.push(
      'No new CI failures, merge conflicts, or review comments were detected. Re-evaluate the existing branch and finish the PR.',
    )
  }

  const dedupedSummaryParts = [...new Set(summaryParts)]
  const summary = dedupedSummaryParts.length > 0
    ? `Continue requested with ${dedupedSummaryParts.join(', ')}`
    : 'Continue requested — re-evaluate and complete the PR'

  return {
    primaryType: manualState === 'awaiting_rebase_resolution' ? 'rebase_conflict_resolution' : 'continue',
    summary,
    context: sections.join('\n\n'),
    conflictSnapshot: coerceConflictSnapshot(parsedControlPayload.conflictSnapshot),
  }
}

function formatRebaseResolutionContext(controlPayload: ContinueControlPayload): string {
  const snapshot = coerceConflictSnapshot(controlPayload.conflictSnapshot)
  const contextLabel = snapshot?.source === 'branch_refresh' ? 'Branch Refresh Conflict Analysis' : 'Rebase Conflict Analysis'
  const guidance = snapshot?.source === 'branch_refresh'
    ? 'A prior branch refresh attempt hit conflicts. Continue should keep the existing branch and reconcile the upstream changes instead of starting fresh.'
    : 'A prior explicit rebase attempt hit conflicts. Continue should keep the existing branch and resolve the upstream changes manually instead of starting fresh.'
  const lines = [
    `## ${contextLabel}`,
    '',
    guidance,
  ]

  const summary = controlPayload.conflictSummary?.trim() ?? ''
  if (summary) {
    lines.push('', summary)
  }

  const files = controlPayload.conflictFiles
  if (files.length > 0) {
    lines.push('', 'Conflicting files:')
    for (const value of files.slice(0, 12)) {
      if (value.trim().length > 0) {
        lines.push(`- ${value}`)
      }
    }
  }

  const excerpts = controlPayload.conflictExcerpts
  if (excerpts.length > 0) {
    lines.push('', 'Conflict excerpts:')
    for (const entry of excerpts.slice(0, 3)) {
      const path = entry.path
      const preview = entry.preview
      lines.push(`- ${path}`)
      if (preview.trim()) {
        lines.push(`  Preview: ${preview.trim()}`)
      }
    }
  }

  return lines.join('\n')
}

function parseContinueControlPayload(
  value: Record<string, unknown> | null,
): ContinueControlPayload {
  if (!value) {
    return EMPTY_CONTINUE_CONTROL_PAYLOAD
  }
  const parsed = ContinueControlPayloadSchema.safeParse(value)
  if (!parsed.success) {
    return EMPTY_CONTINUE_CONTROL_PAYLOAD
  }
  return parsed.data
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function toConflictExcerpts(value: unknown): ContinueConflictExcerpt[] {
  if (!Array.isArray(value)) return []
  const excerpts: ContinueConflictExcerpt[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const path = typeof entry['path'] === 'string' ? entry['path'] : '(unknown)'
    const preview = typeof entry['preview'] === 'string' ? entry['preview'] : ''
    excerpts.push({ path, preview })
  }
  return excerpts
}

interface CollectReactionsParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  prNumber: number | null
}

async function collectReactions(params: CollectReactionsParams): Promise<Reaction[]> {
  const { forge, issueRepo, issueNumber, prNumber } = params
  if (!prNumber) return []

  try {
    const scanResult = await scanForReactions(
      forge,
      issueRepo,
      prNumber,
      issueNumber,
      EMPTY_CURSOR,
    )
    return scanResult.reactions
  } catch (err) {
    logger.warn({ repo: issueRepo, issueNumber, prNumber, err }, 'Failed to scan reactions for continue queue')
    return []
  }
}

interface CollectConversationCommentsParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  runEndedAt: string | null
  botUser: string
}

async function collectConversationComments(params: CollectConversationCommentsParams): Promise<ForgeComment[]> {
  const { forge, issueRepo, issueNumber, runEndedAt, botUser } = params

  let comments: ForgeComment[]
  try {
    comments = await forge.listIssueComments(issueRepo, issueNumber)
  } catch (err) {
    logger.warn({ repo: issueRepo, issueNumber, err }, 'Failed to list issue comments for continue queue')
    return []
  }

  const runEndedAtMs = parseUtcTimestampMs(runEndedAt)
  const hasRunEndTime = Number.isFinite(runEndedAtMs)

  const filtered = comments.filter((comment) => {
    if (!comment.body.trim()) return false
    if (comment.user === botUser) return false
    if (COMMENT_COMMAND_RE.test(comment.body)) return false

    if (!hasRunEndTime) return true
    const createdAtMs = parseUtcTimestampMs(comment.createdAt)
    return Number.isFinite(createdAtMs) && createdAtMs > runEndedAtMs
  })

  const selected = filtered.length > 0
    ? filtered
    : comments
      .filter((comment) => {
        if (!comment.body.trim()) return false
        if (comment.user === botUser) return false
        return !COMMENT_COMMAND_RE.test(comment.body)
      })
      .slice(-3)

  return selected.slice(-10)
}

function formatReactionSection(reactions: Reaction[]): string {
  const lines = ['## PR Signals Since Last Pass']

  for (const reaction of reactions) {
    lines.push('')
    lines.push(`### ${reaction.summary}`)
    lines.push(reaction.context)
  }

  return lines.join('\n')
}

function formatConversationComments(comments: ForgeComment[]): string {
  const lines = ['## New PR Conversation Comments']

  for (const comment of comments) {
    lines.push('')
    lines.push(`### ${comment.user} (${comment.createdAt})`)
    lines.push(comment.body.trim())
  }

  return lines.join('\n')
}

function summarizeReactionTypes(types: ReactionType[]): string[] {
  const unique = [...new Set(types)]
  return unique.map((type) => {
    switch (type) {
      case 'merge_conflict':
        return 'merge conflicts'
      case 'ci_failure':
        return 'failing CI checks'
      case 'human_review':
        return 'requested review changes'
      case 'review_comment':
        return 'inline review comments'
      case 'external_review':
        return 'external review findings'
      case 'mention_feedback':
        return 'mention feedback'
    }
  })
}

async function commentStatus(
  forge: ForgeAdapter,
  repo: string,
  issueNumber: number,
  botUser: string,
  message: string,
): Promise<void> {
  try {
    if (botUser) {
      await upsertBotComment(forge, repo, issueNumber, STATUS_MARKER, `**night-orch**: ${message}`, botUser)
    } else {
      await forge.commentOnIssue(repo, issueNumber, `**night-orch**: ${message}`)
    }
  } catch (err) {
    logger.warn({ repo, issueNumber, err }, 'Failed to post continue status comment')
  }
}
