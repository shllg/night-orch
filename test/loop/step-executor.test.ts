import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  executeStep,
  executeWorkerStep,
  executeVerifyStep,
  executeDecideStep,
  buildPromptContext,
  getWorkerProfile,
  resolveContinueSession,
  type StepDependencies,
} from '../../src/loop/step-executor.js'
import type { RunContext } from '../../src/loop/types.js'
import type { WorkerStep, VerifyStep, DecideStep } from '../../src/loop/workflow.js'
import type { Config } from '../../src/config/schema.js'
import type { WorkerAdapter, WorkerTaskResult } from '../../src/workers/types.js'

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
  getDiffAgainstBranch: vi.fn().mockResolvedValue('diff --git a/file.ts b/file.ts\n+added'),
  getChangedFilesAgainstBranch: vi.fn().mockResolvedValue(['src/a.ts']),
}))

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

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
    sessionId: 'sess-planner-1',
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
    sessionId: 'sess-coder-1',
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
    sessionId: 'sess-reviewer-1',
  }
}

function makeMockAdapter(result: WorkerTaskResult): WorkerAdapter {
  return {
    runTask: vi.fn().mockResolvedValue(result),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
  }
}

function makeConfig(): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '', logsRoot: '' },
    notifications: { channels: [{ type: 'console' }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
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
    ...overrides,
  }
}

