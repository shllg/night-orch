import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { finalizeRunOutcome } from '../../src/runner/run-finalizer.js'
import { transitionLabels } from '../../src/labels/manager.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { Config, RepoConfig } from '../../src/config/schema.js'
import type { RunContext } from '../../src/loop/types.js'
import type { NotificationDispatcher } from '../../src/notify/dispatcher.js'
import type { WorkerAdapter, WorkerTaskResult } from '../../src/workers/types.js'
import { CostTracker } from '../../src/loop/cost.js'
import { WorkerAuthError } from '../../src/workers/errors.js'

vi.mock('../../src/publishing/publisher.js', () => ({
  publishPR: vi.fn().mockResolvedValue({
    prNumber: 42,
    prTitle: 'Fix issue',
    prUrl: 'https://example.com/pr/42',
    created: true,
  }),
}))

vi.mock('../../src/labels/manager.js', () => ({
  transitionLabels: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeRepoConfig(): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    linkedProjects: [],
    maxConcurrentRuns: 1,
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    updateStrategy: 'merge',
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: 'no:blocked',
      needsHuman: 'no:needs-human',
      reviewReady: 'no:review-ready',
      error: 'no:error',
      retry: 'no:retry',
      planning: 'no:planning',
      mergeQueued: 'no:merge-queued',
      merging: 'no:merging',
      mergeFailed: 'no:merge-failed',
    },
    labelConfig: {},
    defaults: { planner: 'codex', coder: 'codex', reviewer: 'codex', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
    environment: undefined,
    verify: [],
    preflight: { enabled: false },
    planning: { prdDirectory: 'docs/prd' },
    fileLoop: {},
    selectors: { includeLabelsAny: ['no:ready'], excludeLabelsAny: ['no:blocked', 'no:error', 'no:needs-human'] },
    agents: {},
    mergeQueue: { enabled: false, batchSize: 5, mergeMethod: 'merge', retryFlakyOnce: true, requireApproval: true, stagingBranchPrefix: 'orch/staging' },
  } as RepoConfig
}

function makeConfig(repoConfig: RepoConfig): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs', autoCleanup: { enabled: true, intervalMinutes: 60 }, retention: { worktreeAgeDays: 7, detailDays: 30, archiveDays: 90 } },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, maxAttemptChainLength: 3, maxRunTokens: 0, maxIssueTokens: 0, maxDailyTokens: 0, maxRunWallClockMinutes: 0, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true, maxAutoRetries: 3, maxEmptyDiffRetries: 2, maxConsecutiveBlocks: 4, decompose: false, maxSubtasks: 5, maxConcurrentSubtasks: 3 },
    fileLoop: { enabled: false, maxDurationMinutes: 480, maxIterations: 1000, minIntervalSecondsBetweenFiles: 5, perIterationTimeoutSeconds: 120, maxCostUsd: 5, maxFileLines: 1500, includeGlobs: [], excludeGlobs: [], reviewerProfileKey: 'codex-default', branchNameTemplate: 'orch/file-loop/{repoSlug}/{yyyyMmDd}', loopMdPath: 'loop.md', commitPrefix: '[FILE-LOOP]', perEditVerify: { enabled: true, commands: ['pnpm typecheck'], timeoutSeconds: 60 }, finalizeVerify: { enabled: true, commands: ['pnpm typecheck'], timeoutSeconds: 300, onFailure: 'draft-pr' } },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    cost: { model: 'pay-per-use', subscriptionMetered: { advisoryThresholdUsd: null, enforcePerRunLimit: false, enforceDailyLimit: false }, allowEstimatedDuration: false },
    ai: { internal: { provider: null, model: null, apiKeyEnv: null, timeoutMs: 30_000, maxTokens: 1024, features: { conflictResolver: true }, enable: { triage: false, reviewerParseFallback: false, prBody: false } } },
    autoResolveConflicts: { enabled: true, maxAttempts: 2, maxFiles: 5 },
    workerProfiles: {
      codex: {
        type: 'codex',
        command: 'codex',
        args: ['-p'],
        workerTimeoutSeconds: 1800,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
      },
    },
    verificationProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    observability: { agentStreaming: true, eventRetention: 1000, sessionLogs: true, sessionLogRetention: 7 },
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null, httpPort: 3100, httpHost: '127.0.0.1' },
    commentCommands: { enabled: true, requireCollaborator: true },
    repos: [repoConfig],
    workflows: {},
  }
}

