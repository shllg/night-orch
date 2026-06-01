import { describe, expect, it, vi } from 'vitest'
import { handlePostVerifyGuard } from '../../src/loop/post-verify-guard.js'
import type { Checkpoint } from '../../src/loop/checkpoint.js'
import type { RunContext } from '../../src/loop/types.js'
import type { WorkflowStep } from '../../src/loop/workflow.js'
import { makeTestConfig } from '../helpers/factories.js'

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
    diff: 'diff --git a/file.ts b/file.ts\n+change',
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 2,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'verify',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    diffError: null,
    emptyDiffRetries: 0,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
    ...overrides,
  }
}

const steps: WorkflowStep[] = [
  { type: 'worker', id: 'code', role: 'coder' },
  { type: 'verify', id: 'verify' },
  { type: 'worker', id: 'review', role: 'reviewer' },
]

function makeCheckpoint(): Checkpoint {
  return {
    phaseBlocked: vi.fn(),
  } as unknown as Checkpoint
}

describe('handlePostVerifyGuard', () => {
  it('returns an error context when git diff failed', () => {
    const checkpoint = makeCheckpoint()

    const result = handlePostVerifyGuard({
      ctx: makeCtx({ diffError: 'fatal: bad revision' }),
      checkpoint,
      steps,
      stepIndex: 1,
      loopConfig: makeTestConfig().loop,
    })

    expect(result.action).toBe('return')
    expect(checkpoint.phaseBlocked).toHaveBeenCalledWith(
      'run-1',
      'empty_diff_guard',
      'Git diff failed: fatal: bad revision',
      2,
    )
    expect(result.ctx.terminalStatus).toBe('error')
    expect(result.ctx.currentPhase).toBe('empty_diff_guard')
    expect(result.ctx.stepOutputs['blockMessage']).toBe('Git diff failed: fatal: bad revision')
    expect(result.ctx.phaseHistory.at(-1)).toMatchObject({
      phase: 'empty_diff_guard',
      result: 'failure',
    })
  })

  it('blocks when empty-diff retries are exhausted', () => {
    const checkpoint = makeCheckpoint()

    const result = handlePostVerifyGuard({
      ctx: makeCtx({ diff: null, emptyDiffRetries: 2 }),
      checkpoint,
      steps,
      stepIndex: 1,
      loopConfig: makeTestConfig().loop,
    })

    expect(result.action).toBe('return')
    expect(result.ctx.terminalStatus).toBe('blocked')
    expect(result.ctx.blockReason).toBe('empty_diff')
    expect(result.ctx.stepOutputs['blockMessage']).toBe('Coder produced no file changes after 3 attempt(s).')
    expect(checkpoint.phaseBlocked).toHaveBeenCalledWith(
      'run-1',
      'empty_diff_guard',
      'Coder produced no file changes after 3 attempt(s).',
      2,
    )
  })

  it('rewinds to the nearest prior coder step when an empty diff can be retried', () => {
    const metrics = { incLoopIterations: vi.fn() }

    const result = handlePostVerifyGuard({
      ctx: makeCtx({
        diff: null,
        verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 10, passed: true }],
        reviewResult: {
          verdict: 'APPROVED',
          summary: 'ok',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      }),
      checkpoint: makeCheckpoint(),
      steps,
      stepIndex: 1,
      loopConfig: makeTestConfig().loop,
      metrics: metrics as never,
    })

    expect(result.action).toBe('continue')
    expect(result.stepIndex).toBe(0)
    expect(result.ctx.emptyDiffRetries).toBe(1)
    expect(result.ctx.verifyResults).toEqual([])
    expect(result.ctx.reviewResult).toBeNull()
    expect(result.ctx.diff).toBeNull()
    expect(result.ctx.diffError).toBeNull()
    expect(metrics.incLoopIterations).toHaveBeenCalledWith('org/repo')
  })

  it('resets the empty-diff retry counter once a real diff exists', () => {
    const result = handlePostVerifyGuard({
      ctx: makeCtx({ emptyDiffRetries: 1 }),
      checkpoint: makeCheckpoint(),
      steps,
      stepIndex: 1,
      loopConfig: makeTestConfig().loop,
    })

    expect(result.action).toBe('next')
    expect(result.ctx.emptyDiffRetries).toBe(0)
  })
})
