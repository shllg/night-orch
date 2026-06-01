import { describe, expect, it, vi } from 'vitest'
import { blockExit } from '../../src/loop/block-exit.js'
import type { Checkpoint } from '../../src/loop/checkpoint.js'
import type { RunContext } from '../../src/loop/types.js'

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-1',
    repo: 'org/repo',
    issueNumber: 42,
    issue: {
      number: 42,
      nodeId: 'issue-node',
      repo: 'org/repo',
      title: 'Fix AFK path',
      body: '',
      labels: [],
      assignees: [],
      state: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://example.com/org/repo/issues/42',
    },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/42-fix-afk-path',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 3,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'code',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    diffError: null,
    emptyDiffRetries: 0,
    sessionIds: {},
    stepOutputs: { prior: 'kept' },
    iterationSnapshots: [],
    ...overrides,
  }
}

describe('blockExit', () => {
  it('records a blocked checkpoint and returns a new blocked context with the block message', () => {
    const checkpoint = {
      phaseBlocked: vi.fn(),
    } as unknown as Checkpoint
    const ctx = makeCtx()

    const next = blockExit(
      ctx,
      checkpoint,
      'budget_guard',
      'run_token_limit',
      'Run token budget exceeded',
      '2026-01-01T00:00:00.000Z',
    )

    expect(checkpoint.phaseBlocked).toHaveBeenCalledWith(
      'run-1',
      'budget_guard',
      'Run token budget exceeded',
      3,
    )
    expect(next).not.toBe(ctx)
    expect(ctx.terminalStatus).toBe('running')
    expect(ctx.stepOutputs).toEqual({ prior: 'kept' })
    expect(next.currentPhase).toBe('budget_guard')
    expect(next.terminalStatus).toBe('blocked')
    expect(next.blockReason).toBe('run_token_limit')
    expect(next.stepOutputs).toEqual({
      prior: 'kept',
      blockMessage: 'Run token budget exceeded',
    })
    expect(next.phaseHistory.at(-1)).toMatchObject({
      phase: 'budget_guard',
      startedAt: '2026-01-01T00:00:00.000Z',
      result: 'failure',
      artifacts: {},
    })
  })
})