function makeDeps(adapters: Record<string, WorkerAdapter>): StepDependencies {
  return { adapters, config: makeConfig() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeStep dispatcher', () => {
  it('routes worker steps to executeWorkerStep', async () => {
    const step: WorkerStep = { type: 'worker', id: 'plan', role: 'planner' }
    const deps = makeDeps({ planner: makeMockAdapter(makePlannerResult()) })
    const result = await executeStep(makeCtx(), step, deps)
    expect(result.ctx.plan).not.toBeNull()
    expect(result.ctx.plan!.objective).toBe('Fix it')
  })

  it('routes verify steps to executeVerifyStep', async () => {
    const step: VerifyStep = { type: 'verify', id: 'verify' }
    const deps = makeDeps({})
    const result = await executeStep(makeCtx(), step, deps)
    expect(result.ctx.diff).not.toBeNull()
  })

  it('routes decide steps to executeDecideStep', async () => {
    const ctx = makeCtx({
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
      verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const step: DecideStep = { type: 'decide', id: 'decide', onIterate: 'code' }
    const deps = makeDeps({})
    const result = await executeStep(ctx, step, deps)
    expect(result.decision).toBeDefined()
    expect(result.decision!.action).toBe('publish')
  })
})

describe('executeWorkerStep', () => {
  it('planner role populates ctx.plan', async () => {
    const step: WorkerStep = { type: 'worker', id: 'plan', role: 'planner' }
    const deps = makeDeps({ planner: makeMockAdapter(makePlannerResult('Build the feature')) })
    const result = await executeWorkerStep(makeCtx(), step, deps)

    expect(result.ctx.plan).not.toBeNull()
    expect(result.ctx.plan!.objective).toBe('Build the feature')
    expect(result.ctx.totalAgentPasses).toBe(1)
    expect(result.ctx.sessionIds['plan']).toBe('sess-planner-1')
    expect(result.ctx.sessionIds['planner']).toBe('sess-planner-1')
    expect(result.ctx.sessionIds['plan::claude']).toBe('sess-planner-1')
    expect(result.ctx.sessionIds['planner::claude']).toBe('sess-planner-1')
    expect(result.ctx.stepOutputs['plan']).not.toBeUndefined()
  })

  it('coder role populates ctx.codeResult', async () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' }
    const deps = makeDeps({ coder: makeMockAdapter(makeCoderResult()) })
    const result = await executeWorkerStep(makeCtx(), step, deps)

    expect(result.ctx.codeResult).not.toBeNull()
    expect(result.ctx.codeResult!.summary).toBe('Fixed the bug')
    expect(result.ctx.totalAgentPasses).toBe(1)
    expect(result.ctx.sessionIds['code']).toBe('sess-coder-1')
    expect(result.ctx.sessionIds['coder']).toBe('sess-coder-1')
    expect(result.ctx.sessionIds['code::claude']).toBe('sess-coder-1')
    expect(result.ctx.sessionIds['coder::claude']).toBe('sess-coder-1')
  })

  it('does not pass continueSessionId across different role agents', async () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' }
    const adapter = makeMockAdapter(makeCoderResult())
    const config = makeConfig()
    config.workerProfiles['codex'] = {
      type: 'codex',
      command: 'codex',
      args: ['-p'],
      workerTimeoutSeconds: 1800,
      minimalEnv: true,
      runtimeWrapper: null,
      env: {},
    }
    const ctx = makeCtx({
      roles: { planner: 'claude', coder: 'codex', reviewer: 'claude' },
      repoConfig: {
        ...makeCtx().repoConfig,
        agents: { claude: 'claude', codex: 'codex' },
      },
      sessionIds: { plan: 'sess-plan-claude', planner: 'sess-plan-claude' },
    })
    const deps: StepDependencies = { adapters: { codex: adapter }, config }

    await executeWorkerStep(ctx, step, deps)

    expect(adapter.runTask).toHaveBeenCalledWith(expect.objectContaining({ continueSessionId: null }))
  })

  it('reviewer role populates ctx.reviewResult', async () => {
    const step: WorkerStep = { type: 'worker', id: 'review', role: 'reviewer' }
    const deps = makeDeps({ reviewer: makeMockAdapter(makeReviewerResult('APPROVED')) })
    const result = await executeWorkerStep(makeCtx(), step, deps)

    expect(result.ctx.reviewResult).not.toBeNull()
    expect(result.ctx.reviewResult!.verdict).toBe('APPROVED')
    expect(result.ctx.totalAgentPasses).toBe(1)
  })

  it('custom role populates ctx.stepOutputs only', async () => {
    const customResult: WorkerTaskResult = {
      rawOutput: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 500,
      parsed: { custom: 'data' } as unknown as WorkerTaskResult['parsed'],
      parseError: null,
      sessionId: 'sess-custom-1',
    }
    const step: WorkerStep = { type: 'worker', id: 'lint-fix', role: 'linter' }
    const config = makeConfig()
    config.workerProfiles['linter-profile'] = { type: 'linter', command: 'lint', args: [], workerTimeoutSeconds: 600, minimalEnv: true, runtimeWrapper: null, env: {} }
    const ctx = makeCtx({
      roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    })
    const deps: StepDependencies = { adapters: { linter: makeMockAdapter(customResult) }, config }
    const result = await executeWorkerStep(ctx, step, deps)

    expect(result.ctx.stepOutputs['lint-fix']).toEqual({ custom: 'data' })
    expect(result.ctx.plan).toBeNull() // untouched
    expect(result.ctx.codeResult).toBeNull() // untouched
    expect(result.ctx.reviewResult).toBeNull() // untouched
    expect(result.ctx.totalAgentPasses).toBe(1)
    expect(result.ctx.sessionIds['linter']).toBe('sess-custom-1')
  })

  it('returns tokenUsage when available', async () => {
    const resultWithTokens = { ...makePlannerResult(), tokenUsage: { promptTokens: 100, completionTokens: 50 } }
    const step: WorkerStep = { type: 'worker', id: 'plan', role: 'planner' }
    const deps = makeDeps({ planner: makeMockAdapter(resultWithTokens) })
    const result = await executeWorkerStep(makeCtx(), step, deps)

    expect(result.tokenUsage).toEqual({ promptTokens: 100, completionTokens: 50 })
    expect(result.pricingIdentity).toEqual({
      role: 'planner',
      workerType: 'claude',
      pricingModel: null,
    })
  })

  it('throws when worker times out', async () => {
    const timedOutResult: WorkerTaskResult = {
      rawOutput: '',
      exitCode: 0,
      timedOut: true,
      durationMs: 1800000,
      parsed: null,
      parseError: null,
      sessionId: null,
    }
    const step: WorkerStep = { type: 'worker', id: 'plan', role: 'planner' }
    const deps = makeDeps({ planner: makeMockAdapter(timedOutResult) })

    await expect(executeWorkerStep(makeCtx(), step, deps)).rejects.toThrow('planner worker timed out')
  })

  it('throws when worker exits non-zero', async () => {
    const failedResult: WorkerTaskResult = {
      rawOutput: 'error output',
      exitCode: 1,
      timedOut: false,
      durationMs: 500,
      parsed: null,
      parseError: null,
      sessionId: null,
    }
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder' }
    const deps = makeDeps({ coder: makeMockAdapter(failedResult) })

    await expect(executeWorkerStep(makeCtx(), step, deps)).rejects.toThrow('coder worker exited with code 1')
  })

  it('throws when no adapter found for role', async () => {
    const step: WorkerStep = { type: 'worker', id: 'plan', role: 'planner' }
    const deps = makeDeps({}) // no adapters

    await expect(executeWorkerStep(makeCtx(), step, deps)).rejects.toThrow('No worker adapter found for role "planner"')
  })

  it('coder parse failure with exit 0 falls back to git diff', async () => {
    const failedParseResult: WorkerTaskResult = {
      rawOutput: 'some raw output',
      exitCode: 0,
      timedOut: false,
      durationMs: 2000,
      parsed: null,
      parseError: 'Could not parse JSON',
      sessionId: null,
    }
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder' }
    const deps = makeDeps({ coder: makeMockAdapter(failedParseResult) })
    const result = await executeWorkerStep(makeCtx(), step, deps)

    expect(result.ctx.codeResult).not.toBeNull()
    expect(result.ctx.codeResult!.changedFiles).toEqual(['src/a.ts'])
    expect(result.ctx.codeResult!.summary).toContain('git diff')
  })

  it('resolves adapter via roles → agents mapping', async () => {
    // Adapter registered as 'claude', role is 'planner', roles.planner = 'claude'
    const step: WorkerStep = { type: 'worker', id: 'plan', role: 'planner' }
    const adapter = makeMockAdapter(makePlannerResult())
    const deps = makeDeps({ claude: adapter })
    const result = await executeWorkerStep(makeCtx(), step, deps)

    expect(result.ctx.plan).not.toBeNull()
    expect(adapter.runTask).toHaveBeenCalledTimes(1)
  })
})

