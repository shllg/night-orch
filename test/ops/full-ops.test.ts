import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncEngine } from '../../src/ops/sync.js'
import { CleanupEngine } from '../../src/ops/cleanup.js'
import { RetryEngine } from '../../src/ops/retry.js'
import { initDatabase } from '../../src/state/db.js'
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
    remove: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../../src/labels/manager.js', () => ({
  transitionLabels: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/runner/poller.js', () => ({
  pollOnce: vi.fn().mockResolvedValue({ processed: 1, errors: 0 }),
}))

function makeMockForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:running'],
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
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [{
      repo: 'org/repo', forge: 'github', localPath: '/tmp/repo', baseBranch: 'main',
      branchPrefix: 'orch', labels: { ready: ['no:ready'], running: 'no:running', blocked: ['no:blocked'], reviewReady: 'no:review-ready', error: 'no:error', retry: 'no:retry' },
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
    `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, planner, coder, reviewer, started_at, created_at, updated_at, pr_number, branch_name, worktree_path, ended_at, last_error)
     VALUES (@id, @repo, @issue_number, @issue_node_id, @status, @planner, @coder, @reviewer, @started_at, @created_at, @updated_at, @pr_number, @branch_name, @worktree_path, @ended_at, @last_error)`,
  ).run({ pr_number: null, branch_name: null, worktree_path: null, ended_at: null, last_error: null, ...defaults })
  return id
}

describe('Full ops integration', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-full-ops-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('crash simulation: start run → sync detects stale → retry succeeds', async () => {
    const forge = makeMockForge()
    const config = makeConfig()

    // 1. Simulate a crashed run (status=running, no active lease)
    const runId = insertRun(db, { status: 'running' })

    // 2. Sync detects it as stale and requeues
    const syncEngine = new SyncEngine(db, config, () => forge)
    const syncResult = await syncEngine.reconcile(false)

    expect(syncResult.reconciledRuns).toHaveLength(1)
    expect(syncResult.reconciledRuns[0]!.action).toBe('stale_cleared')

    const afterSync = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(afterSync.status).toBe('queued')

    // 3. Retry picks it up (simulate error, then retry)
    db.prepare("UPDATE runs SET status = 'error', last_error = 'test error', ended_at = datetime('now') WHERE id = ?").run(runId)

    vi.mocked(forge.getIssue).mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:error'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    })

    const retryEngine = new RetryEngine(db, config, () => forge)
    await retryEngine.retry('org/repo', 1)

    // Previous attempt is frozen; new head attempt is queued.
    const prev = db
      .prepare('SELECT status, terminated_at FROM runs WHERE id = ?')
      .get(runId) as { status: string; terminated_at: string | null }
    expect(prev.status).toBe('error')
    expect(prev.terminated_at).not.toBeNull()

    const head = db
      .prepare(
        `SELECT status, previous_attempt_id, intent FROM runs
         WHERE repo = ? AND issue_number = ?
         ORDER BY sequence_number DESC, created_at DESC
         LIMIT 1`,
      )
      .get('org/repo', 1) as { status: string; previous_attempt_id: string | null; intent: string }
    expect(head.status).toBe('queued')
    expect(head.previous_attempt_id).toBe(runId)
    expect(head.intent).toBe('retry')
  })

  it('cleanup after completed run', async () => {
    const config = makeConfig()

    // Insert a completed run with a worktree
    insertRun(db, { status: 'completed', worktree_path: '/tmp/wt/org-repo-1', ended_at: new Date().toISOString() })

    const engine = new CleanupEngine(db, config)
    const result = await engine.run({ completedWorktrees: true, dryRun: true })

    // Worktree would be flagged for removal (mock list returns empty, so no actual match)
    expect(result).toHaveProperty('removedWorktrees')
    expect(result).toHaveProperty('expiredLeases')
  })

  it('sync + cleanup pipeline', async () => {
    const forge = makeMockForge({
      findPRByBranch: vi.fn().mockResolvedValue({ number: 10, state: 'merged', title: 'Fix', body: '', headBranch: 'orch/1-fix', headSha: 'sha-10', baseBranch: 'main', url: '' }),
    })
    const config = makeConfig()

    // Insert a stale running run with PR
    insertRun(db, { status: 'running', pr_number: 10, branch_name: 'orch/1-fix', worktree_path: '/tmp/wt/1' })

    // 1. Sync marks it completed (PR merged)
    const syncEngine = new SyncEngine(db, config, () => forge)
    const syncResult = await syncEngine.reconcile(false)
    expect(syncResult.reconciledRuns[0]!.action).toBe('completed')

    // 2. Cleanup can now remove its worktree
    const cleanupEngine = new CleanupEngine(db, config)
    const cleanupResult = await cleanupEngine.run({ completedWorktrees: true, dryRun: true })
    expect(cleanupResult).toHaveProperty('removedWorktrees')
  })
})
