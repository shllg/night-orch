import type { Config } from '../config/schema.js'
import type { RunRecord } from '../state/runs.js'
import type { RunManager } from '../state/runs.js'
import type { RunManualState, RunOperationIntent } from '../state/runs.js'
import type { ResolvedRoles } from '../discovery/roles.js'
import type { DiscoveredIssue } from '../discovery/discover.js'
import type { ResolvedWorkflow } from '../loop/workflow.js'
import type { RunContext } from '../loop/types.js'
import type { UpdateStrategy } from '../git/worktree.js'
import type { BlockedReason } from '../loop/state.js'
import { coerceConflictSnapshot, type ConflictSnapshot } from '../ops/conflict-types.js'
import { assertNever, blockedReasonFromLegacy } from '../loop/state.js'
import type { NotificationPayload } from '../notify/types.js'
import type { ForgeAdapter } from '../forge/types.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'

export const STATUS_MARKER = markerTag('status')

export const TAINTED_BLOCK_REASONS = new Set([
  'agent_pass_limit',
  'merge_conflict',
  'auth_failure',
  'empty_diff',
])

const ERROR_COMMENT_MAX_LENGTH = 400
const TOKEN_REDACTION_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
]

export function coerceAgentName(
  value: string,
  fallback: ResolvedRoles['planner'],
): ResolvedRoles['planner'] {
  if (value === 'claude' || value === 'codex' || value === 'opencode') {
    return value
  }
  return fallback
}

export function isImmediateFollowupStatus(status: RunRecord['status']): boolean {
  return status === 'review_ready'
    || status === 'blocked'
    || status === 'error'
    || status === 'completed'
}

export function applyWorkflowAgentOverrides(
  repoConfig: Config['repos'][number],
  workflow: ResolvedWorkflow,
): Config['repos'][number] {
  if (!workflow.agents || Object.keys(workflow.agents).length === 0) {
    return repoConfig
  }
  return {
    ...repoConfig,
    agents: {
      ...repoConfig.agents,
      ...workflow.agents,
    },
  }
}

export function applyWorkflowRoleDefaults(
  repoDefaults: Config['repos'][number]['defaults'],
  workflow: ResolvedWorkflow,
  repoConfig: Config['repos'][number],
  config: Config,
): Config['repos'][number]['defaults'] {
  if (!workflow.roles) {
    return repoDefaults
  }
  const merged: Config['repos'][number]['defaults'] = {
    ...repoDefaults,
    ...workflow.roles,
  }
  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const preferredAgent = merged[role]
    if (canResolveAgent(preferredAgent, repoConfig, config)) continue
    merged[role] = repoDefaults[role]
  }
  return merged
}

function canResolveAgent(
  agent: Config['repos'][number]['defaults']['planner'],
  repoConfig: Config['repos'][number],
  config: Config,
): boolean {
  return resolveWorkerProfileForAgent(agent, repoConfig, config) !== null
}

export function resolveWorkerProfileForAgent(
  agent: Config['repos'][number]['defaults']['planner'],
  repoConfig: Config['repos'][number],
  config: Config,
): Config['workerProfiles'][string] | null {
  const mappedProfileName = repoConfig.agents[agent]
  if (mappedProfileName) {
    const mappedProfile = config.workerProfiles[mappedProfileName]
    if (mappedProfile) return mappedProfile
  }
  return Object.values(config.workerProfiles).find((profile) => profile.type === agent) ?? null
}

export function buildBlockReason(ctx: RunContext): string {
  const blockMessage = ctx.stepOutputs?.['blockMessage']
  if (typeof blockMessage === 'string' && blockMessage.trim().length > 0) {
    return blockMessage
  }
  if (ctx.reviewResult) {
    const findings = ctx.reviewResult.findings
      .filter((f) => f.severity === 'critical' || f.severity === 'major')
      .map((f) => `[${f.severity}] ${f.message}`)
      .join('; ')
    return findings
      ? `${ctx.reviewResult.summary} — ${findings}`
      : ctx.reviewResult.summary
  }
  if (ctx.blockReason) {
    // Bridge: ctx.blockReason is still the legacy string enum (R1d will
    // retype). Lift through fromLegacy so blockReasonSummary only sees
    // the typed shape.
    return blockReasonSummary(blockedReasonFromLegacy(ctx.blockReason), ctx)
  }
  return `Blocked in phase ${ctx.currentPhase} (no review result available)`
}

