import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import type { Config } from '../../src/config/schema.js'
import type { ForgeAdapter, ForgeIssue } from '../../src/forge/types.js'
import type { WorktreeInfo } from '../../src/git/worktree.js'
import { dispatchAttempt } from '../../src/poller/attempt-dispatcher.js'
import { NotificationDispatcher } from '../../src/notify/dispatcher.js'
import { createOrchestrationCache } from '../../src/runner/orchestration-cache.js'
import { initDatabase } from '../../src/state/db.js'
import { LeaseManager } from '../../src/state/leases.js'
import { RunManager } from '../../src/state/runs.js'

const mockExecuteLoop = vi.fn()
const mockFinalizeRunOutcome = vi.fn()
const mockCreateWorkerAdapter = vi.fn()
const mockExecuteRebase = vi.fn()

vi.mock('../../src/ops/rebase-and-check.js', () => ({
  executeRebase: (...args: unknown[]) => mockExecuteRebase(...args),
}))

vi.mock('../../src/loop/engine.js', () => ({
  executeLoop: (...args: unknown[]) => mockExecuteLoop(...args),
}))

vi.mock('../../src/runner/run-finalizer.js', () => ({
  finalizeRunOutcome: (...args: unknown[]) => mockFinalizeRunOutcome(...args),
}))

vi.mock('../../src/workers/factory.js', () => ({
  createWorkerAdapter: (...args: unknown[]) => mockCreateWorkerAdapter(...args),
}))

vi.mock('../../src/git/slug.js', () => ({
  getOrPinSlug: vi.fn().mockReturnValue('fix-replay'),
  buildWorktreePath: vi.fn().mockReturnValue('/tmp/night-orch-test-worktree'),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeConfig(dbPath: string): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath, worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: {
      maxReviewIterations: 4,
      maxTotalAgentPasses: 10,
      stopOnPlannerFailure: true,
      requireVerificationPass: true,
      reviewApprovalKeyword: 'APPROVED',
      reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
      blockOnAmbiguousReview: true,
      maxAutoRetries: 3,
      maxEmptyDiffRetries: 2,
      maxConsecutiveBlocks: 4,
      decompose: false,
      maxSubtasks: 5,
      maxConcurrentSubtasks: 3,
    },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    commentCommands: { enabled: true, requireCollaborator: false },
    repos: [{
      repo: 'org/repo',
      forge: 'github',
      localPath: '/tmp/repo',
      maxConcurrentRuns: 1,
      baseBranch: 'main',
      branchPrefix: 'orch',
      updateStrategy: 'merge',
      labels: {
        ready: ['no:ready'],
        running: 'no:running',
        blocked: ['no:blocked'],
        needsHuman: 'no:needs-human',
        reviewReady: 'no:review-ready',
        error: 'no:error',
        retry: 'no:retry',
        planning: 'no:planning',
      },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      planning: { prdDirectory: 'docs/prd' },
      verify: ['pnpm test'],
      selectors: { includeLabelsAny: ['no:ready'], excludeLabelsAny: [] },
      agents: { claude: 'claude' },
    }],
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null },
    workerProfiles: {
      claude: { type: 'claude', command: 'claude', args: ['-p'], workerTimeoutSeconds: 1800, minimalEnv: true, runtimeWrapper: null, env: {} },
    },
  } as Config
}

function makeIssue(labels: string[]): ForgeIssue {
  return {
    number: 1,
    nodeId: 'issue-1',
    repo: 'org/repo',
    title: 'Replay me',
    body: '',
    labels,
    assignees: [],
    state: 'open',
    createdAt: '2026-04-13T00:00:00Z',
    updatedAt: '2026-04-13T00:00:00Z',
    url: 'https://example.com/org/repo/issues/1',
  }
}

function makeForge(issue: ForgeIssue): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue(issue),
    addLabels: vi.fn().mockImplementation(async (_repo: string, _issueNumber: number, labels: string[]) => {
      for (const label of labels) {
        if (!issue.labels.includes(label)) issue.labels.push(label)
      }
    }),
    removeLabels: vi.fn().mockImplementation(async (_repo: string, _issueNumber: number, labels: string[]) => {
      issue.labels = issue.labels.filter((label) => !labels.includes(label))
    }),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
    updateComment: vi.fn().mockResolvedValue(undefined),
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn().mockResolvedValue(undefined),
    closePR: vi.fn().mockResolvedValue(undefined),
  } as unknown as ForgeAdapter
}

