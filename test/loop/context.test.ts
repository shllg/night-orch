import { describe, it, expect } from 'vitest'
import { updateContext, recordPhase } from '../../src/loop/context.js'
import type { RunContext } from '../../src/loop/types.js'

function makeCtx(): RunContext {
  return {
    runId: 'run-test',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: '', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-test',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'plan',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
  }
}

describe('updateContext', () => {
  it('returns new object with updated fields', () => {
    const original = makeCtx()
    const updated = updateContext(original, { iteration: 2 })
    expect(updated.iteration).toBe(2)
    expect(original.iteration).toBe(1)
  })

  it('preserves unmodified fields', () => {
    const original = makeCtx()
    const updated = updateContext(original, { iteration: 2 })
    expect(updated.runId).toBe(original.runId)
    expect(updated.repo).toBe(original.repo)
  })
})

describe('recordPhase', () => {
  it('adds phase record to history', () => {
    const ctx = makeCtx()
    const updated = recordPhase(ctx, 'plan', 'success', { plan: 'test' })
    expect(updated.phaseHistory).toHaveLength(1)
    expect(updated.phaseHistory[0]?.phase).toBe('plan')
    expect(updated.phaseHistory[0]?.result).toBe('success')
    expect(updated.currentPhase).toBe('plan')
  })

  it('accumulates phases', () => {
    let ctx = makeCtx()
    ctx = recordPhase(ctx, 'plan', 'success')
    ctx = recordPhase(ctx, 'code', 'success')
    expect(ctx.phaseHistory).toHaveLength(2)
  })

  it('uses provided phase start timestamp', () => {
    const ctx = makeCtx()
    const startedAt = '2026-01-01T00:00:00.000Z'
    const updated = recordPhase(ctx, 'plan', 'success', {}, startedAt)
    expect(updated.phaseHistory[0]!.startedAt).toBe(startedAt)
    expect(updated.phaseHistory[0]!.completedAt).not.toBe(startedAt)
  })
})
