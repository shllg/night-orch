import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncEngine } from '../../src/ops/sync.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { LeaseManager } from '../../src/state/leases.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { Config } from '../../src/config/schema.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../src/git/worktree.js', () => ({
  createWorktreeManager: () => ({
    list: vi.fn().mockResolvedValue([]),
    ensure: vi.fn(),
    remove: vi.fn(),
  }),
}))

vi.mock('../../src/labels/manager.js', () => ({
  transitionLabels: vi.fn().mockResolvedValue(undefined),
}))

function makeMockForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:running'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn().mockResolvedValue(null),
    getPRDiff: vi.fn(),
    ...overrides,
  }
}

function makeConfig(): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [{
      repo: 'org/repo', forge: 'github', localPath: '/tmp/repo', baseBranch: 'main',
      branchPrefix: 'orch', labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: [], selectors: { includeLabelsAny: [], excludeLabelsAny: [] }, agents: {},
    }],
  } as Config
}

function insertRun(db: Database.Database, overrides: Record<string, unknown> = {}): string {
  const id = `run-${Math.random().toString(36).slice(2, 8)}`
  const defaults = {
    id,
    repo: 'org/repo',
    issue_number: 1,
    issue_node_id: 'node1',
    status: 'running',
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
    started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
  db.prepare(
    `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, planner, coder, reviewer, started_at, created_at, updated_at, pr_number, branch_name, worktree_path)
     VALUES (@id, @repo, @issue_number, @issue_node_id, @status, @planner, @coder, @reviewer, @started_at, @created_at, @updated_at, @pr_number, @branch_name, @worktree_path)`,
  ).run({ pr_number: null, branch_name: null, worktree_path: null, ...defaults })
  return id
}

describe('SyncEngine', () => {
  let tmpDir: string
  let db: Database.Database
  let config: Config

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-sync-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    config = makeConfig()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('running run + PR merged → completed', async () => {
    const forge = makeMockForge({
      findPRByBranch: vi.fn().mockResolvedValue({ number: 10, state: 'merged', title: 'Fix', body: '', headBranch: 'orch/1-fix', headSha: 'sha-10', baseBranch: 'main', url: '' }),
    })
    const runId = insertRun(db, { pr_number: 10, branch_name: 'orch/1-fix' })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('completed')

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('completed')
  })

  it('running run + issue closed → completed', async () => {
    const forge = makeMockForge({
      getIssue: vi.fn().mockResolvedValue({
        number: 1, nodeId: '', title: 'Test', body: '', labels: [],
        assignees: [], state: 'closed', createdAt: '', updatedAt: '', url: '',
      }),
    })
    const runId = insertRun(db)

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('closed')

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('completed')
  })

  it('queued run + issue closed → completed', async () => {
    const forge = makeMockForge({
      getIssue: vi.fn().mockResolvedValue({
        number: 1, nodeId: '', title: 'Test', body: '', labels: [],
        assignees: [], state: 'closed', createdAt: '', updatedAt: '', url: '',
      }),
    })
    const runId = insertRun(db, { status: 'queued' })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('closed')
    expect(result.reconciledRuns[0]!.reason).toContain('queued')

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('completed')
  })

  it('running run + expired lease + no PR → queued (retry)', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db)
    // No lease means it's expired

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('stale_cleared')

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('queued')
  })

  it('running run + labels missing → labels corrected', async () => {
    const forge = makeMockForge({
      getIssue: vi.fn().mockResolvedValue({
        number: 1, nodeId: '', title: 'Test', body: '', labels: [],
        assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
      }),
    })
    // Insert a running run WITH an active lease (so it's not stale)
    insertRun(db)
    const leaseManager = new LeaseManager(db)
    leaseManager.acquire('org/repo', 1, 'poller', 7200)

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    // No stale runs (lease is active), but label mismatch detected
    expect(result.reconciledRuns).toHaveLength(0)
    expect(result.labelCorrections).toHaveLength(1)
    expect(result.labelCorrections[0]!.added).toContain('orch:running')
  })

  it('completed run → no change', async () => {
    const forge = makeMockForge()
    insertRun(db, { status: 'completed', ended_at: new Date().toISOString() })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(0)
  })

  it('dry run → reports actions without mutations', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db)

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(true)

    expect(result.reconciledRuns).toHaveLength(1)

    // DB should NOT be modified
    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('running')
  })
})