function makeWorktreeInfo(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: '/tmp/night-orch-test-worktree',
    branchName: 'orch/1-fix-replay',
    exists: true,
    isClean: true,
    rebaseConflict: false,
    ...overrides,
  }
}

describe('dispatchAttempt', () => {
  let tmpDir: string
  let db: Database.Database
  let config: Config
  let runManager: RunManager
  let leaseManager: LeaseManager
  let notifier: NotificationDispatcher
  let cache: ReturnType<typeof createOrchestrationCache>

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-attempt-dispatcher-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    config = makeConfig(join(tmpDir, 'test.db'))
    runManager = new RunManager(db)
    leaseManager = new LeaseManager(db)
    notifier = new NotificationDispatcher([], config.notifications.events)
    cache = createOrchestrationCache()
    mockCreateWorkerAdapter.mockReturnValue({})
    mockExecuteLoop.mockResolvedValue({})
    mockFinalizeRunOutcome.mockResolvedValue('processed')
    mockExecuteRebase.mockResolvedValue({ rebased: false, verifyPassed: true, verifyResults: [], conflict: false })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('dispatches normally when a queued control run exists', async () => {
    const issue = makeIssue(['no:review-ready'])
    const forge = makeForge(issue)
    runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const result = await dispatchAttempt({
      config,
      db,
      forge,
      repoConfig: config.repos[0]!,
      discoveredIssue: {
        issue,
        issueRepo: 'org/repo',
        triage: { level: 'standard', reason: '' },
        repoConfig: config.repos[0]!,
      },
      runManager,
      leaseManager,
      worktreeManager: {
        ensure: vi.fn().mockResolvedValue(makeWorktreeInfo()),
        remove: vi.fn(),
        list: vi.fn(),
      },
      notifier,
      observability: {
        record: vi.fn(),
        closeRun: vi.fn().mockResolvedValue(undefined),
      },
      botUser: '',
      usedPortsInPass: [],
      cache,
    })

    expect(result.outcome).toBe('processed')
    expect(mockExecuteLoop).toHaveBeenCalledTimes(1)
  })

  it('preserves existing blocked replay behavior', async () => {
    const issue = makeIssue(['no:blocked'])
    const forge = makeForge(issue)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: '2026-04-13T00:00:00Z',
      lastError: 'verify failed',
    })

    const result = await dispatchAttempt({
      config,
      db,
      forge,
      repoConfig: config.repos[0]!,
      discoveredIssue: {
        issue,
        issueRepo: 'org/repo',
        triage: { level: 'standard', reason: '' },
        repoConfig: config.repos[0]!,
      },
      runManager,
      leaseManager,
      worktreeManager: {
        ensure: vi.fn().mockResolvedValue(makeWorktreeInfo()),
        remove: vi.fn(),
        list: vi.fn(),
      },
      notifier,
      observability: {
        record: vi.fn(),
        closeRun: vi.fn().mockResolvedValue(undefined),
      },
      botUser: '',
      usedPortsInPass: [],
      cache,
    })

    expect(result.outcome).toBe('processed')
    expect(mockExecuteLoop).toHaveBeenCalledTimes(1)
  })

  it('blocks immediately when worktree is dirty before the loop starts', async () => {
    const issue = makeIssue(['no:ready'])
    const forge = makeForge(issue)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const result = await dispatchAttempt({
      config,
      db,
      forge,
      repoConfig: config.repos[0]!,
      discoveredIssue: {
        issue,
        issueRepo: 'org/repo',
        triage: { level: 'standard', reason: '' },
        repoConfig: config.repos[0]!,
      },
      runManager,
      leaseManager,
      worktreeManager: {
        ensure: vi.fn().mockResolvedValue(makeWorktreeInfo({ isClean: false })),
        remove: vi.fn(),
        list: vi.fn(),
      },
      notifier,
      observability: {
        record: vi.fn(),
        closeRun: vi.fn().mockResolvedValue(undefined),
      },
      botUser: '',
      usedPortsInPass: [],
      cache,
    })

    expect(result).toEqual({ outcome: 'errored', immediateFollowupRepo: 'org/repo' })
    expect(mockExecuteLoop).not.toHaveBeenCalled()

    const updated = runManager.getById(run.id)
    expect(updated?.status).toBe('blocked')
    expect(updated?.blockReason).toBe('verify_config')
    expect(updated?.lastError).toContain('worktree is dirty')
  })

  it('blocks immediately when worktree refresh conflicts before the loop starts', async () => {
    const issue = makeIssue(['no:ready'])
    const forge = makeForge(issue)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const result = await dispatchAttempt({
      config,
      db,
      forge,
      repoConfig: config.repos[0]!,
      discoveredIssue: {
        issue,
        issueRepo: 'org/repo',
        triage: { level: 'standard', reason: '' },
        repoConfig: config.repos[0]!,
      },
      runManager,
      leaseManager,
      worktreeManager: {
        ensure: vi.fn().mockResolvedValue(makeWorktreeInfo({ rebaseConflict: true })),
        remove: vi.fn(),
        list: vi.fn(),
      },
      notifier,
      observability: {
        record: vi.fn(),
        closeRun: vi.fn().mockResolvedValue(undefined),
      },
      botUser: '',
      usedPortsInPass: [],
      cache,
    })

    expect(result).toEqual({ outcome: 'errored', immediateFollowupRepo: 'org/repo' })
    expect(mockExecuteLoop).not.toHaveBeenCalled()

    const updated = runManager.getById(run.id)
    expect(updated?.status).toBe('blocked')
    expect(updated?.manualState).toBe('awaiting_rebase_resolution')
    expect(updated?.operationIntent).toBe('refresh')
    expect(updated?.phaseData?.reactionType).toBe('refresh_conflict')
    expect(updated?.controlPayload?.conflictSnapshot).toMatchObject({
      source: 'branch_refresh',
      strategy: 'merge',
      branchName: 'orch/1-fix-replay',
      baseBranch: 'main',
    })
  })

  it('does NOT mark review_ready on a rebase no-op when no PR exists', async () => {
    // Acceptance: an issue with no PR and no passing verify must never land in
    // review_ready via a rebase no-op ("Branch already up to date").
    const issue = makeIssue(['no:review-ready'])
    const forge = makeForge(issue)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    // Queued rebase run with no published PR.
    runManager.update(run.id, { operationIntent: 'rebase' })

    const result = await dispatchAttempt({
      config,
      db,
      forge,
      repoConfig: config.repos[0]!,
      discoveredIssue: {
        issue,
        issueRepo: 'org/repo',
        triage: { level: 'standard', reason: '' },
        repoConfig: config.repos[0]!,
      },
      runManager,
      leaseManager,
      worktreeManager: {
        ensure: vi.fn().mockResolvedValue(makeWorktreeInfo()),
        remove: vi.fn(),
        list: vi.fn(),
      },
      notifier,
      observability: {
        record: vi.fn(),
        closeRun: vi.fn().mockResolvedValue(undefined),
      },
      botUser: '',
      usedPortsInPass: [],
      cache,
    })

    // No-op falls through to the code loop instead of phantom review_ready.
    expect(mockExecuteLoop).toHaveBeenCalledTimes(1)
    const updated = runManager.getById(run.id)
    expect(updated?.status).not.toBe('review_ready')
    expect(result.outcome).toBe('processed')
  })

  it('marks review_ready on a rebase no-op when a PR already exists', async () => {
    const issue = makeIssue(['no:review-ready'])
    const forge = makeForge(issue)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, { operationIntent: 'rebase', prNumber: 42 })

    await dispatchAttempt({
      config,
      db,
      forge,
      repoConfig: config.repos[0]!,
      discoveredIssue: {
        issue,
        issueRepo: 'org/repo',
        triage: { level: 'standard', reason: '' },
        repoConfig: config.repos[0]!,
      },
      runManager,
      leaseManager,
      worktreeManager: {
        ensure: vi.fn().mockResolvedValue(makeWorktreeInfo()),
        remove: vi.fn(),
        list: vi.fn(),
      },
      notifier,
      observability: {
        record: vi.fn(),
        closeRun: vi.fn().mockResolvedValue(undefined),
      },
      botUser: '',
      usedPortsInPass: [],
      cache,
    })

    // With a published PR the no-op is genuinely review-ready — no code loop.
    expect(mockExecuteLoop).not.toHaveBeenCalled()
    const updated = runManager.getById(run.id)
    expect(updated?.status).toBe('review_ready')
  })
})