/**
 * Render a human-readable, action-oriented summary for a typed
 * `BlockedReason`. Used as the body of the blocked status comment and
 * the lastError column on the run row.
 *
 * Exhaustive switch — adding a new variant to `BlockedReason` in
 * `loop/state.ts` produces a compile error here until handled.
 */
export function blockReasonSummary(reason: BlockedReason, ctx: RunContext): string {
  switch (reason.type) {
    case 'costLimit':
      return `Cost limit exceeded (estimated: $${ctx.estimatedCostUsd.toFixed(4)}). Grant a budget override or raise the limit in Settings to continue.`
    case 'iterationLimit':
      return `Maximum review iterations reached (${ctx.iteration}/${ctx.adjustedLimits.maxReviewIterations}). Use /orch continue to add more iterations with PR context, or raise the limit in Settings.`
    case 'agentPassLimit':
      return `Maximum total agent passes reached (${ctx.totalAgentPasses}/${ctx.adjustedLimits.maxTotalAgentPasses}). Use /orch continue to resume, or raise the limit in Settings.`
    case 'reviewerBlocked':
      return 'Reviewer marked this run as blocked. Address the review findings, then use /orch continue.'
    case 'ambiguousReview':
      return 'Review output was not parseable. Use /orch retry to re-run, or disable blockOnAmbiguousReview in Settings.'
    case 'verifyConfig':
      return 'Verification is required but verify commands or results are unavailable. Check repo verify config.'
    case 'mergeConflict':
      return 'Rebase or merge conflict encountered. Use /orch continue to keep the existing branch and resolve the conflict, or /orch retry to start fresh from the latest base branch.'
    case 'authFailure':
      return `Worker CLI authentication expired (${reason.adapter}). Re-authenticate the worker CLI, then use /orch retry.`
    case 'emptyDiff':
      return `Coder produced no file changes after ${ctx.emptyDiffRetries} attempt(s). The task may need clarification. Use /orch retry to start fresh from the latest base branch.`
    case 'workerTimeout':
      return `${reason.adapter} timed out during ${reason.step} after ${reason.timeoutMs}ms. Use /orch retry to start fresh, or increase the worker timeout in Settings.`
    case 'tokenCaptureFailed':
      return `${reason.adapter} produced output without parseable token usage during ${reason.step}. This is a worker bug — capture the raw output and file an issue.`
    default:
      return assertNever(reason, 'blockReasonSummary')
  }
}

export function formatBlockComment(reason: string, ctx: RunContext): string {
  const parts = [`⛔ **night-orch**: Run blocked.\n\n**Reason:** ${reason}`]
  if (ctx.reviewResult?.findings && ctx.reviewResult.findings.length > 0) {
    parts.push('\n**Findings:**')
    for (const f of ctx.reviewResult.findings) {
      const fix = f.suggestedFix ? ` → ${f.suggestedFix}` : ''
      parts.push(`- **${f.severity}**: ${f.message}${fix}`)
    }
  }
  parts.push(`\n*Iteration ${ctx.iteration}, cost: $${ctx.estimatedCostUsd.toFixed(4)}*`)
  return parts.join('\n')
}

export function makePayload(
  event: NotificationPayload['event'],
  repo: string,
  issue: { number: number; title: string; url?: string },
  extra: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    event,
    repo,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.url ?? null,
    state: event,
    prUrl: null,
    prNumber: null,
    summary: `${event}: #${issue.number} ${issue.title}`,
    blockingReason: null,
    reviewSummary: null,
    iterationCount: 0,
    timestamp: nowUtcIso(),
    ...extra,
  }
}

export interface PostStatusCommentParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  botUser: string
  body: string
  warnMessage: string
}

