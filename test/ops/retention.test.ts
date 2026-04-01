import { describe, it, expect, beforeEach } from 'vitest'
import { RetentionEngine } from '../../src/ops/retention.js'
import { initDatabase } from '../../src/state/db.js'

let nextIssueNumber = 1

function insertRun(db: ReturnType<typeof initDatabase>, overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: `run-${Math.random().toString(36).slice(2)}`,
    repo: 'org/repo',
    issue_number: nextIssueNumber++,
    status: 'completed',
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
    phase_data: JSON.stringify({ plan: 'test plan' }),
    estimated_cost_usd: 1.5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    ...overrides,
  }
  db.prepare(`
    INSERT INTO runs (id, repo, issue_number, status, planner, coder, reviewer, phase_data, estimated_cost_usd, created_at, updated_at, ended_at)
    VALUES (@id, @repo, @issue_number, @status, @planner, @coder, @reviewer, @phase_data, @estimated_cost_usd, @created_at, @updated_at, @ended_at)
  `).run(defaults)
  return defaults.id
}

function insertEvent(db: ReturnType<typeof initDatabase>, runId: string) {
  db.prepare("INSERT INTO events (run_id, event_type, phase, created_at) VALUES (?, 'phase_completed', 'code', datetime('now'))").run(runId)
}

describe('RetentionEngine', () => {
  let db: ReturnType<typeof initDatabase>

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('compacts phase_data for runs older than detailDays but newer than archiveDays', () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() // 45 days ago
    const runId = insertRun(db, { ended_at: oldDate })
    insertEvent(db, runId)

    const engine = new RetentionEngine(db)
    const result = engine.prune({ detailDays: 30, archiveDays: 90, vacuum: false, dryRun: false })

    expect(result.compactedRuns).toBe(1)
    expect(result.deletedRuns).toBe(0)
    expect(result.deletedEvents).toBe(1)

    // Check phase_data was compacted
    const row = db.prepare('SELECT phase_data FROM runs WHERE id = ?').get(runId) as { phase_data: string }
    const data = JSON.parse(row.phase_data) as { compacted: boolean }
    expect(data.compacted).toBe(true)
  })

  it('deletes runs older than archiveDays', () => {
    const veryOldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() // 100 days ago
    const runId = insertRun(db, { ended_at: veryOldDate })
    insertEvent(db, runId)

    const engine = new RetentionEngine(db)
    const result = engine.prune({ detailDays: 30, archiveDays: 90, vacuum: false, dryRun: false })

    expect(result.deletedRuns).toBe(1)
    expect(result.deletedEvents).toBe(1)

    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
    expect(row).toBeUndefined()
  })

  it('does not touch recent runs', () => {
    const recentDate = new Date().toISOString()
    insertRun(db, { ended_at: recentDate })

    const engine = new RetentionEngine(db)
    const result = engine.prune({ detailDays: 30, archiveDays: 90, vacuum: false, dryRun: false })

    expect(result.compactedRuns).toBe(0)
    expect(result.deletedRuns).toBe(0)
  })

  it('does not delete blocked or running runs', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    insertRun(db, { ended_at: oldDate, status: 'blocked' })
    insertRun(db, { ended_at: oldDate, status: 'running' })

    const engine = new RetentionEngine(db)
    const result = engine.prune({ detailDays: 30, archiveDays: 90, vacuum: false, dryRun: false })

    expect(result.deletedRuns).toBe(0)
  })

  it('dry run returns counts without modifying data', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    insertRun(db, { ended_at: oldDate })

    const engine = new RetentionEngine(db)
    const result = engine.prune({ detailDays: 30, archiveDays: 90, vacuum: false, dryRun: true })

    expect(result.deletedRuns).toBe(1)

    // Data still exists
    const count = db.prepare('SELECT COUNT(*) as c FROM runs').get() as { c: number }
    expect(count.c).toBe(1)
  })
})