describe('executeVerifyStep', () => {
  it('populates ctx.verifyResults and ctx.diff', async () => {
    const step: VerifyStep = { type: 'verify', id: 'verify' }
    const deps = makeDeps({})
    const ctx = makeCtx({ verifyResults: [] })
    const result = await executeVerifyStep(ctx, step, deps)

    // verifyResults come from the mocked execa (verify commands run against empty mock)
    expect(result.ctx.verifyResults).toBeDefined()
    expect(result.ctx.diff).toBe('diff --git a/file.ts b/file.ts\n+added')
  })
})

describe('executeDecideStep', () => {
  it('APPROVED review + verify pass → publish', async () => {
    const ctx = makeCtx({
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
      verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const step: DecideStep = { type: 'decide', id: 'decide', onIterate: 'code' }
    const deps = makeDeps({})
    const result = await executeDecideStep(ctx, step, deps)

    expect(result.decision!.action).toBe('publish')
  })

  it('CHANGES_REQUIRED → iterate', async () => {
    const ctx = makeCtx({
      reviewResult: {
        verdict: 'CHANGES_REQUIRED',
        summary: 'Needs tests',
        findings: [{ severity: 'major', message: 'Missing tests', suggestedFix: 'Add tests' }],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
      },
      verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const step: DecideStep = { type: 'decide', id: 'decide', onIterate: 'code' }
    const deps = makeDeps({})
    const result = await executeDecideStep(ctx, step, deps)

    expect(result.decision!.action).toBe('iterate')
  })

  it('BLOCKED → block', async () => {
    const ctx = makeCtx({
      reviewResult: {
        verdict: 'BLOCKED',
        summary: 'Fundamentally wrong approach',
        findings: [{ severity: 'critical', message: 'Wrong approach', suggestedFix: null }],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
      },
    })
    const step: DecideStep = { type: 'decide', id: 'decide', onIterate: 'code' }
    const deps = makeDeps({})
    const result = await executeDecideStep(ctx, step, deps)

    expect(result.decision!.action).toBe('block')
  })

  it('no review result + blockOnAmbiguousReview → block', async () => {
    const ctx = makeCtx({ reviewResult: null })
    const step: DecideStep = { type: 'decide', id: 'decide', onIterate: 'code' }
    const deps = makeDeps({})
    const result = await executeDecideStep(ctx, step, deps)

    expect(result.decision!.action).toBe('block')
  })

  it('propagates subscription cost model from config to decide()', async () => {
    const ctx = makeCtx({
      estimatedCostUsd: 250,
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
      verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const step: DecideStep = { type: 'decide', id: 'decide', onIterate: 'code' }
    const config = makeConfig()
    config.cost = { model: 'subscription' }
    const deps: StepDependencies = { adapters: {}, config }

    const result = await executeDecideStep(ctx, step, deps)

    expect(result.decision!.action).toBe('publish')
  })
})

describe('buildPromptContext', () => {
  it('maps RunContext fields correctly', () => {
    const ctx = makeCtx({
      plan: { objective: 'Do the thing', assumptions: [], filesToChange: [], steps: [], risks: [], testStrategy: '' },
      diff: 'some diff',
      reviewFindings: [{ severity: 'minor', message: 'Nit', suggestedFix: null }],
      iteration: 2,
    })
    const result = buildPromptContext(ctx, 'coder')

    expect(result.role).toBe('coder')
    expect(result.issue.number).toBe(1)
    expect(result.issue.title).toBe('Fix bug')
    expect(result.plan).toBe('Do the thing')
    expect(result.diff).toBe('some diff')
    expect(result.reviewFindings).toHaveLength(1)
    expect(result.iteration.current).toBe(2)
    expect(result.iteration.isRetry).toBe(true)
  })

  it('handles null plan and empty findings', () => {
    const ctx = makeCtx()
    const result = buildPromptContext(ctx, 'planner')

    expect(result.plan).toBeNull()
    expect(result.reviewFindings).toBeNull()
    expect(result.verifyResults).toBeNull()
    expect(result.iteration.isRetry).toBe(false)
  })

  it('maps follow-up context from prReviewFeedback', () => {
    const ctx = makeCtx({
      prReviewFeedback: {
        type: 'human_review',
        summary: 'Continue requested with requested review changes',
        context: 'Please address the requested changes',
      },
    })

    const result = buildPromptContext(ctx, 'coder')

    expect(result.followup).toEqual({
      type: 'human_review',
      summary: 'Continue requested with requested review changes',
      context: 'Please address the requested changes',
    })
  })
})

describe('getWorkerProfile', () => {
  it('resolves profile via roles → agents → workerProfiles chain', () => {
    const ctx = makeCtx()
    const deps = makeDeps({})
    const profile = getWorkerProfile(ctx, 'planner', deps)

    expect(profile.type).toBe('claude')
    expect(profile.command).toBe('claude')
  })

  it('falls back to matching profile type', () => {
    const ctx = makeCtx({
      roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
      repoConfig: {
        ...makeCtx().repoConfig,
        agents: {}, // no agent mapping
      },
    })
    const deps = makeDeps({})
    const profile = getWorkerProfile(ctx, 'planner', deps)

    expect(profile.type).toBe('claude')
  })

  it('throws when no profile found', () => {
    const ctx = makeCtx({
      roles: { planner: 'nonexistent', coder: 'claude', reviewer: 'claude' },
      repoConfig: {
        ...makeCtx().repoConfig,
        agents: {},
      },
    })
    const config = makeConfig()
    config.workerProfiles = {} // no profiles at all
    const deps: StepDependencies = { adapters: {}, config }

    expect(() => getWorkerProfile(ctx, 'planner', deps)).toThrow('No worker profile found')
  })
})

describe('resolveContinueSession', () => {
  it('returns null when step has no continueFrom', () => {
    const step: WorkerStep = { type: 'worker', id: 'review', role: 'reviewer' }
    const ctx = makeCtx({ sessionIds: { planner: 'sess-1', coder: 'sess-2' } })
    expect(resolveContinueSession(ctx, step, 'claude')).toBeNull()
  })

  it('returns session from continueFrom step', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' }
    const ctx = makeCtx({ sessionIds: { plan: 'sess-plan-1' } })
    expect(resolveContinueSession(ctx, step, 'claude')).toBe('sess-plan-1')
  })

  it('prefers scoped session from continueFrom step', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' }
    const ctx = makeCtx({ sessionIds: { 'plan::claude': 'sess-plan-scoped', plan: 'sess-plan-unscoped' } })
    expect(resolveContinueSession(ctx, step, 'claude')).toBe('sess-plan-scoped')
  })

  it('supports legacy role-keyed planner sessions', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' }
    const ctx = makeCtx({ sessionIds: { planner: 'sess-planner-legacy' } })
    expect(resolveContinueSession(ctx, step, 'claude')).toBe('sess-planner-legacy')
  })

  it('supports legacy continueFrom values keyed by role name', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'planner' }
    const ctx = makeCtx({ sessionIds: { planner: 'sess-planner-1' } })
    expect(resolveContinueSession(ctx, step, 'claude')).toBe('sess-planner-1')
  })

  it('does not continue unscoped session across different role agents', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' }
    const ctx = makeCtx({
      roles: { planner: 'claude', coder: 'codex', reviewer: 'claude' },
      sessionIds: { plan: 'sess-plan-claude', planner: 'sess-plan-claude' },
    })
    expect(resolveContinueSession(ctx, step, 'codex')).toBeNull()
  })

  it('falls back to own session on iteration 2+', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'planner' }
    const ctx = makeCtx({
      iteration: 2,
      sessionIds: { coder: 'sess-coder-prev' },
      // no planner session
    })
    expect(resolveContinueSession(ctx, step, 'claude')).toBe('sess-coder-prev')
  })

  it('does not fall back to own session on iteration 1', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'planner' }
    const ctx = makeCtx({
      iteration: 1,
      sessionIds: { coder: 'sess-coder-prev' },
    })
    expect(resolveContinueSession(ctx, step, 'claude')).toBeNull()
  })

  it('prefers continueFrom session over own session', () => {
    const step: WorkerStep = { type: 'worker', id: 'code', role: 'coder', continueFrom: 'planner' }
    const ctx = makeCtx({
      iteration: 2,
      sessionIds: { planner: 'sess-planner-1', coder: 'sess-coder-prev' },
    })
    expect(resolveContinueSession(ctx, step, 'claude')).toBe('sess-planner-1')
  })
})
