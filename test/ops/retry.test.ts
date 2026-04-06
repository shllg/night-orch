import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RetryEngine } from '../../src/ops/retry.js'
import { transitionLabels } from '../../src/labels/manager.js'
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

vi.mock('../../src/runner/poller.js', () => ({
  pollOnce: vi.fn().mockResolvedValue({ processed: 1, errors: 0 }),
}))

vi.mock('../../src/labels/manager.js', () => ({
  transitionLabels: vi.fn().mockResolvedValue(undefined),
}))

function makeMockForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:error'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
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
    status: 'error',
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
    started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    last_error: 'Some error',
    ...overrides,
  }
  db.prepare(
    `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, planner, coder, reviewer, started_at, created_at, updated_at, ended_at, last_error, phase_data, current_phase)
     VALUES (@id, @repo, @issue_number, @issue_node_id, @status, @planner, @coder, @reviewer, @started_at, @created_at, @updated_at, @ended_at, @last_error, @phase_data, @current_phase)`,
  ).run({ phase_data: null, current_phase: 'plan', last_error: null, ended_at: null, ...defaults })
  return id
}

describe('RetryEngine', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-retry-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('blocked run → reset to queued, labels updated', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.getIssue).mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:blocked'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    })
    const runId = insertRun(db, { status: 'blocked' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1)

    const row = db.prepare('SELECT status, last_error, ended_at FROM runs WHERE id = ?').get(runId) as { status: string; last_error: string | null; ended_at: string | null }
    expect(row.status).toBe('queued')
    expect(row.last_error).toBeNull()
    expect(row.ended_at).toBeNull()
    expect(transitionLabels).toHaveBeenCalledWith(
      forge,
      'org/repo',
      1,
      ['orch:blocked'],
      'blocked',
      'queued',
      expect.any(Object),
    )
  })

  it('error run → reset to queued, labels updated', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'error' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1)

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('queued')
    expect(transitionLabels).toHaveBeenCalledWith(
      forge,
      'org/repo',
      1,
      ['orch:error'],
      'error',
      'queued',
      expect.any(Object),
    )
  })

  it('review_ready run → reset to queued (for another pass)', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.getIssue).mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:review-ready'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    })
    const runId = insertRun(db, { status: 'review_ready' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1)

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('queued')
  })

  it('--reset-plan clears stored plan', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'error', phase_data: JSON.stringify({ plan: 'old plan' }) })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1, { resetPlan: true })

    const row = db.prepare('SELECT phase_data FROM runs WHERE id = ?').get(runId) as { phase_data: string | null }
    expect(row.phase_data).toBeNull()
  })

  it('--immediate starts loop directly', async () => {
    const { pollOnce } = await import('../../src/runner/poller.js')
    const forge = makeMockForge()
    insertRun(db, { status: 'error' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1, { immediate: true })

    expect(pollOnce).toHaveBeenCalledWith(
      expect.any(Object),
      db,
      false,
      undefined,
      { repo: 'org/repo', issueNumber: 1 },
    )
  })

  it('non-existent run → clear error message', async () => {
    const forge = makeMockForge()
    const engine = new RetryEngine(db, makeConfig(), () => forge)

    await expect(engine.retry('org/repo', 999)).rejects.toThrow('No run found')
  })

  it('already-running run → reject with message', async () => {
    const forge = makeMockForge()
    insertRun(db, { status: 'running' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)

    await expect(engine.retry('org/repo', 1)).rejects.toThrow('currently running')
  })

  it('--dry-run does not modify DB', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'error' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1, { dryRun: true })

    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
    expect(row.status).toBe('error')
  })

  it('completed run → reject', async () => {
    const forge = makeMockForge()
    insertRun(db, { status: 'completed' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)

    await expect(engine.retry('org/repo', 1)).rejects.toThrow('can only retry')
  })
})
