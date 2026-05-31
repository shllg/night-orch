import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncEngine, detectFinalizerOrphan } from '../../src/ops/sync.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { LeaseManager } from '../../src/state/leases.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { Config } from '../../src/config/schema.js'
import { makeTestConfig } from '../helpers/factories.js'
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
    `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, planner, coder, reviewer, started_at, ended_at, last_error, created_at, updated_at, pr_number, branch_name, worktree_path, phase_data)
     VALUES (@id, @repo, @issue_number, @issue_node_id, @status, @planner, @coder, @reviewer, @started_at, @ended_at, @last_error, @created_at, @updated_at, @pr_number, @branch_name, @worktree_path, @phase_data)`,
  ).run({
    pr_number: null,
    branch_name: null,
    worktree_path: null,
    phase_data: null,
    ended_at: null,
    last_error: null,
    ...defaults,
  })
  return id
}

/**
 * Build a phase_data JSON string carrying a terminal `__decisionOutcomes`
 * entry. Used by the orphan-finalizer tests to simulate the state a crashed
 * run leaves behind: engine recorded the decision, finalizer never wrote
 * the terminal run status.
 */
function phaseDataWithTerminalDecision(
  action: 'publish' | 'block' | 'error' | 'iterate',
  reason: string = 'test',
): string {
  return JSON.stringify({
    __completedPhases: ['plan', 'code', 'verify', 'review', 'decide'],
    __decisionOutcomes: { decide: { action, reason } },
  })
}

