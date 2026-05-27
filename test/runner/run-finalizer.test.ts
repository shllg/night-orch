import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { finalizeRunOutcome } from '../../src/runner/run-finalizer.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { Config, RepoConfig } from '../../src/config/schema.js'
import type { RunContext } from '../../src/loop/types.js'
import type { NotificationDispatcher } from '../../src/notify/dispatcher.js'

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
      ready: ['orch:ready'],
      running: 'orch:running',
      blocked: 'orch:blocked',
      needsHuman: 'orch:needs-human',
      reviewReady: 'orch:review-ready',
      error: 'orch:error',
      retry: 'orch:retry',
      planning: 'orch:planning',
      mergeQueued: 'orch:merge-queued',
      merging: 'orch:merging',
      mergeFailed: 'orch:merge-failed',
    },
    labelConfig: {},
    defaults: { planner: 'codex', coder: 'codex', reviewer: 'codex', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
    environment: undefined,
    verify: [],
    preflight: { enabled: false },
    planning: { prdDirectory: 'docs/prd' },
    fileLoop: {},
    selectors: { includeLabelsAny: ['orch:ready'], excludeLabelsAny: ['orch:blocked', 'orch:error', 'orch:needs-human'] },
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
    workerProfiles: {},
    verificationProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    observability: { agentStreaming: true, eventRetention: 1000, sessionLogs: true, sessionLogRetention: 7 },
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null, httpPort: 3100, httpHost: '127.0.0.1' },
    commentCommands: { enabled: true, requireCollaborator: true },
    repos: [repoConfig],
    workflows: {},
  }
}

function makeForge(): ForgeAdapter {
  return {
    getIssue: vi.fn().mockResolvedValue({
      number: 1,
      nodeId: 'issue-node',
      title: 'Issue',
      body: '',
      labels: ['orch:running'],
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
      issue: { number: 1, nodeId: 'issue-node', title: 'Issue', body: '', labels: ['orch:running'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
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
      reviewResult: null,
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
})
