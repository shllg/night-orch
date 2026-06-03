import type Database from 'better-sqlite3'
import type { ForgeAdapter, ForgeComment } from '../forge/types.js'
import type { RepoConfig } from '../config/schema.js'
import type { UpdateStrategy } from '../git/worktree.js'
import { coerceConflictSnapshot, type ConflictSnapshot } from './conflict-types.js'
import type { ReactionCursor, ReactionEnvelope, ReactionType } from '../reactions/types.js'
import { clearResumeDecisionArtifacts } from '../loop/checkpoint.js'
import { RunManager } from '../state/runs.js'
import { LeaseManager } from '../state/leases.js'
import { parseControlPayload } from '../state/run-payloads.js'
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

const ContinueControlPayloadRecordSchema = z.object({
  conflictSummary: z.unknown().optional(),
  conflictFiles: z.unknown().optional(),
  conflictExcerpts: z.unknown().optional(),
  conflictSnapshot: z.unknown().optional(),
}).passthrough()

interface ContinueControlPayload {
  conflictSummary?: string
  conflictFiles: string[]
  conflictExcerpts: ContinueConflictExcerpt[]
  conflictSnapshot?: unknown
  warnings: string[]
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
  const controlPayloadState = inspectStoredControlPayload(db, run.id, run.controlPayload)
  const followup = await buildFollowupContext({
    forge,
    issueRepo,
    issueNumber,
    prNumber: run.prNumber,
    runEndedAt: run.endedAt,
    previousError: run.lastError,
    botUser,
    manualState: run.manualState,
    controlPayload: controlPayloadState.payload,
    controlPayloadWarnings: controlPayloadState.warnings,
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

function inspectStoredControlPayload(
  db: Database.Database,
  runId: string,
  payload: Record<string, unknown> | null,
): { payload: Record<string, unknown> | null; warnings: string[] } {
  if (payload !== null) {
    return { payload, warnings: [] }
  }

  const row = db.prepare('SELECT control_payload AS raw FROM runs WHERE id = ?').get(runId) as
    | { raw: string | null }
    | undefined
  if (!row?.raw) {
    return { payload: null, warnings: [] }
  }

  const parsed = parseControlPayload(row.raw)
  if (parsed.ok) {
    return { payload: parsed.data, warnings: [] }
  }

  return {
    payload: null,
    warnings: [`control_payload: ${parsed.reason} (${parsed.detail})`],
  }
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
  controlPayloadWarnings?: string[]
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
    controlPayloadWarnings = [],
  } = params
  const parsedControlPayload = parseContinueControlPayload(controlPayload, controlPayloadWarnings)

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

  if (parsedControlPayload.warnings.length > 0) {
    summaryParts.push('malformed control payload')
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

  if (controlPayload.warnings.length > 0) {
    lines.push('', '## Malformed Continue Control Payload')
    lines.push('', 'Some saved conflict metadata could not be used. The continue pass may need to inspect the branch state directly.')
    for (const warning of controlPayload.warnings) {
      lines.push(`- ${warning}`)
    }
  }

  return lines.join('\n')
}

function parseContinueControlPayload(
  value: Record<string, unknown> | null,
  inheritedWarnings: string[] = [],
): ContinueControlPayload {
  if (!value) {
    return {
      conflictFiles: [],
      conflictExcerpts: [],
      warnings: inheritedWarnings,
    }
  }
  const parsed = ContinueControlPayloadRecordSchema.safeParse(value)
  if (!parsed.success) {
    return {
      conflictFiles: [],
      conflictExcerpts: [],
      warnings: [...inheritedWarnings, 'controlPayload: expected a plain object'],
    }
  }
  return {
    conflictSummary: parseOptionalStringField(parsed.data, 'conflictSummary'),
    conflictFiles: parseConflictFiles(parsed.data),
    conflictExcerpts: parseConflictExcerpts(parsed.data),
    conflictSnapshot: parsed.data.conflictSnapshot,
    warnings: [
      ...inheritedWarnings,
      ...validateConflictFiles(parsed.data),
      ...validateConflictExcerpts(parsed.data),
    ],
  }
}

function parseOptionalStringField(
  payload: z.infer<typeof ContinueControlPayloadRecordSchema>,
  key: 'conflictSummary',
): string | undefined {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

function parseConflictFiles(payload: z.infer<typeof ContinueControlPayloadRecordSchema>): string[] {
  const value = payload.conflictFiles
  if (value === undefined) return []
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function parseConflictExcerpts(payload: z.infer<typeof ContinueControlPayloadRecordSchema>): ContinueConflictExcerpt[] {
  const value = payload.conflictExcerpts
  if (value === undefined) return []
  if (!Array.isArray(value)) return []
  const excerpts: ContinueConflictExcerpt[] = []
  for (const entry of value) {
    if (!isConflictExcerpt(entry)) continue
    const path = entry.path
    const preview = entry.preview
    excerpts.push({ path, preview })
  }
  return excerpts
}

function validateConflictFiles(payload: z.infer<typeof ContinueControlPayloadRecordSchema>): string[] {
  const value = payload.conflictFiles
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    return ['conflictFiles: expected an array of strings']
  }
  return value.every((entry) => typeof entry === 'string')
    ? []
    : ['conflictFiles: expected an array of strings']
}

function validateConflictExcerpts(payload: z.infer<typeof ContinueControlPayloadRecordSchema>): string[] {
  const value = payload.conflictExcerpts
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    return ['conflictExcerpts: expected an array of entries with string path and preview']
  }
  return value.every(isConflictExcerpt)
    ? []
    : ['conflictExcerpts: expected entries with string path and preview']
}

function isConflictExcerpt(value: unknown): value is ContinueConflictExcerpt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record['path'] === 'string'
    && typeof record['preview'] === 'string'
  )
}

interface CollectReactionsParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  prNumber: number | null
}

async function collectReactions(params: CollectReactionsParams): Promise<ReactionEnvelope[]> {
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

function formatReactionSection(reactions: ReactionEnvelope[]): string {
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
