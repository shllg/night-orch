import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeLoop, type LoopDependencies } from '../../src/loop/engine.js'
import { Checkpoint } from '../../src/loop/checkpoint.js'
import type { RunContext } from '../../src/loop/types.js'
import type { Config } from '../../src/config/schema.js'
import type { WorkerAdapter, WorkerTaskResult } from '../../src/workers/types.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

// Mock execa (for verifier/commit)
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../src/workers/env.js', () => ({
  buildWorkerEnv: vi.fn().mockReturnValue({ PATH: '/usr/bin' }),
}))

function makeConfig(): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '', logsRoot: '' },
    notifications: { channels: [{ type: 'console' }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onError: true, onRetryExhausted: true } },
    loop: {
      maxReviewIterations: 4,
      maxTotalAgentPasses: 10,
      stopOnPlannerFailure: true,
      requireVerificationPass: true,
      reviewApprovalKeyword: 'APPROVED',
      reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
      blockOnAmbiguousReview: true,
    },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {
      claude: { type: 'claude', command: 'claude', args: ['-p'], workerTimeoutSeconds: 1800, minimalEnv: true, runtimeWrapper: null, env: {} },
    },
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [],
  } as Config
}

function makeCtx(): RunContext {
  return {
    runId: 'run-integration-1',
    repo: 'org/repo',
    issueNumber: 42,
    issue: { number: 42, nodeId: '', title: 'Integration test issue', body: 'Test the full loop', labels: ['bug'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {
      repo: 'org/repo',
      forge: 'github',
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: [],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: { claude: 'claude' },
    } as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/42-integration-test',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'plan',
    phaseHistory: [],
    dryRun: false,
  }
}

function makeWorkerResult(parsed: unknown): WorkerTaskResult {
  return {
    rawOutput: JSON.stringify(parsed),
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    parsed: parsed as WorkerTaskResult['parsed'],
    parseError: null,
  }
}

describe('Full loop integration', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-full-loop-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))

    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES ('run-integration-1', 'org/repo', 42, 'running')",
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full loop with mock workers returns completed context', async () => {
    const planResult = makeWorkerResult({
      objective: 'Fix the integration test issue',
      assumptions: ['Tests exist'],
      filesToChange: ['src/a.ts'],
      steps: [{ order: 1, description: 'Fix', files: ['src/a.ts'] }],
      risks: [],
      testStrategy: 'run tests',
    })
    const codeResult = makeWorkerResult({
      summary: 'Fixed it',
      changedFiles: ['src/a.ts'],
      remainingUncertainty: null,
      blockers: null,
    })
    const reviewResult = makeWorkerResult({
      verdict: 'APPROVED',
      summary: 'Looks good',
      findings: [],
      definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
    })

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter: { runTask: vi.fn().mockResolvedValue(planResult), checkAvailability: vi.fn() },
      coderAdapter: { runTask: vi.fn().mockResolvedValue(codeResult), checkAvailability: vi.fn() },
      reviewerAdapter: { runTask: vi.fn().mockResolvedValue(reviewResult), checkAvailability: vi.fn() },
    }

    const result = await executeLoop(makeCtx(), deps)

    // recordPhase sets currentPhase to 'publish' (the phase name)
    expect(result.currentPhase).toBe('publish')
    expect(result.plan).not.toBeNull()
    expect(result.codeResult).not.toBeNull()
    expect(result.reviewResult).not.toBeNull()

    // Last phase record should be success
    const lastPhase = result.phaseHistory[result.phaseHistory.length - 1]!
    expect(lastPhase.result).toBe('success')

    // All three adapters should have been called
    expect(deps.plannerAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(deps.coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(deps.reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('checkpoint data persists across simulated crash', async () => {
    const planResult = makeWorkerResult({
      objective: 'Crash recovery test',
      assumptions: [],
      filesToChange: [],
      steps: [],
      risks: [],
      testStrategy: '',
    })
    const codeResult = makeWorkerResult({
      summary: 'Done',
      changedFiles: [],
      remainingUncertainty: null,
      blockers: null,
    })
    const reviewResult = makeWorkerResult({
      verdict: 'APPROVED',
      summary: 'OK',
      findings: [],
      definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
    })

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter: { runTask: vi.fn().mockResolvedValue(planResult), checkAvailability: vi.fn() },
      coderAdapter: { runTask: vi.fn().mockResolvedValue(codeResult), checkAvailability: vi.fn() },
      reviewerAdapter: { runTask: vi.fn().mockResolvedValue(reviewResult), checkAvailability: vi.fn() },
    }

    // Run the full loop
    await executeLoop(makeCtx(), deps)

    // Simulate crash recovery — checkpoint should have data
    const checkpoint = new Checkpoint(db)
    const last = checkpoint.getLastCompleted('run-integration-1')
    expect(last).not.toBeNull()

    // resumeFromCheckpoint should reconstruct context
    const baseCtx = makeCtx()
    const resumed = checkpoint.resumeFromCheckpoint('run-integration-1', baseCtx)
    expect(resumed).not.toBeNull()
    expect(resumed!.plan).not.toBeNull()
  })

  it('context accumulates across phases', async () => {
    const planResult = makeWorkerResult({
      objective: 'Accumulation test',
      assumptions: ['A'],
      filesToChange: ['f.ts'],
      steps: [],
      risks: [],
      testStrategy: 't',
    })
    const codeResult = makeWorkerResult({
      summary: 'Coded',
      changedFiles: ['f.ts'],
      remainingUncertainty: null,
      blockers: null,
    })
    const reviewResult = makeWorkerResult({
      verdict: 'APPROVED',
      summary: 'Good',
      findings: [],
      definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
    })

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter: { runTask: vi.fn().mockResolvedValue(planResult), checkAvailability: vi.fn() },
      coderAdapter: { runTask: vi.fn().mockResolvedValue(codeResult), checkAvailability: vi.fn() },
      reviewerAdapter: { runTask: vi.fn().mockResolvedValue(reviewResult), checkAvailability: vi.fn() },
    }

    const result = await executeLoop(makeCtx(), deps)

    // Context should have accumulated all phase outputs
    expect(result.plan!.objective).toBe('Accumulation test')
    expect(result.codeResult!.summary).toBe('Coded')
    expect(result.reviewResult!.verdict).toBe('APPROVED')

    // Agent passes should be tracked
    expect(result.totalAgentPasses).toBe(3) // planner + coder + reviewer
  })
})
