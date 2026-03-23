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

function makeConfig(dbPath: string): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath, worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [{
      repo: 'org/repo', forge: 'github', localPath: '/tmp/repo', baseBranch: 'main',
      branchPrefix: 'orch', labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: ['pnpm test'], selectors: { includeLabelsAny: [], excludeLabelsAny: [] }, agents: { claude: 'claude' }, maxConcurrentRuns: 1,
    }],
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null },
    workerProfiles: {
      claude: { type: 'claude', command: 'claude', args: ['-p'], workerTimeoutSeconds: 1800, minimalEnv: true, runtimeWrapper: null, env: {} },
    },
  } as Config
}

function makeDiscoveredIssue(issueNumber: number, title: string): {
  issue: {
    number: number
    nodeId: string
    title: string
    body: string
    labels: string[]
    assignees: string[]
    state: 'open'
    createdAt: string
    updatedAt: string
    url: string
  }
  triage: { level: 'standard'; reason: string }
} {
  return {
    issue: {
      number: issueNumber,
      nodeId: '',
      title,
      body: '',
      labels: ['orch:ready'],
      assignees: [],
      state: 'open',
      createdAt: '',
      updatedAt: '',
      url: '',
    },
    triage: { level: 'standard', reason: '' },
  }
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

  it('defaults to one run per repo per poll cycle', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      makeDiscoveredIssue(1, 'First'),
      makeDiscoveredIssue(2, 'Second'),
    ])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
    const rows = db
      .prepare('SELECT issue_number FROM runs ORDER BY issue_number ASC')
      .all() as Array<{ issue_number: number }>
    expect(rows).toEqual([{ issue_number: 1 }])
  })

  it('processes up to repo maxConcurrentRuns issues per poll cycle', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      makeDiscoveredIssue(1, 'First'),
      makeDiscoveredIssue(2, 'Second'),
      makeDiscoveredIssue(3, 'Third'),
    ])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.repos[0]!.maxConcurrentRuns = 2
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    const rows = db
      .prepare('SELECT issue_number FROM runs ORDER BY issue_number ASC')
      .all() as Array<{ issue_number: number }>
    expect(rows).toEqual([{ issue_number: 1 }, { issue_number: 2 }])
  })

  it('runs one issue per configured repo in parallel by default', async () => {
    mockDiscoverEligibleIssues.mockImplementation(async (repoConfig: { repo: string }) => {
      if (repoConfig.repo === 'org/repo') {
        return [makeDiscoveredIssue(1, 'Repo 1 issue')]
      }
      return [makeDiscoveredIssue(2, 'Repo 2 issue')]
    })

    let inFlight = 0
    let maxInFlight = 0
    mockExecuteLoop.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inFlight -= 1
      return {
        currentPhase: 'publish',
        terminalStatus: 'blocked',
      }
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.repos.push({
      repo: 'other/repo',
      forge: 'github',
      localPath: '/tmp/other-repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: ['pnpm test'],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: { claude: 'claude' },
      maxConcurrentRuns: 1,
    })

    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(maxInFlight).toBeGreaterThan(1)
    const rows = db
      .prepare('SELECT repo, issue_number FROM runs ORDER BY repo ASC, issue_number ASC')
      .all() as Array<{ repo: string; issue_number: number }>
    expect(rows).toEqual([
      { repo: 'org/repo', issue_number: 1 },
      { repo: 'other/repo', issue_number: 2 },
    ])
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
