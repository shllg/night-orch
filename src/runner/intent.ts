import { z } from 'zod'
import type { RunManager, RunManualState, RunOperationIntent, RunRecord } from '../state/runs.js'
import type { RunContext } from '../loop/types.js'
import type { UpdateStrategy } from '../git/worktree.js'
import { coerceConflictSnapshot, type ConflictSnapshot } from '../ops/conflict-types.js'
import { logger } from '../utils/logger.js'

export interface RunControlPayload {
  issueRepo?: string
  preserveBranchState?: boolean
  updateStrategy?: UpdateStrategy
  checkAfter?: boolean
}

const RunControlPayloadSchema = z.object({
  issueRepo: z.string().optional(),
  preserveBranchState: z.boolean().optional(),
  updateStrategy: z.enum(['merge', 'rebase']).optional(),
  checkAfter: z.boolean().optional(),
}).passthrough()

export function isImmediateFollowupStatus(status: RunRecord['status']): boolean {
  return status === 'review_ready'
    || status === 'blocked'
    || status === 'error'
    || status === 'completed'
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
): RunControlPayload | null {
  if (!run?.controlPayload) return null
  const parsed = RunControlPayloadSchema.safeParse(run.controlPayload)
  if (!parsed.success) {
    logger.warn(
      { runId: run.id, issues: parsed.error.issues },
      'Ignoring invalid run-control payload',
    )
    return null
  }
  return parsed.data
}

export function selectReplayableRun(run: RunRecord | null): RunRecord | null {
  if (!run) return null
  if (run.status === 'blocked' || run.status === 'error') {
    return run
  }
  return null
}

export const TAINTED_BLOCK_REASONS = new Set([
  'agent_pass_limit',
  'merge_conflict',
  'auth_failure',
  'empty_diff',
])

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

export interface BranchPolicy {
  preserveBranchState: boolean
  resetToBase: boolean
  runMode: RunContext['runMode']
}

export interface DeriveBranchPolicyInput {
  operationIntent: RunRecord['operationIntent']
  controlPayload: RunControlPayload | null
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

  const preserveBranchState = controlPayload?.preserveBranchState === true
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