function makeExternalReviewResult(): WorkerTaskResult {
  return {
    rawOutput: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 25,
    parsed: {
      verdict: 'CHANGES_REQUIRED',
      summary: 'CodeRabbit found a missing null guard',
      findings: [
        {
          severity: 'major',
          message: 'Add a null guard before reading config.name',
          suggestedFix: 'Return early when config is null.',
        },
      ],
      definitionOfDoneCheck: {
        issueAddressed: false,
        testsPassing: true,
        noBlockingFindings: false,
      },
    },
    parseError: null,
    sessionId: 'sess-cr',
    tokenUsage: { promptTokens: 10, completionTokens: 5 },
  }
}

function makeReviewerAdapter(result: WorkerTaskResult = makeExternalReviewResult()): WorkerAdapter {
  return {
    runTask: vi.fn().mockResolvedValue(result),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: 'test' }),
  }
}

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    getIssue: vi.fn().mockResolvedValue({
      number: 1,
      nodeId: 'issue-node',
      title: 'Issue',
      body: '',
      labels: ['no:running'],
      assignees: [],
      state: 'open',
      createdAt: '',
      updatedAt: '',
      url: '',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listEligibleIssues: vi.fn(),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn(),
    updateComment: vi.fn(),
    listPRReviews: vi.fn(),
    listPRReviewComments: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    ...overrides,
  } as unknown as ForgeAdapter
}

function makeNotifier(): NotificationDispatcher {
  return {
    dispatch: vi.fn().mockResolvedValue({ sent: [] }),
  } as unknown as NotificationDispatcher
}

