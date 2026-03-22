import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollOnce } from '../../src/runner/poller.js'
import { initDatabase } from '../../src/state/db.js'
import type { Config } from '../../src/config/schema.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockDiscoverEligibleIssues = vi.fn().mockResolvedValue([])
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
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
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
})