export async function postStatusComment(params: PostStatusCommentParams): Promise<void> {
  const { forge, issueRepo, issueNumber, botUser, body, warnMessage } = params
  try {
    if (botUser) {
      await upsertBotComment(forge, issueRepo, issueNumber, STATUS_MARKER, body, botUser)
    } else {
      await forge.commentOnIssue(issueRepo, issueNumber, body)
    }
  } catch (commentErr) {
    logger.warn({ repo: issueRepo, issueNumber, err: commentErr }, warnMessage)
  }
}

export interface PostErrorStatusCommentParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  botUser: string
  error: string
  retryCount: number
  maxRetries: number
  nextStep: string
  warnMessage: string
}

export async function postErrorStatusComment(params: PostErrorStatusCommentParams): Promise<void> {
  const { forge, issueRepo, issueNumber, botUser, error, retryCount, maxRetries, nextStep, warnMessage } = params
  const sanitizedError = sanitizeErrorForComment(error)
  const body = formatStatusComment({
    error: sanitizedError,
    retryCount,
    maxRetries,
    nextStep,
  })
  await postStatusComment({ forge, issueRepo, issueNumber, botUser, body, warnMessage })
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim().length > 0) {
    return err.message
  }
  return String(err)
}

export function sanitizeErrorForComment(errorMessage: string): string {
  let sanitized = errorMessage.replace(/[\r\n]+/g, ' ')
  sanitized = stripControlChars(sanitized)
  sanitized = sanitized
    .replace(/\b(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .trim()
  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  sanitized = sanitized.replace(/\s+/g, ' ').trim()
  if (!sanitized) return 'unknown error'
  const clipped = sanitized.length > ERROR_COMMENT_MAX_LENGTH
    ? `${sanitized.slice(0, ERROR_COMMENT_MAX_LENGTH - 1)}…`
    : sanitized
  return escapeMarkdownForComment(clipped)
}

function escapeMarkdownForComment(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_#[\]])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200B')
}

function stripControlChars(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if ((code >= 0 && code <= 31) || code === 127) {
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

export interface FollowupPromptFeedback {
  type: string
  summary: string
  context: string
  conflictSnapshot?: ConflictSnapshot | null
}

export function extractFollowupPromptFeedback(
  phaseData: Record<string, unknown> | null | undefined,
): FollowupPromptFeedback | null {
  if (!phaseData) return null
  const context = phaseData['reactionContext']
  if (typeof context !== 'string' || context.trim().length === 0) return null
  const type = typeof phaseData['reactionType'] === 'string' && phaseData['reactionType'].trim().length > 0
    ? phaseData['reactionType']
    : 'continue'
  const summary = typeof phaseData['reactionSummary'] === 'string' && phaseData['reactionSummary'].trim().length > 0
    ? phaseData['reactionSummary']
    : 'Follow-up context available'
  const conflictSnapshot = coerceConflictSnapshot(phaseData['reactionConflictSnapshot'])
  return { type, summary, context, conflictSnapshot }
}

export function buildAttemptHistoryFollowup(
  previousRun: RunRecord | null | undefined,
): FollowupPromptFeedback | null {
  if (!previousRun) return null
  if (previousRun.status === 'queued' || previousRun.status === 'running' || previousRun.status === 'completed') {
    return null
  }

  const statusSummary = previousRun.blockReason
    ? `${previousRun.status} (${previousRun.blockReason})`
    : previousRun.status

  const lines = [
    '## Previous Run State',
    `Run ID: ${previousRun.id}`,
    `Status: ${previousRun.status}`,
  ]

  if (previousRun.blockReason) {
    lines.push(`Block reason: ${previousRun.blockReason}`)
  }
  if (previousRun.lastError) {
    lines.push(`Last error: ${previousRun.lastError}`)
  }
  if (previousRun.iterationCount > 0) {
    lines.push(`Iteration count: ${previousRun.iterationCount}`)
  }
  if (previousRun.prNumber !== null) {
    lines.push(`PR number: #${previousRun.prNumber}`)
  }

  return {
    type: 'previous_attempt',
    summary: `Previous attempt ${previousRun.id} ended as ${statusSummary}`,
    context: lines.join('\n'),
  }
}

export function resolveOperationIntent(run: RunRecord | null | undefined): RunOperationIntent {
  if (!run) return 'auto'
  if (run.operationIntent !== 'auto') return run.operationIntent

  if (run.status === 'queued') {
    if (run.blockReason === 'merge_conflict') return 'retry'
    const reactionType = run.phaseData?.reactionType
    if (reactionType === 'rebase') return 'rebase'
    if (reactionType === 'merge_conflict' || reactionType === 'refresh') return 'refresh'
    if (typeof reactionType === 'string' && reactionType.trim().length > 0) return 'continue'
  }

  return 'auto'
}

export function resolveManualState(run: RunRecord | null | undefined): RunManualState {
  if (!run) return 'none'
  return run.manualState
}

export function resolveControlPayload(
  run: RunRecord | null | undefined,
): Record<string, unknown> | null {
  if (!run?.controlPayload) return null
  return run.controlPayload
}

export function prioritizeDiscoveredIssues(
  runManager: RunManager,
  repo: string,
  discovered: DiscoveredIssue[],
): DiscoveredIssue[] {
  const ranked = discovered.map((item) => ({
    item,
    rank: getIssueQueuePriority(runManager, repo, item.issue.number),
  }))
  ranked.sort((a, b) => a.rank - b.rank)
  return ranked.map((entry) => entry.item)
}

function getIssueQueuePriority(
  runManager: RunManager,
  repo: string,
  issueNumber: number,
): number {
  const queuedRun = runManager.getLatestQueuedByIssue(repo, issueNumber)
  if (!queuedRun) return 3
  const operationIntent = resolveOperationIntent(queuedRun)
  if (operationIntent === 'rebase' || operationIntent === 'refresh') return 0
  if (operationIntent === 'continue' || operationIntent === 'retry') return 1
  return 2
}

export function selectReplayableRun(run: RunRecord | null): RunRecord | null {
  if (!run) return null
  if (run.status === 'blocked' || run.status === 'error') {
    return run
  }
  return null
}

export interface BranchPolicy {
  preserveBranchState: boolean
  resetToBase: boolean
  runMode: RunContext['runMode']
}

export interface DeriveBranchPolicyInput {
  operationIntent: RunRecord['operationIntent']
  controlPayload: Record<string, unknown> | null
  planningMode: boolean
  updateStrategyOverride: UpdateStrategy | undefined
  shouldResetFromHistory: boolean
  hasFollowupPromptFeedback: boolean
}

export function deriveBranchPolicy(input: DeriveBranchPolicyInput): BranchPolicy {
  const {
    operationIntent,
    controlPayload,
    planningMode,
    updateStrategyOverride,
    shouldResetFromHistory,
    hasFollowupPromptFeedback,
  } = input
  const preserveBranchState = Boolean(controlPayload?.['preserveBranchState'])
    || operationIntent === 'refresh'
    || operationIntent === 'rebase'
    || (operationIntent === 'continue' && updateStrategyOverride === undefined)

  const resetToBase = operationIntent === 'retry'
    || (
      operationIntent === 'auto'
      && (planningMode || shouldResetFromHistory)
    )

  const runMode: RunContext['runMode'] = operationIntent === 'rebase'
    ? 'rebase'
    : operationIntent === 'refresh'
      ? 'refresh'
      : operationIntent === 'continue' || hasFollowupPromptFeedback
        ? 'followup'
        : 'fresh'

  return {
    preserveBranchState,
    resetToBase,
    runMode,
  }
}

export function shouldResetBranch(
  runManager: RunManager,
  repo: string,
  issueNumber: number,
  currentRunId: string,
): boolean {
  const prior = runManager.getLatestFinishedByIssue(repo, issueNumber, currentRunId)
  if (!prior) return false
  if (prior.status === 'error') return true
  if (prior.status === 'blocked' && prior.blockReason && TAINTED_BLOCK_REASONS.has(prior.blockReason)) return true
  return false
}
