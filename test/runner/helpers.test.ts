import { describe, it, expect } from 'vitest'
import {
  buildAttemptHistoryFollowup,
  resolveOperationIntent,
  selectReplayableRun,
} from '../../src/runner/helpers.js'
import type { RunRecord, RunOperationIntent, RunStatus } from '../../src/state/runs.js'

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    repo: 'org/repo',
    issueNumber: 1,
    issueTitle: 'Issue',
    issueNodeId: null,
    status: 'queued',
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
    iterationCount: 1,
    currentPhase: null,
    phaseData: null,
    startedAt: null,
    endedAt: null,
    lastError: null,
    prNumber: null,
    prTitle: null,
    branchName: null,
    branchSlug: null,
    worktreePath: null,
    estimatedCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    blockReason: null,
    operationIntent: 'auto',
    manualState: 'none',
    controlPayload: null,
    parentRunId: null,
    retryCount: 0,
    ...overrides,
  }
}

describe('resolveOperationIntent', () => {
  it('returns explicit intents unchanged', () => {
    const intents: RunOperationIntent[] = ['continue', 'retry', 'rebase', 'refresh']
    for (const intent of intents) {
      expect(resolveOperationIntent(makeRun({ operationIntent: intent }))).toBe(intent)
    }
  })

  it('defaults to auto when run is missing', () => {
    expect(resolveOperationIntent(null)).toBe('auto')
    expect(resolveOperationIntent(undefined)).toBe('auto')
  })

  it('maps queued blocked merge conflicts to retry', () => {
    expect(
      resolveOperationIntent(
        makeRun({ status: 'queued', blockReason: 'merge_conflict' }),
      ),
    ).toBe('retry')
  })

  it('maps queued rebase followups to their refresh/rebase intents', () => {
    expect(
      resolveOperationIntent(
        makeRun({ status: 'queued', phaseData: { reactionType: 'rebase' } }),
      ),
    ).toBe('rebase')
    expect(
      resolveOperationIntent(
        makeRun({ status: 'queued', phaseData: { reactionType: 'merge_conflict' } }),
      ),
    ).toBe('refresh')
    expect(
      resolveOperationIntent(
        makeRun({ status: 'queued', phaseData: { reactionType: 'refresh' } }),
      ),
    ).toBe('refresh')
  })

  it('maps other queued followup reactions to continue', () => {
    expect(
      resolveOperationIntent(
        makeRun({ status: 'queued', phaseData: { reactionType: 'continue' } }),
      ),
    ).toBe('continue')
  })

  it('does not infer followup intent for non-queued runs', () => {
    expect(
      resolveOperationIntent(
        makeRun({ status: 'review_ready', phaseData: { reactionType: 'continue' } }),
      ),
    ).toBe('auto')
  })
})

describe('selectReplayableRun', () => {
  it('returns replayable rows for blocked, review_ready, and error states', () => {
    const replayable: RunStatus[] = ['blocked', 'review_ready', 'error']
    for (const status of replayable) {
      const run = makeRun({ status })
      expect(selectReplayableRun(run)).toBe(run)
    }
  })

  it('returns null for non-replayable states', () => {
    const nonReplayable: RunStatus[] = ['queued', 'running', 'completed']
    for (const status of nonReplayable) {
      expect(selectReplayableRun(makeRun({ status }))).toBeNull()
    }
    expect(selectReplayableRun(null)).toBeNull()
  })
})

describe('buildAttemptHistoryFollowup', () => {
  it('returns null when no prior run exists', () => {
    expect(buildAttemptHistoryFollowup(null)).toBeNull()
    expect(buildAttemptHistoryFollowup(undefined)).toBeNull()
  })

  it('returns null for completed runs', () => {
    expect(buildAttemptHistoryFollowup(makeRun({ status: 'completed' }))).toBeNull()
  })

  it('builds follow-up context for blocked attempts', () => {
    const followup = buildAttemptHistoryFollowup(makeRun({
      id: 'run-prev',
      status: 'blocked',
      blockReason: 'merge_conflict',
      lastError: 'Conflicts in src/app.ts',
      iterationCount: 3,
      prNumber: 88,
    }))

    expect(followup).not.toBeNull()
    expect(followup?.type).toBe('previous_attempt')
    expect(followup?.summary).toContain('run-prev')
    expect(followup?.summary).toContain('blocked')
    expect(followup?.context).toContain('## Previous Run State')
    expect(followup?.context).toContain('Block reason: merge_conflict')
    expect(followup?.context).toContain('Last error: Conflicts in src/app.ts')
    expect(followup?.context).toContain('Iteration count: 3')
    expect(followup?.context).toContain('PR number: #88')
  })
})
