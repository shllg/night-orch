import { describe, it, expect, beforeEach } from 'vitest'
import { SummaryEngine, parseSinceArg } from '../../src/ops/summary.js'
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
    estimated_cost_usd: 1.0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    ...overrides,
  }
  db.prepare(`
    INSERT INTO runs (id, repo, issue_number, status, planner, coder, reviewer, estimated_cost_usd, created_at, updated_at, ended_at, pr_number, block_reason)
    VALUES (@id, @repo, @issue_number, @status, @planner, @coder, @reviewer, @estimated_cost_usd, @created_at, @updated_at, @ended_at, @pr_number, @block_reason)
  `).run({ pr_number: null, block_reason: null, ...defaults })
  return defaults.id
}

describe('parseSinceArg', () => {
  it('parses "24h"', () => {
    const date = parseSinceArg('24h')
    const diff = Date.now() - date.getTime()
    expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(diff).toBeLessThan(25 * 60 * 60 * 1000)
  })

  it('parses "7d"', () => {
    const date = parseSinceArg('7d')
    const diff = Date.now() - date.getTime()
    expect(diff).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    expect(diff).toBeLessThan(8 * 24 * 60 * 60 * 1000)
  })

  it('parses "1w"', () => {
    const date = parseSinceArg('1w')
    const diff = Date.now() - date.getTime()
    expect(diff).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
  })

  it('parses ISO date', () => {
    const date = parseSinceArg('2026-01-01T00:00:00Z')
    expect(date.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('throws on invalid input', () => {
    expect(() => parseSinceArg('invalid')).toThrow('Cannot parse time range')
  })
})

describe('SummaryEngine', () => {
  let db: ReturnType<typeof initDatabase>

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('counts runs by status since given time', () => {
    insertRun(db, { status: 'completed' })
    insertRun(db, { status: 'completed' })
    insertRun(db, { status: 'blocked', block_reason: 'cost_limit' })
    insertRun(db, { status: 'error' })

    const engine = new SummaryEngine(db)
    const result = engine.summarize({ since: new Date(Date.now() - 60 * 60 * 1000) })

    expect(result.runs.started).toBe(4)
    expect(result.runs.completed).toBe(2)
    expect(result.runs.blocked).toBe(1)
    expect(result.runs.errored).toBe(1)
  })

  it('calculates total cost', () => {
    insertRun(db, { estimated_cost_usd: 2.5 })
    insertRun(db, { estimated_cost_usd: 1.75 })

    const engine = new SummaryEngine(db)
    const result = engine.summarize({ since: new Date(Date.now() - 60 * 60 * 1000) })

    expect(result.totalCostUsd).toBe(4.25)
  })

  it('counts PRs created', () => {
    insertRun(db, { pr_number: 10 })
    insertRun(db, { pr_number: null })

    const engine = new SummaryEngine(db)
    const result = engine.summarize({ since: new Date(Date.now() - 60 * 60 * 1000) })

    expect(result.prsCreated).toBe(1)
  })

  it('lists currently blocked issues', () => {
    insertRun(db, { status: 'blocked', issue_number: 42, block_reason: 'cost_limit' })

    const engine = new SummaryEngine(db)
    const result = engine.summarize({ since: new Date(Date.now() - 60 * 60 * 1000) })

    expect(result.currentBlocked).toHaveLength(1)
    expect(result.currentBlocked[0]!.issueNumber).toBe(42)
    expect(result.currentBlocked[0]!.blockReason).toBe('cost_limit')
  })

  it('filters by repo when specified', () => {
    insertRun(db, { repo: 'org/repo-a' })
    insertRun(db, { repo: 'org/repo-b' })

    const engine = new SummaryEngine(db)
    const result = engine.summarize({ since: new Date(Date.now() - 60 * 60 * 1000), repo: 'org/repo-a' })

    expect(result.runs.started).toBe(1)
  })

  it('returns empty results when no runs', () => {
    const engine = new SummaryEngine(db)
    const result = engine.summarize({ since: new Date(Date.now() - 60 * 60 * 1000) })

    expect(result.runs.started).toBe(0)
    expect(result.totalCostUsd).toBe(0)
    expect(result.prsCreated).toBe(0)
  })
})
