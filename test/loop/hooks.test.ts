import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runPostWorkerHooks } from '../../src/loop/hooks.js'
import type { Config } from '../../src/config/schema.js'
import type { RunContext } from '../../src/loop/types.js'
import type { WorkerStep } from '../../src/loop/workflow.js'

vi.mock('../../src/loop/diff-guard.js', () => ({
  checkWorktreeScope: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn() },
}))

import { checkWorktreeScope } from '../../src/loop/diff-guard.js'

const mockCheckWorktreeScope = vi.mocked(checkWorktreeScope)

describe('runPostWorkerHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null for non-coder worker steps', async () => {
    const block = await runPostWorkerHooks(makeCtx(), makeStep({ role: 'planner' }), makeConfig())

    expect(block).toBeNull()
    expect(mockCheckWorktreeScope).not.toHaveBeenCalled()
  })

  it('blocks coder output when the worktree scope guard fails', async () => {
    mockCheckWorktreeScope.mockResolvedValue({
      ok: false,
      reason: 'Too many changed files: 51 > 50',
      stats: { changedFiles: 51, insertions: 10, deletions: 0, totalChangedLines: 10 },
    })

    const block = await runPostWorkerHooks(makeCtx(), makeStep({ role: 'coder' }), makeConfig())

    expect(block).toEqual({
      blockReason: 'verify_config',
      blockMessage: 'Scope guard: Too many changed files: 51 > 50',
    })
    expect(mockCheckWorktreeScope).toHaveBeenCalledWith('/tmp/wt', {
      maxChangedFiles: 50,
      maxChangedLines: 5000,
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
    })
  })
})

function makeCtx(): RunContext {
  return {
    runId: 'run-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: 'Issue', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'codex', reviewer: 'codex' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-issue',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResults: {},
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 1,
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
    stepOutputs: {},
    iterationSnapshots: [],
  }
}

function makeStep(overrides: Partial<WorkerStep> = {}): WorkerStep {
  return {
    type: 'worker',
    id: 'code',
    role: 'coder',
    ...overrides,
  }
}

function makeConfig(): Config {
  return {
    security: {
      maxChangedFiles: 50,
      maxChangedLines: 5000,
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
    },
  } as Config
}
