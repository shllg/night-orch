import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollOnce } from '../../src/runner/poller.js'
import { initDatabase } from '../../src/state/db.js'
import type { Config } from '../../src/config/schema.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { RunManager } from '../../src/state/runs.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockDiscoverEligibleIssues = vi.fn().mockResolvedValue([])
const mockCommentOnIssue = vi.fn().mockResolvedValue(undefined)
const mockListIssueComments = vi.fn().mockResolvedValue([])
const mockIsCollaborator = vi.fn().mockResolvedValue(true)
vi.mock('../../src/discovery/discover.js', () => ({
  discoverEligibleIssues: (...args: unknown[]) => mockDiscoverEligibleIssues(...args),
}))

vi.mock('../../src/forge/factory.js', () => ({
  createForgeAdapter: vi.fn().mockReturnValue({
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 1,
      nodeId: '',
      title: 'Test',
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
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
    listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
    isCollaborator: (...args: unknown[]) => mockIsCollaborator(...args),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
  }),
}))

vi.mock('../../src/notify/factory.js', () => ({
  createChannels: vi.fn().mockReturnValue([]),
}))

vi.mock('../../src/notify/dispatcher.js', () => {
  class MockNotificationDispatcher {
    dispatch = vi.fn().mockResolvedValue({ sent: [] })
  }
  return { NotificationDispatcher: MockNotificationDispatcher }
})

vi.mock('../../src/labels/manager.js', () => ({
  transitionLabels: vi.fn().mockResolvedValue(undefined),
}))

const mockExecuteLoop = vi.fn()
vi.mock('../../src/loop/engine.js', () => ({
  executeLoop: (...args: unknown[]) => mockExecuteLoop(...args),
}))

const mockPublishPR = vi.fn()
vi.mock('../../src/publishing/publisher.js', () => ({
  publishPR: (...args: unknown[]) => mockPublishPR(...args),
}))

vi.mock('../../src/workers/factory.js', () => ({
  createWorkerAdapter: vi.fn().mockReturnValue({
    runTask: vi.fn(),
    checkAvailability: vi.fn(),
  }),
}))

vi.mock('../../src/git/worktree.js', () => ({
  createWorktreeManager: () => ({
    ensure: vi.fn().mockResolvedValue({ path: '/tmp/wt', branchName: 'orch/1-fix', exists: true, isClean: true }),
    remove: vi.fn(),
    list: vi.fn(),
  }),
}))

vi.mock('../../src/state/leases.js', () => {
  const actual = vi.importActual('../../src/state/leases.js')
  return actual
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

function makeConfig(dbPath: string): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath, worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    commentCommands: { enabled: true, requireCollaborator: false },
    repos: [{
      repo: 'org/repo', forge: 'github', localPath: '/tmp/repo', maxConcurrentRuns: 1, baseBranch: 'main',
      branchPrefix: 'orch', labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry', planning: 'orch:planning' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      planning: { prdDirectory: 'docs/prd' },
      verify: ['pnpm test'], selectors: { includeLabelsAny: [], excludeLabelsAny: [] }, agents: { claude: 'claude' },
    }],
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null },
    workerProfiles: {
      claude: { type: 'claude', command: 'claude', args: ['-p'], workerTimeoutSeconds: 1800, minimalEnv: true, runtimeWrapper: null, env: {} },
    },
  } as Config
}

