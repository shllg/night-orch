import { describe, expect, it, vi, beforeEach } from 'vitest'
import { runVerifyGate } from '../../src/loop/verify-gate.js'
import type { RunContext, VerifyResult } from '../../src/loop/types.js'
import type { VerifyStep, WorkflowStep } from '../../src/loop/workflow.js'
import type { Checkpoint } from '../../src/loop/checkpoint.js'
import { makeTestConfig } from '../helpers/factories.js'
import { getDiffAgainstBranch } from '../../src/git/repo.js'
import { runVerifyCommands } from '../../src/loop/verifier.js'
import type * as VerifierModule from '../../src/loop/verifier.js'

vi.mock('../../src/git/repo.js', () => ({
  getDiffAgainstBranch: vi.fn(),
}))

vi.mock('../../src/loop/verifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof VerifierModule>()
  return {
    ...actual,
    runVerifyCommands: vi.fn(),
  }
})

const mockGetDiffAgainstBranch = vi.mocked(getDiffAgainstBranch)
const mockRunVerifyCommands = vi.mocked(runVerifyCommands)

describe('runVerifyGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checkpoints verify output and continues to the nearest coder on empty diff', async () => {
    const verifyResult: VerifyResult = {
      command: 'pnpm test',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 25,
      passed: true,
    }
    mockRunVerifyCommands.mockResolvedValue([verifyResult])
    mockGetDiffAgainstBranch.mockResolvedValue({ diff: null, error: null })

    const checkpoint = makeCheckpoint()
    const steps: WorkflowStep[] = [
      { type: 'worker', id: 'plan', role: 'planner' },
      { type: 'worker', id: 'code', role: 'coder' },
      { type: 'verify', id: 'verify' },
      { type: 'worker', id: 'review', role: 'reviewer' },
    ]

    const result = await runVerifyGate({
      ctx: makeCtx(),
      step: { type: 'verify', id: 'verify' },
      stepDeps: { adapters: {}, config: makeConfig() },
      checkpoint,
      steps,
      stepIndex: 2,
      loopConfig: makeConfig().loop,
      startedAtMs: Date.now(),
      startedAtIso: '2026-01-01T00:00:00.000Z',
    })

    expect(result.action).toBe('continue')
    if (result.action === 'continue') {
      expect(result.stepIndex).toBe(1)
    }
    expect(result.ctx.emptyDiffRetries).toBe(1)
    expect(result.ctx.verifyResults).toEqual([])
    expect(checkpoint.phaseCompleted).toHaveBeenCalledWith(
      'run-test-1',
      'verify',
      {
        verifyResults: [{
          ...verifyResult,
          required: true,
          stageId: null,
          onFailure: 'block',
        }],
        diff: null,
        diffError: null,
        emptyDiffRetries: 0,
      },
      1,
      expect.objectContaining({
        runId: 'run-test-1',
        stepId: 'verify',
        fromRole: 'system',
        toRole: 'reviewer',
        kind: 'verify-summary',
        summary: 'Verify: 1/1 passed',
        contentMd: expect.stringContaining('## Verify Summary'),
        contentJson: [{
          ...verifyResult,
          required: true,
          stageId: null,
          onFailure: 'block',
        }],
      }),
    )
    expect(checkpoint.persistRunState).toHaveBeenCalledWith('run-test-1', {}, {})
  })
})

function makeConfig() {
  return makeTestConfig({
    storage: { dbPath: '', worktreeRoot: '', logsRoot: '' },
  })
}

function makeCheckpoint(): Pick<Checkpoint, 'phaseCompleted' | 'persistRunState' | 'phaseBlocked'> {
  return {
    phaseCompleted: vi.fn(),
    persistRunState: vi.fn(),
    phaseBlocked: vi.fn(),
  }
}

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-test-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: {
      number: 1,
      nodeId: 'node-1',
      title: 'Fix bug',
      body: 'Fix it',
      labels: [],
      assignees: [],
      state: 'open',
      createdAt: '',
      updatedAt: '',
      url: '',
    },
    repoConfig: {
      repo: 'org/repo',
      forge: 'github',
      localPath: '/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: {
        ready: ['no:ready'],
        running: 'no:running',
        blocked: ['no:blocked'],
        reviewReady: 'no:review-ready',
        error: 'no:error',
        retry: 'no:retry',
      },
      defaults: {
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
        doneMode: 'pr-ready',
        notifyPriority: 'normal',
        prMentions: [],
      },
      verify: ['pnpm test'],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: { claude: 'claude' },
    } as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: {
      maxReviewIterations: 4,
      maxTotalAgentPasses: 10,
      workerTimeoutSeconds: 1800,
    },
    branchName: 'orch/1-fix-bug',
    worktreePath: '/tmp/worktree',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'verify',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
    diffError: null,
    emptyDiffRetries: 0,
    ...overrides,
  }
}
