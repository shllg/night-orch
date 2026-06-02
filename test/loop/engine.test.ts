import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeLoop, type LoopDependencies } from '../../src/loop/engine.js'
import { DEFAULT_WORKFLOW } from '../../src/loop/workflow.js'
import type { RunContext } from '../../src/loop/types.js'
import type { Config } from '../../src/config/schema.js'
import type { WorkerAdapter, WorkerTaskResult } from '../../src/workers/types.js'
import { WorkerAuthError } from '../../src/workers/errors.js'
import { hashVerifyResults } from '../../src/loop/progress.js'
import { createMetricsService } from '../../src/metrics/service.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { makeTestConfig } from '../helpers/factories.js'

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

vi.mock('../../src/git/repo.js', () => ({
  getDiffAgainstBranch: vi.fn().mockResolvedValue({
    diff: 'diff --git a/file.ts b/file.ts\n+added',
    error: null,
  }),
  getChangedFilesAgainstBranch: vi.fn().mockResolvedValue(['src/a.ts']),
}))

vi.mock('../../src/loop/hooks.js', () => ({
  runPostWorkerHooks: vi.fn().mockResolvedValue(null),
}))

import { logger } from '../../src/utils/logger.js'
import { getDiffAgainstBranch } from '../../src/git/repo.js'
import { runPostWorkerHooks } from '../../src/loop/hooks.js'

// All worker fixtures include a non-empty tokenUsage so the post-R4a
// step-executor accepts them. Tests that explicitly want to exercise
// the missing-token-usage path construct their own result inline.
const FIXTURE_TOKEN_USAGE = {
  promptTokens: 100,
  completionTokens: 50,
  cacheReadTokens: 0,
}

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
    sessionId: null,
    tokenUsage: FIXTURE_TOKEN_USAGE,
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
    sessionId: null,
    tokenUsage: FIXTURE_TOKEN_USAGE,
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
    sessionId: null,
    tokenUsage: FIXTURE_TOKEN_USAGE,
  }
}

