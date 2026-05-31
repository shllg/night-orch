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
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:error'],
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

/**
 * Return the head attempt row for a given issue (highest sequence_number,
 * broken by created_at). Post-R0c, retry inserts a new row instead of
 * mutating the previous one, so tests assert against the new head.
 */
function fetchHead(db: Database.Database, repo: string, issueNumber: number): {
  id: string
  status: string
  last_error: string | null
  ended_at: string | null
  phase_data: string | null
  previous_attempt_id: string | null
  sequence_number: number
  intent: string
  estimated_cost_usd: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
} {
  return db
    .prepare(
      `SELECT id, status, last_error, ended_at, phase_data, previous_attempt_id,
              sequence_number, intent, estimated_cost_usd, prompt_tokens,
              completion_tokens, cache_read_tokens
       FROM runs
       WHERE repo = ? AND issue_number = ?
       ORDER BY sequence_number DESC, created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(repo, issueNumber) as {
    id: string
    status: string
    last_error: string | null
    ended_at: string | null
    phase_data: string | null
    previous_attempt_id: string | null
    sequence_number: number
    intent: string
    estimated_cost_usd: number
    prompt_tokens: number
    completion_tokens: number
    cache_read_tokens: number
  }
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

  it('blocked run → new attempt queued, previous frozen, labels updated', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.getIssue).mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:blocked'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    })
    const runId = insertRun(db, { status: 'blocked' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1)

    // Previous attempt stays at its historical state and becomes frozen.
    const prev = db
      .prepare('SELECT status, terminated_at FROM runs WHERE id = ?')
      .get(runId) as { status: string; terminated_at: string | null }
    expect(prev.status).toBe('blocked')
    expect(prev.terminated_at).not.toBeNull()

    // New head is a fresh queued attempt linked to the previous one.
    const head = fetchHead(db, 'org/repo', 1)
    expect(head.id).not.toBe(runId)
    expect(head.status).toBe('queued')
    expect(head.last_error).toBeNull()
    expect(head.ended_at).toBeNull()
    expect(head.previous_attempt_id).toBe(runId)
    expect(head.sequence_number).toBe(2)
    expect(head.intent).toBe('retry')

    expect(transitionLabels).toHaveBeenCalledWith(
      forge,
      'org/repo',
      1,
      ['no:blocked'],
      'blocked',
      'queued',
      expect.any(Object),
    )
  })

  it('error run → new attempt queued, previous frozen, labels updated', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'error' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1)

    const prev = db
      .prepare('SELECT status, terminated_at FROM runs WHERE id = ?')
      .get(runId) as { status: string; terminated_at: string | null }
    expect(prev.status).toBe('error')
    expect(prev.terminated_at).not.toBeNull()

    const head = fetchHead(db, 'org/repo', 1)
    expect(head.id).not.toBe(runId)
    expect(head.status).toBe('queued')
    expect(head.previous_attempt_id).toBe(runId)

    expect(transitionLabels).toHaveBeenCalledWith(
      forge,
      'org/repo',
      1,
      ['no:error'],
      'error',
      'queued',
      expect.any(Object),
    )
  })

  it('review_ready run → new attempt queued for another pass', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.getIssue).mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:review-ready'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    })
    const runId = insertRun(db, { status: 'review_ready' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1)

    const head = fetchHead(db, 'org/repo', 1)
    expect(head.id).not.toBe(runId)
    expect(head.status).toBe('queued')
    expect(head.previous_attempt_id).toBe(runId)
  })

  it('--reset-plan seeds the new attempt phase_data with the retry marker', async () => {
    const forge = makeMockForge()
    insertRun(db, { status: 'error', phase_data: JSON.stringify({ plan: 'old plan' }) })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1, { resetPlan: true })

    const head = fetchHead(db, 'org/repo', 1)
    expect(head.phase_data).not.toBeNull()
    expect(JSON.parse(head.phase_data ?? '{}')).toMatchObject({
      reactionType: 'retry',
      reactionSummary: 'Fresh retry requested',
    })
  })

  it('new attempt starts with zero cost/token accumulators', async () => {
    const forge = makeMockForge()
    insertRun(db, {
      status: 'error',
      estimated_cost_usd: 15.5,
      prompt_tokens: 1000,
      completion_tokens: 500,
      cache_read_tokens: 100,
    })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1)

    const head = fetchHead(db, 'org/repo', 1)
    expect(head.estimated_cost_usd).toBe(0)
    expect(head.prompt_tokens).toBe(0)
    expect(head.completion_tokens).toBe(0)
    expect(head.cache_read_tokens).toBe(0)
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

  it('persists strategy override and records a user action event', async () => {
    const forge = makeMockForge()
    insertRun(db, { status: 'error' })

    const engine = new RetryEngine(db, makeConfig(), () => forge)
    await engine.retry('org/repo', 1, { strategyOverride: 'merge', actor: 'web' })

    const head = fetchHead(db, 'org/repo', 1)
    expect(JSON.parse(head.phase_data ?? '{}')).toMatchObject({
      reactionType: 'retry',
    })

    const controlRow = db.prepare(
      `SELECT control_payload
       FROM runs
       WHERE id = ?`,
    ).get(head.id) as { control_payload: string | null }
    expect(JSON.parse(controlRow.control_payload ?? '{}')).toMatchObject({
      updateStrategy: 'merge',
    })

    const eventRow = db.prepare(
      `SELECT source, role, event_type, data
       FROM run_log_events
       WHERE run_id = ?`,
    ).get(head.id) as { source: string; role: string | null; event_type: string; data: string | null }
    expect(eventRow.source).toBe('user')
    expect(eventRow.role).toBe('web')
    expect(eventRow.event_type).toBe('user_action')
    expect(JSON.parse(eventRow.data ?? '{}')).toMatchObject({
      kind: 'retry',
      actor: 'web',
      strategy: 'merge',
    })
  })
})