describe('pollOnce', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-poller-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('no eligible issues → logs and returns zero', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('dry run logs discovered issues without processing', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, true)

    // Dry run doesn't process
    expect(result.processed).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('error in discovery → propagates as rejection', async () => {
    mockDiscoverEligibleIssues.mockRejectedValueOnce(new Error('API error'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    // Discovery errors propagate — caller (run command) handles them
    await expect(pollOnce(config, db, false)).rejects.toThrow('API error')
  })

  it('returns PollResult shape', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result).toHaveProperty('processed')
    expect(result).toHaveProperty('errors')
    expect(typeof result.processed).toBe('number')
    expect(typeof result.errors).toBe('number')
  })

  it('uses terminalStatus for blocked runs even when currentPhase is publish', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
    expect(mockPublishPR).not.toHaveBeenCalled()

    const row = db.prepare('SELECT status FROM runs ORDER BY created_at DESC LIMIT 1').get() as { status: string }
    expect(row.status).toBe('blocked')
  })

  it('reuses existing queued run instead of creating a new run', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const runManager = new RunManager(db)
    const existing = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const rows = db.prepare('SELECT id FROM runs WHERE repo = ? AND issue_number = ?').all('org/repo', 1) as Array<{ id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(existing.id)
  })

  it('denies /orch retry from non-collaborator when requireCollaborator=true', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockListIssueComments.mockResolvedValue([
      {
        id: 5001,
        body: '/orch retry',
        user: 'external-user',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ])
    mockIsCollaborator.mockResolvedValue(false)

    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.commentCommands = { enabled: true, requireCollaborator: true }
    await pollOnce(config, db, false)

    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string }
    expect(row.status).toBe('blocked')
    expect(mockIsCollaborator).toHaveBeenCalledWith('org/repo', 'external-user')

    const commandRow = db
      .prepare('SELECT command FROM command_tracking WHERE repo = ? AND issue_number = ? AND comment_id = ?')
      .get('org/repo', 1, 5001) as { command: string } | undefined
    expect(commandRow?.command).toBe('retry:denied')
  })

  it('applies /orch retry from collaborator when requireCollaborator=true', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockListIssueComments.mockResolvedValue([
      {
        id: 5002,
        body: '/orch retry',
        user: 'collaborator-user',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ])
    mockIsCollaborator.mockResolvedValue(true)

    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 2,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.commentCommands = { enabled: true, requireCollaborator: true }
    await pollOnce(config, db, false)

    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string }
    expect(row.status).toBe('queued')
    expect(mockIsCollaborator).toHaveBeenCalledWith('org/repo', 'collaborator-user')

    const commandRow = db
      .prepare('SELECT command FROM command_tracking WHERE repo = ? AND issue_number = ? AND comment_id = ?')
      .get('org/repo', 2, 5002) as { command: string } | undefined
    expect(commandRow?.command).toBe('retry:applied')
  })

  it('continues scanning comment commands when one issue comment fetch returns 404', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockListIssueComments.mockImplementation(async (_repo: string, issueNumber: number) => {
      if (issueNumber === 1) {
        throw Object.assign(new Error('Not Found'), { status: 404 })
      }
      if (issueNumber === 2) {
        return [
          {
            id: 5003,
            body: '/orch retry',
            user: 'collaborator-user',
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ]
      }
      return []
    })

    const runManager = new RunManager(db)
    const staleRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(staleRun.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const retryRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 2,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(retryRun.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const staleRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(staleRun.id) as { status: string }
    const retryRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(retryRun.id) as { status: string }
    expect(staleRow.status).toBe('blocked')
    expect(retryRow.status).toBe('queued')
    expect(mockListIssueComments).toHaveBeenCalledWith('org/repo', 1)
    expect(mockListIssueComments).toHaveBeenCalledWith('org/repo', 2)

    const commandRow = db
      .prepare('SELECT command FROM command_tracking WHERE repo = ? AND issue_number = ? AND comment_id = ?')
      .get('org/repo', 2, 5003) as { command: string } | undefined
    expect(commandRow?.command).toBe('retry:applied')
  })

  it('returns error when publish fails', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'completed',
      terminalStatus: 'publish',
    })
    mockPublishPR.mockRejectedValueOnce(new Error('publish failed'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(1)
    const row = db.prepare('SELECT status FROM runs ORDER BY created_at DESC LIMIT 1').get() as { status: string }
    expect(row.status).toBe('error')
  })

  it('posts a night-orch plan summary comment through the loop onPlanReady hook', async () => {
    const callOrder: string[] = []
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockCommentOnIssue.mockImplementation(async () => {
      callOrder.push('comment')
    })
    mockExecuteLoop.mockImplementationOnce(async (initialCtx: Record<string, unknown>, deps: { onPlanReady?: (ctx: Record<string, unknown>) => Promise<void> }) => {
      callOrder.push('executeLoop')
      expect(typeof deps.onPlanReady).toBe('function')
      await deps.onPlanReady?.({
        ...initialCtx,
        plan: {
          objective: 'Ship the requested issue change',
          assumptions: [],
          filesToChange: ['src/loop/engine.ts'],
          steps: [{ order: 1, description: 'Wire plan summary hook', files: ['src/loop/engine.ts'] }],
          risks: [],
          testStrategy: 'Run test suite',
        },
      })
      callOrder.push('afterOnPlanReady')
      return {
        currentPhase: 'publish',
        terminalStatus: 'blocked',
      }
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    expect(mockCommentOnIssue).toHaveBeenCalled()
    const planCommentCall = mockCommentOnIssue.mock.calls.find(
      (call) => typeof call[2] === 'string' && call[2].includes('[night-orch] Plan Summary'),
    )
    expect(planCommentCall).toBeDefined()
    expect(planCommentCall?.[0]).toBe('org/repo')
    expect(planCommentCall?.[1]).toBe(1)
    const planCommentBody = planCommentCall?.[2]
    expect(typeof planCommentBody).toBe('string')
    expect(planCommentBody).toContain('**Automated comment** posted by **night-orch**')
    expect(callOrder).toEqual(['executeLoop', 'comment', 'afterOnPlanReady'])
  })

  it('processes the next eligible issue in the same poll cycle', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 1, nodeId: '', title: 'First', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 2, nodeId: '', title: 'Second', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(2)

    const firstCallCtx = mockExecuteLoop.mock.calls[0]?.[0] as { issueNumber: number }
    const secondCallCtx = mockExecuteLoop.mock.calls[1]?.[0] as { issueNumber: number }
    expect(firstCallCtx.issueNumber).toBe(1)
    expect(secondCallCtx.issueNumber).toBe(2)

    const runs = db
      .prepare('SELECT issue_number, status FROM runs ORDER BY created_at')
      .all() as Array<{ issue_number: number; status: string }>
    expect(runs).toEqual([
      { issue_number: 1, status: 'blocked' },
      { issue_number: 2, status: 'blocked' },
    ])
  })

  it('processes one issue per repo in parallel by default', async () => {
    const config = makeConfig(join(tmpDir, 'test.db'))
    config.repos = [
      {
        ...config.repos[0]!,
        repo: 'org/repo-a',
        localPath: '/tmp/repo-a',
      },
      {
        ...config.repos[0]!,
        repo: 'org/repo-b',
        localPath: '/tmp/repo-b',
      },
    ]

    mockDiscoverEligibleIssues.mockImplementation(async (repoConfig: { repo: string }) => {
      if (repoConfig.repo === 'org/repo-a') {
        return [{
          issue: { number: 1, nodeId: '', title: 'A', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
          triage: { level: 'standard', reason: '' },
        }]
      }
      return [{
        issue: { number: 2, nodeId: '', title: 'B', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      }]
    })

    const issue1Gate = deferred<void>()
    const issue2Gate = deferred<void>()
    mockExecuteLoop.mockImplementation(async (ctx: { issueNumber: number }) => {
      if (ctx.issueNumber === 1) {
        await issue1Gate.promise
      } else if (ctx.issueNumber === 2) {
        await issue2Gate.promise
      }
      return {
        currentPhase: 'publish',
        terminalStatus: 'blocked',
      }
    })

    const pollPromise = pollOnce(config, db, false)
    await waitForCondition(() => mockExecuteLoop.mock.calls.length === 2)

    issue1Gate.resolve()
    issue2Gate.resolve()

    const result = await pollPromise
    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(2)

    const reposStarted = new Set(
      mockExecuteLoop.mock.calls.map((call) => (call[0] as { repo: string }).repo),
    )
    expect(reposStarted).toEqual(new Set(['org/repo-a', 'org/repo-b']))
  })

  it('respects repos[].maxConcurrentRuns for per-repo parallelism', async () => {
    const config = makeConfig(join(tmpDir, 'test.db'))
    config.repos[0]!.maxConcurrentRuns = 2

    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 1, nodeId: '', title: 'First', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 2, nodeId: '', title: 'Second', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 3, nodeId: '', title: 'Third', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])

    const gate1 = deferred<void>()
    const gate2 = deferred<void>()
    const gate3 = deferred<void>()
    mockExecuteLoop.mockImplementation(async (ctx: { issueNumber: number }) => {
      if (ctx.issueNumber === 1) await gate1.promise
      if (ctx.issueNumber === 2) await gate2.promise
      if (ctx.issueNumber === 3) await gate3.promise
      return {
        currentPhase: 'publish',
        terminalStatus: 'blocked',
      }
    })

    const pollPromise = pollOnce(config, db, false)

    await waitForCondition(() => mockExecuteLoop.mock.calls.length === 2)
    const firstWaveIssues = mockExecuteLoop.mock.calls
      .slice(0, 2)
      .map((call) => (call[0] as { issueNumber: number }).issueNumber)
    expect(firstWaveIssues.sort((a, b) => a - b)).toEqual([1, 2])

    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(mockExecuteLoop).toHaveBeenCalledTimes(2)

    gate1.resolve()
    await waitForCondition(() => mockExecuteLoop.mock.calls.length === 3)

    gate2.resolve()
    gate3.resolve()

    const result = await pollPromise
    expect(result.processed).toBe(3)
    expect(result.errors).toBe(0)
  })

  it('processes only the targeted issue when targetIssue is provided', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 1, nodeId: '', title: 'First', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 2, nodeId: '', title: 'Second', body: '', labels: ['orch:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false, undefined, { repo: 'org/repo', issueNumber: 2 })

    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
    const run = db
      .prepare('SELECT issue_number FROM runs ORDER BY created_at DESC LIMIT 1')
      .get() as { issue_number: number }
    expect(run.issue_number).toBe(2)
  })
})
