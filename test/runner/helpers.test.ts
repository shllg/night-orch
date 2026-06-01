import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  buildAttemptHistoryFollowup,
  deriveBranchPolicy,
  resolveControlPayload,
  resolveOperationIntent,
  selectReplayableRun,
} from '../../src/runner/helpers.js'
import { shouldResetBranch } from '../../src/runner/intent.js'
import { logger } from '../../src/utils/logger.js'
import type { RunRecord, RunOperationIntent, RunStatus } from '../../src/state/runs.js'

const loggerWarn = vi.mocked(logger.warn)

beforeEach(() => {
  vi.clearAllMocks()
})

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
  it('returns replayable rows for blocked and error states', () => {
    const replayable: RunStatus[] = ['blocked', 'error']
    for (const status of replayable) {
      const run = makeRun({ status })
      expect(selectReplayableRun(run)).toBe(run)
    }
  })

  it('returns null for non-replayable states', () => {
    const nonReplayable: RunStatus[] = ['queued', 'running', 'review_ready', 'completed']
    for (const status of nonReplayable) {
      expect(selectReplayableRun(makeRun({ status }))).toBeNull()
    }
    expect(selectReplayableRun(null)).toBeNull()
  })
})

describe('resolveControlPayload', () => {
  it('rejects and logs invalid run-control payload fields', () => {
    expect(
      resolveControlPayload(
        makeRun({ controlPayload: { updateStrategy: 'squash' } }),
      ),
    ).toBeNull()

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
      }),
      'Ignoring invalid run-control payload',
    )
  })
})

describe('deriveBranchPolicy', () => {
  it('maps refresh intent to preserve branch and refresh run mode', () => {
    const policy = deriveBranchPolicy({
      operationIntent: 'refresh',
      controlPayload: null,
      planningMode: false,
      updateStrategyOverride: undefined,
      shouldResetFromHistory: false,
      hasFollowupPromptFeedback: false,
    })

    expect(policy).toEqual({
      preserveBranchState: true,
      resetToBase: false,
      runMode: 'refresh',
    })
  })

  it('maps explicit retry intent to reset from base with fresh mode', () => {
    const policy = deriveBranchPolicy({
      operationIntent: 'retry',
      controlPayload: null,
      planningMode: false,
      updateStrategyOverride: undefined,
      shouldResetFromHistory: false,
      hasFollowupPromptFeedback: false,
    })

    expect(policy).toEqual({
      preserveBranchState: false,
      resetToBase: true,
      runMode: 'fresh',
    })
  })

  it('maps continue intent to followup mode and preserve when no strategy override exists', () => {
    const policy = deriveBranchPolicy({
      operationIntent: 'continue',
      controlPayload: null,
      planningMode: false,
      updateStrategyOverride: undefined,
      shouldResetFromHistory: false,
      hasFollowupPromptFeedback: false,
    })

    expect(policy).toEqual({
      preserveBranchState: true,
      resetToBase: false,
      runMode: 'followup',
    })
  })

  it('respects control payload preserve override and followup feedback in auto mode', () => {
    const policy = deriveBranchPolicy({
      operationIntent: 'auto',
      controlPayload: { preserveBranchState: true },
      planningMode: false,
      updateStrategyOverride: 'rebase',
      shouldResetFromHistory: false,
      hasFollowupPromptFeedback: true,
    })

    expect(policy).toEqual({
      preserveBranchState: true,
      resetToBase: false,
      runMode: 'followup',
    })
  })

  it('resets to base in auto mode when planning mode is enabled', () => {
    const policy = deriveBranchPolicy({
      operationIntent: 'auto',
      controlPayload: null,
      planningMode: true,
      updateStrategyOverride: undefined,
      shouldResetFromHistory: false,
      hasFollowupPromptFeedback: false,
    })

    expect(policy).toEqual({
      preserveBranchState: false,
      resetToBase: true,
      runMode: 'fresh',
    })
  })

  it('resets to base in auto mode when prior run is tainted', () => {
    const policy = deriveBranchPolicy({
      operationIntent: 'auto',
      controlPayload: null,
      planningMode: false,
      updateStrategyOverride: undefined,
      shouldResetFromHistory: true,
      hasFollowupPromptFeedback: false,
    })

    expect(policy).toEqual({
      preserveBranchState: false,
      resetToBase: true,
      runMode: 'fresh',
    })
  })
})

describe('shouldResetBranch', () => {
  it('resets after prior error or tainted blocked result', () => {
    const runManager = {
      getLatestFinishedByIssue(_repo: string, issueNumber: number) {
        if (issueNumber === 1) return makeRun({ status: 'error' })
        if (issueNumber === 2) return makeRun({ status: 'blocked', blockReason: 'merge_conflict' })
        return makeRun({ status: 'blocked', blockReason: 'reviewer_blocked' })
      },
    }

    expect(shouldResetBranch(runManager, 'org/repo', 1, 'run-current')).toBe(true)
    expect(shouldResetBranch(runManager, 'org/repo', 2, 'run-current')).toBe(true)
    expect(shouldResetBranch(runManager, 'org/repo', 3, 'run-current')).toBe(false)
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