function makeReviewerResultWithFinding(
  summary: string,
  message: string,
  suggestedFix: string | null = null,
): WorkerTaskResult {
  const result = makeReviewerResult('CHANGES_REQUIRED')
  return {
    ...result,
    parsed: {
      ...(result.parsed as NonNullable<WorkerTaskResult['parsed']>),
      summary,
      findings: [{ severity: 'major' as const, message, suggestedFix }],
      definitionOfDoneCheck: {
        issueAddressed: false,
        testsPassing: true,
        noBlockingFindings: false,
      },
    },
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
  return makeTestConfig({
    storage: { dbPath: '', worktreeRoot: '', logsRoot: '' },
    loop: {
      maxAttemptChainLength: 3,
      maxRunTokens: 0,
      maxIssueTokens: 0,
      maxDailyTokens: 0,
      maxRunWallClockMinutes: 0,
      maxEmptyDiffRetries: 2,
      maxConsecutiveBlocks: 4,
    },
    workerProfiles: {
      claude: {
        type: 'claude',
        command: 'claude',
        args: ['-p'],
        workerTimeoutSeconds: 1800,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
      },
    },
  })
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
      labels: { ready: ['no:ready'], running: 'no:running', blocked: ['no:blocked'], reviewReady: 'no:review-ready', error: 'no:error', retry: 'no:retry' },
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
    runMode: 'fresh' as const,
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

describe('executeLoop', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runPostWorkerHooks).mockResolvedValue(null)
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
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
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

  it('does not execute post-publish worker steps during the normal loop', async () => {
    const config = makeConfig()
    config.loop.requireVerificationPass = false
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])
    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: reviewerAdapter,
      },
      workflow: {
        steps: [
          { type: 'worker', id: 'code', role: 'coder' },
          { type: 'worker', id: 'cr', role: 'reviewer', runWhen: 'post-publish' },
          { type: 'decide', id: 'decide', onIterate: 'code', requireReview: false },
        ],
      },
    }

    const result = await executeLoop(makeCtx({ currentPhase: 'code' }), deps)

    expect(reviewerAdapter.runTask).not.toHaveBeenCalled()
    expect(result.terminalStatus).toBe('publish')
  })

  it('calls onPlanReady after plan and before code', async () => {
    const callOrder: string[] = []
    const onPlanReady = vi.fn().mockImplementation(async () => {
      callOrder.push('onPlanReady')
    })
    const plannerAdapter: WorkerAdapter = {
      runTask: vi.fn().mockImplementation(async () => {
        callOrder.push('planner')
        return makePlannerResult()
      }),
      checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
    }
    const coderAdapter: WorkerAdapter = {
      runTask: vi.fn().mockImplementation(async () => {
        callOrder.push('coder')
        return makeCoderResult()
      }),
      checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
    }
    const reviewerAdapter: WorkerAdapter = {
      runTask: vi.fn().mockImplementation(async () => {
        callOrder.push('reviewer')
        return makeReviewerResult('APPROVED')
      }),
      checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
    }

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
      onPlanReady,
    }

    await executeLoop(makeCtx(), deps)

    expect(onPlanReady).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['planner', 'onPlanReady', 'coder', 'reviewer'])
  })

  it('continues when onPlanReady fails', async () => {
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
      onPlanReady: vi.fn().mockRejectedValue(new Error('comment failed')),
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-test-1', repo: 'org/repo', issueNumber: 1 }),
      'Failed to post plan summary',
    )
  })

  it('review bounce: CHANGES_REQUIRED → iterate → APPROVED → completed', async () => {
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult(), makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('CHANGES_REQUIRED'), makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.currentPhase).toBe('publish')
    expect(result.terminalStatus).toBe('publish')
    expect(result.iteration).toBe(2) // bounced once
    expect(result.totalAgentPasses).toBe(5)

    const row = db.prepare('SELECT iteration_count FROM runs WHERE id = ?').get('run-test-1') as { iteration_count: number | null }
    expect(row.iteration_count).toBe(2)
  })

  it('two reviewer steps both contribute unique sourced findings to the next coder attempt', async () => {
    const coderAdapter = makeMockAdapter([makeCoderResult(), makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([
      makeReviewerResultWithFinding('Reviewer found missing tests', 'Add unit coverage', 'Add a unit test'),
      makeReviewerResultWithFinding('Code review found unsafe parsing', 'Harden parser input', 'Validate input first'),
      makeReviewerResult('APPROVED'),
      makeReviewerResult('APPROVED'),
    ])
    const workflow = {
      steps: [
        { type: 'worker' as const, id: 'plan', role: 'planner', skipWhen: 'trivial' },
        { type: 'worker' as const, id: 'code', role: 'coder', continueFrom: 'plan' },
        { type: 'verify' as const, id: 'verify' },
        { type: 'worker' as const, id: 'review', role: 'reviewer' },
        { type: 'worker' as const, id: 'cr', role: 'reviewer' },
        { type: 'decide' as const, id: 'decide', onIterate: 'code' },
      ],
    }

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(2)

    const retryPrompt = vi.mocked(coderAdapter.runTask).mock.calls[1]?.[0].prompt ?? ''
    expect(retryPrompt).toContain('review')
    expect(retryPrompt).toContain('cr')
    expect(retryPrompt.match(/Add unit coverage/g)).toHaveLength(1)
    expect(retryPrompt.match(/Harden parser input/g)).toHaveLength(1)
  })

  it('max iterations → blocked', async () => {
    const config = makeConfig()
    const ctx = makeCtx({
      adjustedLimits: { maxReviewIterations: 2, maxTotalAgentPasses: 20, workerTimeoutSeconds: 1800 },
    })

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult(), makeCoderResult(), makeCoderResult()]),
        reviewer: makeMockAdapter([
          makeReviewerResult('CHANGES_REQUIRED'),
          makeReviewerResult('CHANGES_REQUIRED'),
          makeReviewerResult('CHANGES_REQUIRED'),
        ]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(ctx, deps)

    // recordPhase sets currentPhase to 'decision' (the phase name for block)
    expect(result.currentPhase).toBe('decision')
    expect(result.terminalStatus).toBe('blocked')
    const lastPhase = result.phaseHistory[result.phaseHistory.length - 1]!
    expect(lastPhase.result).toBe('failure')
  })

  it('stuck verify loop → blocked with stuck_loop reason', async () => {
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('CHANGES_REQUIRED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const previousVerifyHash = hashVerifyResults([
      {
        command: 'pnpm test',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 100,
        passed: true,
      },
    ])

    const result = await executeLoop(
      makeCtx({
        iterationSnapshots: [{ iteration: 1, verifyHash: previousVerifyHash }],
      }),
      deps,
    )

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('stuck_loop')
    expect(String(result.stepOutputs['blockMessage'])).toMatch(/^Loop stuck:/)
  })

  it('non-zero worker exit bubbles as transient error for poller auto-retry', async () => {
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
      adapters: {
        planner: makeMockAdapter([failedPlannerResult]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult()]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    // Post-R2: non-auth, non-timeout exits surface as WorkerTransientError
    // and bubble out of executeLoop so the poller's infra-retry path can
    // take over.
    await expect(executeLoop(makeCtx(), deps)).rejects.toMatchObject({
      code: 'WORKER_TRANSIENT_FAILURE',
    })
  })

  it('worker timeout produces a typed blocked state instead of bubbling', async () => {
    const timedOutPlannerResult: WorkerTaskResult = {
      rawOutput: '',
      exitCode: 0,
      timedOut: true,
      durationMs: 1000,
      parsed: null,
      parseError: 'timeout',
    }

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([timedOutPlannerResult]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult()]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    // Post-R2: worker timeouts are NOT transient — retrying the same
    // worker with the same input is almost guaranteed to time out
    // again. The engine catches the typed WorkerTimeoutError, converts
    // it to a blocked state with reason=workerTimeout (which round-trips
    // through the legacy column as 'auth_failure' for now — see
    // blockedReasonToLegacy doc).
    const result = await executeLoop(makeCtx(), deps)
    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('auth_failure')
    expect((result.stepOutputs?.['blockMessage'] ?? '') as string).toMatch(/timed out/)
  })

  it('reports the actual adapter on auth failures from custom worker profiles', async () => {
    const customAuthAdapter: WorkerAdapter = {
      runTask: vi.fn().mockRejectedValue(
        new WorkerAuthError('gemini', 'Sign in to gemini', 'missing credentials', 'plan'),
      ),
      checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
    }

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: customAuthAdapter,
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult()]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('auth_failure')
    expect((result.stepOutputs?.['blockMessage'] ?? '') as string).toContain('gemini')
    expect((result.stepOutputs?.['blockMessage'] ?? '') as string).not.toContain('claude')
  })

  it('trivial issue skips planning', async () => {
    const ctx = makeCtx({
      triageResult: { level: 'trivial', reason: 'Short bug' },
    })

    const plannerAdapter = makeMockAdapter([makePlannerResult()])

    const onPlanReady = vi.fn()

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
      onPlanReady,
    }

    const result = await executeLoop(ctx, deps)

    expect(result.currentPhase).toBe('publish')
    expect(result.terminalStatus).toBe('publish')
    // Planner should NOT have been called
    expect(deps.adapters['planner']!.runTask).not.toHaveBeenCalled()
    expect(onPlanReady).not.toHaveBeenCalled()
  })

  it('uses token-based cost when available', async () => {
    const plannerResult = {
      ...makePlannerResult(),
      tokenUsage: { promptTokens: 1000, completionTokens: 500 },
    }
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([plannerResult]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.estimatedCostUsd).toBeGreaterThan(0)
    expect(result.terminalStatus).toBe('publish')
  })

  it('records estimated cost metric with workerType labels', async () => {
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const addEstimatedCostSpy = vi.spyOn(metrics, 'addEstimatedCost')

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
      metrics,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(addEstimatedCostSpy).toHaveBeenCalledWith('org/repo', 'claude', expect.any(Number))
  })

  it('records estimated cost metric with unknown label when workerType is missing', async () => {
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const addEstimatedCostSpy = vi.spyOn(metrics, 'addEstimatedCost')

    const config = makeConfig()
    const defaultProfile = config.workerProfiles['claude'] as unknown as { type?: string }
    defaultProfile.type = undefined

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
      metrics,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(addEstimatedCostSpy).toHaveBeenCalledWith('org/repo', 'unknown', expect.any(Number))
  })

  it('subscription model bypasses over-budget checks in executeLoop', async () => {
    db.prepare('UPDATE runs SET estimated_cost_usd = ? WHERE id = ?').run(250, 'run-test-1')
    const today = new Date().toISOString().split('T')[0]
    db.prepare(
      `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
       VALUES (?, ?, 0, 0, 0)
       ON CONFLICT(date) DO UPDATE SET total_cost_usd = excluded.total_cost_usd`,
    ).run(today, 1000)

    const config = makeConfig()
    config.cost = { model: 'subscription' }

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(
      makeCtx({
        estimatedCostUsd: 250,
        verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
      }),
      deps,
    )

    expect(result.terminalStatus).toBe('publish')
    expect(result.blockReason).toBeNull()
    expect(result.estimatedCostUsd).toBe(250)
  })

  it('blocks before worker execution when run token budget is already exhausted', async () => {
    db.prepare(
      'UPDATE runs SET prompt_tokens = ?, completion_tokens = ?, cache_read_tokens = ? WHERE id = ?',
    ).run(80, 30, 0, 'run-test-1')

    const config = makeConfig()
    config.loop.maxRunTokens = 100
    const plannerAdapter = makeMockAdapter([makePlannerResult()])

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: plannerAdapter,
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('run_token_limit')
    expect(result.stepOutputs['blockMessage']).toBe('Run token budget exceeded (110 >= 100 tokens)')
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
  })

  it('blocks when cumulative issue token budget is exhausted across attempts', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, terminated_at) VALUES ('run-prev', 'org/repo', 1, 'blocked', ?)",
    ).run(new Date().toISOString())
    db.prepare(
      'UPDATE runs SET prompt_tokens = ?, completion_tokens = ?, cache_read_tokens = ? WHERE id = ?',
    ).run(70, 40, 0, 'run-prev')

    const config = makeConfig()
    config.loop.maxIssueTokens = 100
    const plannerAdapter = makeMockAdapter([makePlannerResult()])

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: plannerAdapter,
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('issue_token_limit')
    expect(result.stepOutputs['blockMessage']).toBe('Issue token budget exceeded (110 >= 100 tokens)')
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
  })

  it('blocks when daily token budget is exhausted', async () => {
    const today = new Date().toISOString().split('T')[0]!
    db.prepare(
      `INSERT INTO daily_costs (
         date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens
       )
       VALUES (?, 0, 0, 80, 30, 0)
       ON CONFLICT(date) DO UPDATE SET
         total_prompt_tokens = excluded.total_prompt_tokens,
         total_completion_tokens = excluded.total_completion_tokens,
         total_cache_read_tokens = excluded.total_cache_read_tokens`,
    ).run(today)

    const config = makeConfig()
    config.loop.maxDailyTokens = 100
    const plannerAdapter = makeMockAdapter([makePlannerResult()])

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: plannerAdapter,
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('daily_token_limit')
    expect(result.stepOutputs['blockMessage']).toBe('Daily token budget exceeded (110 >= 100 tokens)')
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
  })

  it('blocks when run wall-clock budget is exceeded', async () => {
    const startedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(startedAt, 'run-test-1')

    const config = makeConfig()
    config.loop.maxRunWallClockMinutes = 60
    const plannerAdapter = makeMockAdapter([makePlannerResult()])

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: plannerAdapter,
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('run_wall_clock_limit')
    expect(String(result.stepOutputs['blockMessage'])).toMatch(
      /^Run wall-clock budget exceeded \(\d+\.\d >= 60 minutes\)$/,
    )
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
  })

  it('blocks immediately after a worker step crosses run token budget', async () => {
    const config = makeConfig()
    config.loop.maxRunTokens = 120
    const plannerAdapter = makeMockAdapter([makePlannerResult()])
    const coderAdapter = makeMockAdapter([makeCoderResult()])

    const deps: LoopDependencies = {
      db,
      config,
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('run_token_limit')
    expect(result.stepOutputs['blockMessage']).toBe('Run token budget exceeded (150 >= 120 tokens)')
    expect(plannerAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(coderAdapter.runTask).not.toHaveBeenCalled()
  })

  it('BLOCKED verdict → blocked', async () => {
    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([makeReviewerResult('BLOCKED')]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.currentPhase).toBe('decision')
    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('reviewer_blocked')
    expect(result.stepOutputs['blockMessage']).toBe('Reviewer blocked: Needs work')
    const lastPhase = result.phaseHistory[result.phaseHistory.length - 1]!
    expect(lastPhase.result).toBe('failure')
  })

  it('ambiguous review parse failure carries block message and reason', async () => {
    const parseFailedReviewerResult: WorkerTaskResult = {
      rawOutput: 'unparseable',
      exitCode: 0,
      timedOut: false,
      durationMs: 1500,
      parsed: null,
      parseError: 'invalid reviewer output',
      sessionId: null,
      tokenUsage: FIXTURE_TOKEN_USAGE,
    }

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: makeMockAdapter([makePlannerResult()]),
        coder: makeMockAdapter([makeCoderResult()]),
        reviewer: makeMockAdapter([parseFailedReviewerResult]),
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBe('ambiguous_review')
    expect(result.stepOutputs['blockMessage']).toBe('Review output not parseable and blockOnAmbiguousReview is true')
  })

  it('re-runs plan when checkpoint only recorded phase start', async () => {
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'plan',
      JSON.stringify({}),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Recovered plan')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(plannerAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('re-runs plan when planner checkpoint artifact is null', async () => {
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'plan',
      JSON.stringify({
        plan: { plan: null },
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Recovered plan')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(plannerAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('re-runs code when checkpoint has plan completion but code only started', async () => {
    const persistedPlan = makePlannerResult('Persisted plan').parsed
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'code',
      JSON.stringify({
        plan: { plan: persistedPlan },
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Should not run')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('re-runs code when coder checkpoint artifact is null', async () => {
    const persistedPlan = makePlannerResult('Persisted plan').parsed
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'code',
      JSON.stringify({
        plan: { plan: persistedPlan },
        code: { codeResult: null },
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Should not run')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('restores verify results when resuming completed verify checkpoints', async () => {
    const persistedPlan = makePlannerResult('Persisted plan').parsed
    const persistedCode = makeCoderResult().parsed
    const persistedVerifyResults = [{
      command: 'pnpm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1250,
      passed: true,
    }]
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'verify',
      JSON.stringify({
        plan: { plan: persistedPlan },
        code: { codeResult: persistedCode },
        verify: { verifyResults: persistedVerifyResults },
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Should not run')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(result.blockReason).toBeNull()
    expect(result.verifyResults).toEqual(persistedVerifyResults)
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
    expect(coderAdapter.runTask).not.toHaveBeenCalled()
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('resumes from checkpoint and skips completed phases', async () => {
    const persistedPlan = makePlannerResult('Persisted plan').parsed
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'plan',
      JSON.stringify({
        plan: { plan: persistedPlan },
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Should not run')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(result.plan).toEqual(persistedPlan)
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('does not use corrupt phase_data artifacts to skip resume steps', async () => {
    const persistedPlan = makePlannerResult('Corrupt persisted plan').parsed
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'plan',
      JSON.stringify({
        plan: { plan: persistedPlan },
        __completedPhases: 'plan',
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Fresh plan')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    const quarantine = db
      .prepare('SELECT COUNT(*) AS c FROM checkpoint_quarantine WHERE run_id = ?')
      .get('run-test-1') as { c: number }
    expect(quarantine.c).toBeGreaterThan(0)
    expect(plannerAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(result.plan?.objective).toBe('Fresh plan')
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('resumes decide checkpoints at iterate target instead of restarting', async () => {
    const persistedPlan = makePlannerResult('Persisted plan').parsed
    const persistedCode = makeCoderResult().parsed
    const persistedReview = makeReviewerResult('CHANGES_REQUIRED').parsed
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'decide',
      JSON.stringify({
        plan: { plan: persistedPlan },
        code: { codeResult: persistedCode },
        review: { reviewResult: persistedReview },
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Should not run')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('publish')
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
    expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
  })

  it('coerces invalid persisted blockReason to null when replaying terminal decide outcomes', async () => {
    db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
      'decide',
      JSON.stringify({
        __decisionOutcomes: {
          decide: {
            action: 'block',
            reason: 'manual block replay',
            blockReason: 'invalid_legacy_reason',
          },
        },
      }),
      'run-test-1',
    )

    const plannerAdapter = makeMockAdapter([makePlannerResult('Should not run')])
    const coderAdapter = makeMockAdapter([makeCoderResult()])
    const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

    const deps: LoopDependencies = {
      db,
      config: makeConfig(),
      adapters: {
        planner: plannerAdapter,
        coder: coderAdapter,
        reviewer: reviewerAdapter,
      },
      workflow: DEFAULT_WORKFLOW,
    }

    const result = await executeLoop(makeCtx(), deps)

    expect(result.terminalStatus).toBe('blocked')
    expect(result.blockReason).toBeNull()
    expect(result.stepOutputs['blockMessage']).toBe('manual block replay')
    expect(plannerAdapter.runTask).not.toHaveBeenCalled()
    expect(coderAdapter.runTask).not.toHaveBeenCalled()
    expect(reviewerAdapter.runTask).not.toHaveBeenCalled()
  })

  describe('empty-diff guard', () => {
    it('auto-retries coder when diff is empty, then succeeds on second attempt', async () => {
      const mockGetDiff = vi.mocked(getDiffAgainstBranch)
      // First verify: empty diff → triggers retry
      // Second verify: real diff → proceeds to reviewer
      mockGetDiff
        .mockResolvedValueOnce({ diff: '', error: null })
        .mockResolvedValueOnce({ diff: 'diff --git a/file.ts b/file.ts\n+added', error: null })

      const coderAdapter = makeMockAdapter([makeCoderResult(), makeCoderResult()])
      const reviewerAdapter = makeMockAdapter([makeReviewerResult('APPROVED')])

      const deps: LoopDependencies = {
        db,
        config: makeConfig(),
        adapters: {
          planner: makeMockAdapter([makePlannerResult()]),
          coder: coderAdapter,
          reviewer: reviewerAdapter,
        },
        workflow: DEFAULT_WORKFLOW,
      }

      const result = await executeLoop(makeCtx(), deps)

      expect(result.terminalStatus).toBe('publish')
      // Coder called twice: initial + retry
      expect(coderAdapter.runTask).toHaveBeenCalledTimes(2)
      // Reviewer called once: only after real diff appeared
      expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
      // iteration should NOT have been incremented (empty-diff retry doesn't consume review budget)
      expect(result.iteration).toBe(1)
      // emptyDiffRetries should be reset to 0 after successful diff
      expect(result.emptyDiffRetries).toBe(0)
    })

    it('blocks with empty_diff after exhausting retries', async () => {
      const mockGetDiff = vi.mocked(getDiffAgainstBranch)
      // Always return empty diff — coder never produces changes
      mockGetDiff.mockResolvedValue({ diff: '', error: null })

      const config = makeConfig()
      config.loop.maxEmptyDiffRetries = 2

      const coderAdapter = makeMockAdapter([makeCoderResult(), makeCoderResult(), makeCoderResult()])

      const deps: LoopDependencies = {
        db,
        config,
        adapters: {
          planner: makeMockAdapter([makePlannerResult()]),
          coder: coderAdapter,
          reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
        },
        workflow: DEFAULT_WORKFLOW,
      }

      const result = await executeLoop(makeCtx(), deps)

      expect(result.terminalStatus).toBe('blocked')
      expect(result.blockReason).toBe('empty_diff')
      // Coder called 3 times: initial + 2 retries
      expect(coderAdapter.runTask).toHaveBeenCalledTimes(3)
      // Reviewer should NEVER have been called (saves money)
      expect(deps.adapters['reviewer']!.runTask).not.toHaveBeenCalled()
      // Block message is deterministic
      expect(result.stepOutputs['blockMessage']).toBe(
        'Coder produced no file changes after 3 attempt(s).',
      )
    })

    it('returns terminal error on git diff failure', async () => {
      const mockGetDiff = vi.mocked(getDiffAgainstBranch)
      mockGetDiff.mockResolvedValue({ diff: '', error: 'Failed to compute diff: origin/main not found' })

      const deps: LoopDependencies = {
        db,
        config: makeConfig(),
        adapters: {
          planner: makeMockAdapter([makePlannerResult()]),
          coder: makeMockAdapter([makeCoderResult()]),
          reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
        },
        workflow: DEFAULT_WORKFLOW,
      }

      const result = await executeLoop(makeCtx(), deps)

      expect(result.terminalStatus).toBe('error')
      expect(result.stepOutputs['blockMessage']).toBe(
        'Git diff failed: Failed to compute diff: origin/main not found',
      )
      // Reviewer should NOT have been called
      expect(deps.adapters['reviewer']!.runTask).not.toHaveBeenCalled()
    })

    it('clears verify context before falling through to reviewer when no coder retry target exists', async () => {
      const mockGetDiff = vi.mocked(getDiffAgainstBranch)
      mockGetDiff.mockResolvedValue({ diff: '', error: null })

      let reviewerPrompt = ''
      const reviewerAdapter: WorkerAdapter = {
        runTask: vi.fn().mockImplementation(async (input) => {
          reviewerPrompt = input.prompt
          return makeReviewerResult('APPROVED')
        }),
        checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
      }

      const deps: LoopDependencies = {
        db,
        config: makeConfig(),
        adapters: {
          planner: makeMockAdapter([makePlannerResult()]),
          reviewer: reviewerAdapter,
        },
        workflow: {
          steps: [
            { type: 'worker', id: 'plan', role: 'planner' },
            { type: 'verify', id: 'verify' },
            { type: 'worker', id: 'review', role: 'reviewer' },
            { type: 'decide', id: 'decide', onIterate: 'plan' },
          ],
        },
      }

      const result = await executeLoop(makeCtx(), deps)

      expect(reviewerAdapter.runTask).toHaveBeenCalledTimes(1)
      expect(reviewerPrompt).not.toContain('pnpm test')
      expect(result.terminalStatus).toBe('blocked')
      expect(result.blockReason).toBe('verify_config')
    })

    it('blocks before verify when a post-worker hook reports a block', async () => {
      vi.mocked(runPostWorkerHooks).mockResolvedValueOnce({
        blockReason: 'verify_config',
        blockMessage: 'Scope guard: Too many changed files: 99 > 50',
      })

      const deps: LoopDependencies = {
        db,
        config: makeConfig(),
        adapters: {
          planner: makeMockAdapter([makePlannerResult()]),
          coder: makeMockAdapter([makeCoderResult()]),
          reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
        },
        workflow: DEFAULT_WORKFLOW,
      }

      const result = await executeLoop(makeCtx(), deps)

      expect(result.terminalStatus).toBe('blocked')
      expect(result.blockReason).toBe('verify_config')
      expect(result.stepOutputs['blockMessage']).toBe('Scope guard: Too many changed files: 99 > 50')
      expect(deps.adapters['reviewer']!.runTask).not.toHaveBeenCalled()
    })

    it('does not increment iteration on empty-diff retry', async () => {
      const mockGetDiff = vi.mocked(getDiffAgainstBranch)
      // Empty on first, real on second
      mockGetDiff
        .mockResolvedValueOnce({ diff: '', error: null })
        .mockResolvedValueOnce({ diff: 'diff --git a/file.ts b/file.ts\n+added', error: null })

      const deps: LoopDependencies = {
        db,
        config: makeConfig(),
        adapters: {
          planner: makeMockAdapter([makePlannerResult()]),
          coder: makeMockAdapter([makeCoderResult(), makeCoderResult()]),
          reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
        },
        workflow: DEFAULT_WORKFLOW,
      }

      const result = await executeLoop(makeCtx(), deps)

      expect(result.terminalStatus).toBe('publish')
      // iteration stays at 1 — empty-diff retry is NOT a review iteration
      expect(result.iteration).toBe(1)
    })

    it('rehydrates emptyDiffRetries from checkpoint on crash recovery', async () => {
      const mockGetDiff = vi.mocked(getDiffAgainstBranch)
      // On re-run of verify after crash: empty diff again → 1 prior + 1 more = 2 = max → blocks
      mockGetDiff.mockResolvedValue({ diff: '', error: null })

      const config = makeConfig()
      config.loop.maxEmptyDiffRetries = 2

      const persistedPlan = makePlannerResult('Persisted plan').parsed
      const persistedCode = makeCoderResult().parsed
      // Simulate crash DURING verify (verify started but NOT completed).
      // The code step is completed, so resume starts at verify.
      // emptyDiffRetries=1 is persisted from a prior retry in the same run.
      db.prepare('UPDATE runs SET current_phase = ?, phase_data = ?, iteration_count = ? WHERE id = ?').run(
        'verify',
        JSON.stringify({
          plan: { plan: persistedPlan },
          code: { codeResult: persistedCode },
          // verify is NOT in completed phases — it crashed mid-execution
          __completedPhases: ['plan', 'code'],
          // emptyDiffRetries stored in verify artifacts from prior iteration
          verify: {
            emptyDiffRetries: 1,
          },
        }),
        1,
        'run-test-1',
      )

      const coderAdapter = makeMockAdapter([makeCoderResult()])

      const deps: LoopDependencies = {
        db,
        config,
        adapters: {
          planner: makeMockAdapter([makePlannerResult()]),
          coder: coderAdapter,
          reviewer: makeMockAdapter([makeReviewerResult('APPROVED')]),
        },
        workflow: DEFAULT_WORKFLOW,
      }

      const result = await executeLoop(makeCtx({ emptyDiffRetries: 1 }), deps)

      // Verify re-runs. Diff is empty. emptyDiffRetries was 1 from checkpoint.
      // Guard retries coder (emptyDiffRetries → 2). Coder runs, verify runs again.
      // Diff still empty. emptyDiffRetries(2) >= max(2) → blocked.
      expect(result.terminalStatus).toBe('blocked')
      expect(result.blockReason).toBe('empty_diff')
      // Coder called once for the retry before exhaustion
      expect(coderAdapter.runTask).toHaveBeenCalledTimes(1)
    })
  })
})
