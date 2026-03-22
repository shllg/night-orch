import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeLoop, type LoopDependencies } from '../../src/loop/engine.js'
import type { RunContext } from '../../src/loop/types.js'
import type { Config } from '../../src/config/schema.js'
import type { WorkerAdapter, WorkerTaskResult } from '../../src/workers/types.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

// Mock external deps
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
  buildVerifierEnv: vi.fn().mockReturnValue({ PATH: '/usr/bin' }),
}))

function makePlannerResult(objective = 'Fix it'): WorkerTaskResult {
  return {
    rawOutput: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    parsed: {
      objective,
      assumptions: [],
      filesToChange: ['src/a.ts'],
      steps: [{ order: 1, description: 'Fix', files: ['src/a.ts'] }],
      risks: [],
      testStrategy: 'unit tests',
    },
    parseError: null,
  }
}

function makeCoderResult(): WorkerTaskResult {
  return {
    rawOutput: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 2000,
    parsed: {
      summary: 'Fixed the bug',
      changedFiles: ['src/a.ts'],
      remainingUncertainty: null,
      blockers: null,
    },
    parseError: null,
  }
}

function makeReviewerResult(verdict: 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED' = 'APPROVED'): WorkerTaskResult {
  return {
    rawOutput: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 1500,
    parsed: {
      verdict,
      summary: verdict === 'APPROVED' ? 'Looks good' : 'Needs work',
      findings: verdict === 'CHANGES_REQUIRED'
        ? [{ severity: 'major' as const, message: 'Missing tests', suggestedFix: 'Add tests' }]
        : [],
      definitionOfDoneCheck: {
        issueAddressed: verdict === 'APPROVED',
        testsPassing: true,
        noBlockingFindings: verdict === 'APPROVED',
      },
    },
    parseError: null,
  }
}

function makeMockAdapter(results: WorkerTaskResult[]): WorkerAdapter {
  let callIndex = 0
  return {
    runTask: vi.fn().mockImplementation(() => {
      const result = results[callIndex] ?? results[results.length - 1]!
      callIndex++
      return Promise.resolve(result)
    }),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
  }
}

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

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-test-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: 'Fix bug', body: 'Fix it', labels: ['bug'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {
      repo: 'org/repo',
      forge: 'github',
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: ['pnpm test'],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: { claude: 'claude' },
    } as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-fix-bug',
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
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    ...overrides,
  }
}

describe('executeLoop', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-engine-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))

    // Insert run row
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES ('run-test-1', 'org/repo', 1, 'running')",
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('happy path: plan → code → verify → review APPROVED → completed', async () => {
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter: makeMockAdapter([makePlannerResult()]),
      coderAdapter: makeMockAdapter([makeCoderResult()]),
      reviewerAdapter: makeMockAdapter([makeReviewerResult('APPROVED')]),
    }

    const result = await executeLoop(makeCtx(), deps)

    // recordPhase sets currentPhase to 'publish' (the phase name)
    expect(result.currentPhase).toBe('publish')
    expect(result.terminalStatus).toBe('publish')
    expect(result.plan).not.toBeNull()
    expect(result.plan!.objective).toBe('Fix it')
    // Last phase record should be success
    const lastPhase = result.phaseHistory[result.phaseHistory.length - 1]!
    expect(lastPhase.result).toBe('success')
  })

  it('review bounce: CHANGES_REQUIRED → iterate → APPROVED → completed', async () => {
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter: makeMockAdapter([makePlannerResult()]),
      coderAdapter: makeMockAdapter([makeCoderResult(), makeCoderResult()]),
      reviewerAdapter: makeMockAdapter([makeReviewerResult('CHANGES_REQUIRED'), makeReviewerResult('APPROVED')]),
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.currentPhase).toBe('publish')
    expect(result.terminalStatus).toBe('publish')
    expect(result.iteration).toBe(2) // bounced once
  })

  it('max iterations → blocked', async () => {
    const config = makeConfig()
    const ctx = makeCtx({
      adjustedLimits: { maxReviewIterations: 2, maxTotalAgentPasses: 20, workerTimeoutSeconds: 1800 },
    })

    const deps: LoopDependencies = {
      db,
      config,
      plannerAdapter: makeMockAdapter([makePlannerResult()]),
      coderAdapter: makeMockAdapter([makeCoderResult(), makeCoderResult(), makeCoderResult()]),
      reviewerAdapter: makeMockAdapter([
        makeReviewerResult('CHANGES_REQUIRED'),
        makeReviewerResult('CHANGES_REQUIRED'),
        makeReviewerResult('CHANGES_REQUIRED'),
      ]),
    }

    const result = await executeLoop(ctx, deps)

    // recordPhase sets currentPhase to 'decision' (the phase name for block)
    expect(result.currentPhase).toBe('decision')
    expect(result.terminalStatus).toBe('blocked')
    const lastPhase = result.phaseHistory[result.phaseHistory.length - 1]!
    expect(lastPhase.result).toBe('failure')
  })

  it('planner failure + stopOnPlannerFailure → error', async () => {
    const failedPlannerResult: WorkerTaskResult = {
      rawOutput: 'error',
      exitCode: 1,
      timedOut: false,
      durationMs: 1000,
      parsed: null,
      parseError: 'Parse failed',
    }

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter: makeMockAdapter([failedPlannerResult]),
      coderAdapter: makeMockAdapter([makeCoderResult()]),
      reviewerAdapter: makeMockAdapter([makeReviewerResult()]),
    }

    const result = await executeLoop(makeCtx(), deps)

    // recordPhase sets currentPhase to 'plan' (the phase name for planner failure)
    expect(result.currentPhase).toBe('plan')
    expect(result.terminalStatus).toBe('error')
    const lastPhase = result.phaseHistory[result.phaseHistory.length - 1]!
    expect(lastPhase.result).toBe('failure')
  })

  it('trivial issue skips planning', async () => {
    const ctx = makeCtx({
      triageResult: { level: 'trivial', reason: 'Short bug' },
    })

    const plannerAdapter = makeMockAdapter([makePlannerResult()])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter,
      coderAdapter: makeMockAdapter([makeCoderResult()]),
      reviewerAdapter: makeMockAdapter([makeReviewerResult('APPROVED')]),
    }

    const result = await executeLoop(ctx, deps)

    expect(result.currentPhase).toBe('publish')
    expect(result.terminalStatus).toBe('publish')
    // Planner should NOT have been called
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
  })

  it('BLOCKED verdict → blocked', async () => {
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      plannerAdapter: makeMockAdapter([makePlannerResult()]),
      coderAdapter: makeMockAdapter([makeCoderResult()]),
      reviewerAdapter: makeMockAdapter([makeReviewerResult('BLOCKED')]),
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.currentPhase).toBe('decision')
    expect(result.terminalStatus).toBe('blocked')
    const lastPhase = result.phaseHistory[result.phaseHistory.length - 1]!
    expect(lastPhase.result).toBe('failure')
  })
})