describe('SyncEngine', () => {
  let tmpDir: string
  let db: Database.Database
  let config: Config

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-sync-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    config = makeTestConfig({
      notifications: { channels: [] },
      repos: [{
        selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      }],
    })
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

  it('review_ready run + merged PR → completed', async () => {
    const forge = makeMockForge({
      getPR: vi.fn().mockResolvedValue({
        number: 10,
        title: 'Fix',
        body: '',
        state: 'merged',
        headBranch: 'orch/1-fix',
        headSha: 'sha-10',
        baseBranch: 'main',
        url: '',
      }),
    })
    const runId = insertRun(db, { status: 'review_ready', pr_number: 10, branch_name: 'orch/1-fix', last_error: 'stale publish error' })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('completed')
    expect(result.reconciledRuns[0]!.reason).toContain('review_ready')

    const row = db.prepare('SELECT status, last_error FROM runs WHERE id = ?').get(runId) as { status: string; last_error: string | null }
    expect(row.status).toBe('completed')
    expect(row.last_error).toBeNull()
  })

  it('running run + stale pr_number + open branch PR → review_ready (no requeue)', async () => {
    const notFound = Object.assign(new Error('Not found'), { status: 404 })
    const forge = makeMockForge({
      getPR: vi.fn().mockRejectedValue(notFound),
      findPRByBranch: vi.fn().mockResolvedValue({
        number: 11,
        title: 'Fix',
        body: '',
        state: 'open',
        headBranch: 'orch/1-fix',
        headSha: 'sha-11',
        baseBranch: 'main',
        url: '',
      }),
    })
    const runId = insertRun(db, { status: 'running', pr_number: 10, branch_name: 'orch/1-fix', last_error: 'stale verify error' })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('label_corrected')
    expect(result.reconciledRuns[0]!.reason).toContain('PR open but run stale')

    const row = db.prepare('SELECT status, last_error FROM runs WHERE id = ?').get(runId) as { status: string; last_error: string | null }
    expect(row.status).toBe('review_ready')
    expect(row.last_error).toBeNull()
  })

  it('blocked run + issue closed → completed', async () => {
    const forge = makeMockForge({
      getIssue: vi.fn().mockResolvedValue({
        number: 1, nodeId: '', title: 'Test', body: '', labels: [],
        assignees: [], state: 'closed', createdAt: '', updatedAt: '', url: '',
      }),
    })
    const runId = insertRun(db, { status: 'blocked' })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('closed')
    expect(result.reconciledRuns[0]!.reason).toContain('blocked')

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('completed')
  })

  it('error run + deleted issue (404) → completed', async () => {
    const notFound = Object.assign(new Error('Not found'), { status: 404 })
    const forge = makeMockForge({
      getIssue: vi.fn().mockRejectedValue(notFound),
    })
    const runId = insertRun(db, { status: 'error' })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(1)
    expect(result.reconciledRuns[0]!.action).toBe('closed')
    expect(result.reconciledRuns[0]!.reason).toContain('deleted')

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('completed')
  })

  it('non-terminal run + open issue remains unchanged', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked' })

    const engine = new SyncEngine(db, config, () => forge)
    const result = await engine.reconcile(false)

    expect(result.reconciledRuns).toHaveLength(0)

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('blocked')
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
    expect(result.labelCorrections[0]!.added).toContain('no:running')
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

  describe('finalizer-orphan detection', () => {
    it('queued run + terminal decide=publish + open issue → marked as error (finalizer_orphan)', async () => {
      const forge = makeMockForge()
      const runId = insertRun(db, {
        status: 'queued',
        pr_number: 42,
        branch_name: 'orch/1-fix',
        phase_data: phaseDataWithTerminalDecision('publish', 'Review approved'),
      })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(false)

      expect(result.reconciledRuns).toHaveLength(1)
      expect(result.reconciledRuns[0]!.action).toBe('finalizer_orphan')
      expect(result.reconciledRuns[0]!.reason).toContain('publish finalize')

      const row = db.prepare('SELECT status, ended_at, last_error FROM runs WHERE id = ?').get(runId) as { status: string; ended_at: string | null; last_error: string | null }
      expect(row.status).toBe('error')
      expect(row.ended_at).not.toBeNull()
      expect(row.last_error).toContain('Orphaned after process restart during publish finalize')
    })

    it('queued run + terminal decide=block + open issue → marked as error (finalizer_orphan)', async () => {
      const forge = makeMockForge()
      const runId = insertRun(db, {
        status: 'queued',
        phase_data: phaseDataWithTerminalDecision('block', 'cost cap'),
      })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(false)

      expect(result.reconciledRuns).toHaveLength(1)
      expect(result.reconciledRuns[0]!.action).toBe('finalizer_orphan')
      expect(result.reconciledRuns[0]!.reason).toContain('block finalize')

      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
      expect(row.status).toBe('error')
    })

    it('queued run + terminal decide=error + open issue → marked as error (finalizer_orphan)', async () => {
      const forge = makeMockForge()
      const runId = insertRun(db, {
        status: 'queued',
        phase_data: phaseDataWithTerminalDecision('error', 'loop exception'),
      })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(false)

      expect(result.reconciledRuns).toHaveLength(1)
      expect(result.reconciledRuns[0]!.action).toBe('finalizer_orphan')
      expect(result.reconciledRuns[0]!.reason).toContain('error finalize')

      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
      expect(row.status).toBe('error')
    })

    it('queued run + decide=iterate → NOT treated as orphan (iterate is not terminal)', async () => {
      const forge = makeMockForge()
      const runId = insertRun(db, {
        status: 'queued',
        phase_data: phaseDataWithTerminalDecision('iterate', 'next iteration'),
      })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(false)

      // No orphan, no issue-close → no reconcile action
      expect(result.reconciledRuns).toHaveLength(0)

      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
      expect(row.status).toBe('queued')
    })

    it('queued run with no __decisionOutcomes → falls through to existing issue-state check', async () => {
      // Regression guard for the existing behavior: issue still open, no
      // decisions persisted → reconciler leaves the row alone (poller will
      // pick it up on the next tick).
      const forge = makeMockForge()
      const runId = insertRun(db, { status: 'queued', phase_data: null })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(false)

      expect(result.reconciledRuns).toHaveLength(0)

      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
      expect(row.status).toBe('queued')
    })

    it('running run + terminal decide + no active lease → orphan (takes precedence over markReviewReady)', async () => {
      // This is the canonical #156 shape: dispatcher set status='running',
      // engine reached decide=publish, finalizer crashed mid-push, process
      // restarted → no lease. Orphan detection must fire BEFORE the stale-run
      // PR-state branch so the error message preserves the crash signature.
      const forge = makeMockForge({
        findPRByBranch: vi.fn().mockResolvedValue({ number: 42, state: 'open', title: 'Fix', body: '', headBranch: 'orch/1-fix', headSha: 'sha', baseBranch: 'main', url: '' }),
      })
      const runId = insertRun(db, {
        status: 'running',
        pr_number: 42,
        branch_name: 'orch/1-fix',
        phase_data: phaseDataWithTerminalDecision('publish'),
      })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(false)

      expect(result.reconciledRuns).toHaveLength(1)
      expect(result.reconciledRuns[0]!.action).toBe('finalizer_orphan')

      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
      expect(row.status).toBe('error')
    })

    it('run with ended_at set + terminal decide → NOT an orphan (already finalized)', async () => {
      // A properly-finalized run carries ended_at; the presence of terminal
      // __decisionOutcomes alone does not classify it as orphaned.
      const forge = makeMockForge()
      const runId = insertRun(db, {
        status: 'blocked',
        ended_at: new Date().toISOString(),
        phase_data: phaseDataWithTerminalDecision('block', 'ok'),
      })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(false)

      expect(result.reconciledRuns).toHaveLength(0)

      const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
      expect(row.status).toBe('blocked')
    })

    it('dry run with orphan → reports action, leaves DB untouched', async () => {
      const forge = makeMockForge()
      const runId = insertRun(db, {
        status: 'queued',
        phase_data: phaseDataWithTerminalDecision('publish'),
      })

      const engine = new SyncEngine(db, config, () => forge)
      const result = await engine.reconcile(true)

      expect(result.reconciledRuns).toHaveLength(1)
      expect(result.reconciledRuns[0]!.action).toBe('finalizer_orphan')

      const row = db.prepare('SELECT status, ended_at FROM runs WHERE id = ?').get(runId) as { status: string; ended_at: string | null }
      expect(row.status).toBe('queued')
      expect(row.ended_at).toBeNull()
    })
  })

  describe('detectFinalizerOrphan (pure helper)', () => {
    it('returns null when ended_at is set', () => {
      expect(
        detectFinalizerOrphan({
          ended_at: '2026-04-10T12:00:00Z',
          phase_data: phaseDataWithTerminalDecision('publish'),
        }),
      ).toBeNull()
    })

    it('returns null when phase_data is null', () => {
      expect(detectFinalizerOrphan({ ended_at: null, phase_data: null })).toBeNull()
    })

    it('returns null when phase_data is malformed JSON', () => {
      expect(detectFinalizerOrphan({ ended_at: null, phase_data: '{oops' })).toBeNull()
    })

    it('returns null when __decisionOutcomes is absent', () => {
      expect(
        detectFinalizerOrphan({ ended_at: null, phase_data: JSON.stringify({ plan: {} }) }),
      ).toBeNull()
    })

    it('returns the terminal decision when present and ended_at is null', () => {
      const result = detectFinalizerOrphan({
        ended_at: null,
        phase_data: phaseDataWithTerminalDecision('publish', 'ship'),
      })
      expect(result?.phase).toBe('decide')
      expect(result?.outcome.action).toBe('publish')
    })
  })
})