describe('finalizeRunOutcome', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'run-finalizer-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('clears stale last_error when publish finalizes as review_ready', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'Issue',
      issueNodeId: 'issue-node',
      planner: 'codex',
      coder: 'codex',
      reviewer: 'codex',
    })
    runManager.update(run.id, { status: 'running', lastError: 'stale worker error' })

    const repoConfig = makeRepoConfig()
    const finalCtx = {
      runId: run.id,
      repo: 'org/repo',
      issueRepo: 'org/repo',
      issueNumber: 1,
      issue: { number: 1, nodeId: 'issue-node', title: 'Issue', body: '', labels: ['no:running'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      repoConfig,
      roles: { planner: 'codex', coder: 'codex', reviewer: 'codex' },
      triageResult: { level: 'standard', reason: 'test' },
      adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
      branchName: 'orch/1-fix',
      worktreePath: '/tmp/wt',
      plan: null,
      codeResult: null,
      diff: 'diff',
      verifyResults: [],
      reviewResults: {},
      reviewFindings: [],
      iteration: 2,
      totalAgentPasses: 3,
      estimatedCostUsd: 0,
      currentPhase: 'completed',
      terminalStatus: 'publish',
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
    } satisfies RunContext

    await finalizeRunOutcome({
      finalCtx,
      runId: run.id,
      issue: { number: 1, title: 'Issue', url: '' },
      runDurationSec: 3,
      repo: 'org/repo',
      repoConfig,
      issueRepo: 'org/repo',
      issueNumber: 1,
      db,
      forge: makeForge(),
      runManager,
      notifier: makeNotifier(),
      maxAutoRetries: 0,
      botUser: 'night-orch',
    })

    const row = runManager.getById(run.id)
    expect(row?.status).toBe('review_ready')
    expect(row?.lastError).toBeNull()
    expect(row?.iterationCount).toBe(2)
    expect(row?.prNumber).toBe(42)
  })

  it('runs post-publish reviewer steps after PR publication and upserts a prefixed issue comment', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'Issue',
      issueNodeId: 'issue-node',
      planner: 'codex',
      coder: 'codex',
      reviewer: 'codex',
    })
    runManager.update(run.id, { status: 'running' })

    const repoConfig = makeRepoConfig()
    const config = makeConfig(repoConfig)
    const reviewer = makeReviewerAdapter()
    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    })
    const finalCtx = {
      runId: run.id,
      repo: 'org/repo',
      issueRepo: 'org/repo',
      issueNumber: 1,
      issue: { number: 1, nodeId: 'issue-node', title: 'Issue', body: '', labels: ['no:running'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      repoConfig,
      roles: { planner: 'codex', coder: 'codex', reviewer: 'codex' },
      triageResult: { level: 'standard', reason: 'test' },
      adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
      branchName: 'orch/1-fix',
      worktreePath: '/tmp/wt',
      plan: null,
      codeResult: null,
      diff: 'diff',
      verifyResults: [],
      reviewResults: {},
      reviewFindings: [],
      iteration: 1,
      totalAgentPasses: 0,
      estimatedCostUsd: 0,
      currentPhase: 'completed',
      terminalStatus: 'publish',
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
    } satisfies RunContext

    await finalizeRunOutcome({
      finalCtx,
      runId: run.id,
      issue: { number: 1, title: 'Issue', url: '' },
      runDurationSec: 3,
      repo: 'org/repo',
      repoConfig,
      issueRepo: 'org/repo',
      issueNumber: 1,
      db,
      forge,
      runManager,
      notifier: makeNotifier(),
      maxAutoRetries: 0,
      botUser: 'night-orch',
      postPublish: {
        config,
        workflow: {
          steps: [
            {
              type: 'worker',
              id: 'cr',
              role: 'reviewer',
              runWhen: 'post-publish',
              onChangesRequired: 'comment-only',
              commentPrefix: '[night-orch][cr]',
            },
          ],
        },
        adapters: { reviewer },
      },
    })

    expect(reviewer.runTask).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'cr',
      role: 'reviewer',
      worktreePath: '/tmp/wt',
    }))
    expect(forge.commentOnIssue).toHaveBeenCalledWith(
      'org/repo',
      1,
      expect.stringContaining('<!-- night-orch:cr-'),
    )
    expect(forge.commentOnIssue).toHaveBeenCalledWith(
      'org/repo',
      1,
      expect.stringContaining('[night-orch][cr]'),
    )
    expect(forge.commentOnIssue).toHaveBeenCalledWith(
      'org/repo',
      1,
      expect.stringContaining('Add a null guard before reading config.name'),
    )
    const handoffRows = db
      .prepare("SELECT step_id, kind, summary, content_md, content_json FROM agent_handoffs WHERE run_id = ?")
      .all(run.id) as Array<{
        step_id: string
        kind: string
        summary: string
        content_md: string
        content_json: string | null
      }>
    expect(handoffRows).toHaveLength(1)
    expect(handoffRows[0]).toMatchObject({
      step_id: 'cr',
      kind: 'external-review-findings',
      summary: 'CHANGES_REQUIRED: 1 finding',
    })
    expect(handoffRows[0]?.content_md).toContain('CodeRabbit found a missing null guard')
    expect(JSON.parse(handoffRows[0]!.content_json!)).toMatchObject({
      verdict: 'CHANGES_REQUIRED',
      findings: [{ message: 'Add a null guard before reading config.name' }],
    })
    expect(runManager.getById(run.id)?.phaseData?.['cr']).toMatchObject({
      reviewerKey: 'cr',
      reviewResults: {
        cr: {
          verdict: 'CHANGES_REQUIRED',
        },
      },
    })
    expect(runManager.getById(run.id)?.phaseData?.['__completedPhases']).toContain('cr')
    expect(new CostTracker(db).getRunTokenUsage(run.id)).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
    expect(runManager.getById(run.id)?.status).toBe('review_ready')
    expect(runManager.getById(run.id)?.phaseData?.reactionType).toBeUndefined()
  })

  it('queues a continue pass for external_review findings when post-publish review requires changes', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'Issue',
      issueNodeId: 'issue-node',
      planner: 'codex',
      coder: 'codex',
      reviewer: 'codex',
    })
    runManager.update(run.id, { status: 'running' })

    const repoConfig = makeRepoConfig()
    const config = makeConfig(repoConfig)
    const reviewer = makeReviewerAdapter()
    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    })
    const finalCtx = {
      runId: run.id,
      repo: 'org/repo',
      issueRepo: 'org/repo',
      issueNumber: 1,
      issue: { number: 1, nodeId: 'issue-node', title: 'Issue', body: '', labels: ['no:running'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      repoConfig,
      roles: { planner: 'codex', coder: 'codex', reviewer: 'codex' },
      triageResult: { level: 'standard', reason: 'test' },
      adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
      branchName: 'orch/1-fix',
      worktreePath: '/tmp/wt',
      plan: null,
      codeResult: null,
      diff: 'diff',
      verifyResults: [],
      reviewResults: {
        review: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'Internal review found a missing test',
          findings: [
            {
              severity: 'minor',
              message: 'Add a regression test for empty config',
              suggestedFix: null,
            },
          ],
          definitionOfDoneCheck: {
            issueAddressed: false,
            testsPassing: true,
            noBlockingFindings: false,
          },
        },
      },
      reviewFindings: [
        {
          severity: 'minor',
          message: 'Add a regression test for empty config',
          suggestedFix: null,
          sourceStepId: 'review',
          sourceRole: 'reviewer',
        },
      ],
      iteration: 1,
      totalAgentPasses: 1,
      estimatedCostUsd: 0,
      currentPhase: 'completed',
      terminalStatus: 'publish',
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
    } satisfies RunContext

    await finalizeRunOutcome({
      finalCtx,
      runId: run.id,
      issue: { number: 1, title: 'Issue', url: '' },
      runDurationSec: 3,
      repo: 'org/repo',
      repoConfig,
      issueRepo: 'org/repo',
      issueNumber: 1,
      db,
      forge,
      runManager,
      notifier: makeNotifier(),
      maxAutoRetries: 0,
      botUser: 'night-orch',
      postPublish: {
        config,
        workflow: {
          steps: [
            {
              type: 'worker',
              id: 'cr',
              role: 'reviewer',
              runWhen: 'post-publish',
              commentPrefix: '[night-orch][cr]',
            },
          ],
        },
        adapters: { reviewer },
      },
    })

    const row = runManager.getById(run.id)
    expect(row?.status).toBe('queued')
    expect(row?.phaseData?.reactionType).toBe('external_review')
    expect(row?.phaseData?.reactionSummary).toContain('cr')
    expect(row?.phaseData?.reactionContext).toContain('Add a regression test for empty config')
    expect(row?.phaseData?.reactionContext).toContain('Add a null guard before reading config.name')
  })

  it('marks the run blocked when a post-publish reviewer hits a typed worker error', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'Issue',
      issueNodeId: 'issue-node',
      planner: 'codex',
      coder: 'codex',
      reviewer: 'codex',
    })
    runManager.update(run.id, { status: 'running' })

    const repoConfig = makeRepoConfig()
    const config = makeConfig(repoConfig)
    const reviewer: WorkerAdapter = {
      runTask: vi.fn().mockRejectedValue(new WorkerAuthError('codex', 'Run codex login', 'signed out', 'cr')),
      checkAvailability: vi.fn().mockResolvedValue({ available: true, version: 'test' }),
    }
    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    })
    const finalCtx = {
      runId: run.id,
      repo: 'org/repo',
      issueRepo: 'org/repo',
      issueNumber: 1,
      issue: { number: 1, nodeId: 'issue-node', title: 'Issue', body: '', labels: ['no:running'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      repoConfig,
      roles: { planner: 'codex', coder: 'codex', reviewer: 'codex' },
      triageResult: { level: 'standard', reason: 'test' },
      adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
      branchName: 'orch/1-fix',
      worktreePath: '/tmp/wt',
      plan: null,
      codeResult: null,
      diff: 'diff',
      verifyResults: [],
      reviewResults: {},
      reviewFindings: [],
      iteration: 1,
      totalAgentPasses: 0,
      estimatedCostUsd: 0,
      currentPhase: 'completed',
      terminalStatus: 'publish',
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
    } satisfies RunContext

    const outcome = await finalizeRunOutcome({
      finalCtx,
      runId: run.id,
      issue: { number: 1, title: 'Issue', url: '' },
      runDurationSec: 3,
      repo: 'org/repo',
      repoConfig,
      issueRepo: 'org/repo',
      issueNumber: 1,
      db,
      forge,
      runManager,
      notifier: makeNotifier(),
      maxAutoRetries: 3,
      botUser: 'night-orch',
      postPublish: {
        config,
        workflow: {
          steps: [
            {
              type: 'worker',
              id: 'cr',
              role: 'reviewer',
              runWhen: 'post-publish',
              commentPrefix: '[night-orch][cr]',
            },
          ],
        },
        adapters: { reviewer },
      },
    })

    expect(outcome).toBe('processed')
    const row = runManager.getById(run.id)
    expect(row?.status).toBe('blocked')
    expect(row?.blockReason).toBe('auth_failure')
    expect(row?.lastError).toBe('Worker authentication failed: codex')
    expect(row?.prNumber).toBe(42)
    expect(row?.phaseData?.['cr']).toMatchObject({
      blocked: true,
      reason: 'Worker authentication failed: codex',
    })
    expect(transitionLabels).toHaveBeenCalledWith(
      forge,
      'org/repo',
      1,
      ['no:running'],
      'running',
      'blocked',
      expect.anything(),
      expect.objectContaining({ type: 'authFailure' }),
    )
    expect(vi.mocked(transitionLabels).mock.calls.some((call) =>
      call[4] === 'review_ready' && call[5] === 'blocked',
    )).toBe(false)
    expect(forge.commentOnIssue).toHaveBeenCalledWith(
      'org/repo',
      1,
      expect.stringContaining('Worker authentication failed: codex'),
    )
  })
})
