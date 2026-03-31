import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { loadTuiStats } from '../../src/state/stats.js'

describe('loadTuiStats', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-stats-'))
    db = initDatabase(join(tmpDir, 'stats.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns zeroed aggregates on empty tables', () => {
    const stats = loadTuiStats(db)

    expect(stats.overview.totalRuns).toBe(0)
    expect(stats.overview.activeRuns).toBe(0)
    expect(stats.throughput.runs7d).toBe(0)
    expect(stats.cost.todayCostUsd).toBe(0)
    expect(stats.queue.activeBatches).toBe(0)
    expect(stats.agents.eventsTotal).toBe(0)
    expect(stats.topRepos30d).toEqual([])
  })

  it('aggregates run, cost, queue, and agent stats from the database', () => {
    const now = Date.now()
    const oneHourAgo = iso(now - (1 * 60 * 60 * 1000))
    const twoHoursAgo = iso(now - (2 * 60 * 60 * 1000))
    const oneDayAgo = iso(now - (24 * 60 * 60 * 1000))
    const twoDaysAgo = iso(now - (2 * 24 * 60 * 60 * 1000))
    const thirtyFiveDaysAgo = iso(now - (35 * 24 * 60 * 60 * 1000))

    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, status, current_phase, iteration_count, estimated_cost_usd, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    insertRun.run('run-1', 'org/repo-a', 1, 'completed', 'publish', 2, 4.2, twoHoursAgo, oneHourAgo, twoDaysAgo, oneHourAgo)
    insertRun.run('run-2', 'org/repo-a', 2, 'error', 'code', 1, 1.5, oneDayAgo, oneHourAgo, oneDayAgo, oneHourAgo)
    insertRun.run('run-3', 'org/repo-b', 3, 'running', 'plan', 0, 0.4, oneHourAgo, null, oneHourAgo, oneHourAgo)
    insertRun.run('run-4', 'org/repo-b', 4, 'queued', 'plan', 0, 0, oneHourAgo, null, oneHourAgo, oneHourAgo)
    insertRun.run('run-5', 'org/repo-c', 5, 'blocked', 'review', 3, 2, thirtyFiveDaysAgo, oneDayAgo, thirtyFiveDaysAgo, oneDayAgo)

    const today = dateOnly(now)
    const yesterday = dateOnly(now - (24 * 60 * 60 * 1000))
    db.prepare('INSERT INTO daily_costs (date, total_cost_usd, run_count) VALUES (?, ?, ?)').run(today, 12.5, 2)
    db.prepare('INSERT INTO daily_costs (date, total_cost_usd, run_count) VALUES (?, ?, ?)').run(yesterday, 3.5, 1)

    db.prepare(
      `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, pr_numbers, approved_shas, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('batch-1', 'org/repo-a', 'main', 'abc', 'pending', '[1,2]', '[]', oneHourAgo, oneHourAgo)
    db.prepare(
      `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, pr_numbers, approved_shas, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('batch-2', 'org/repo-a', 'main', 'abc', 'passed', '[3]', '[]', oneHourAgo, oneHourAgo)

    const insertEvent = db.prepare(
      'INSERT INTO agent_events (run_id, phase, role, event_type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insertEvent.run('run-3', 'plan', 'coder', 'tool_call', '{"toolName":"Read"}', oneHourAgo)
    insertEvent.run('run-3', 'plan', 'coder', 'thinking', '{"text":"working"}', oneHourAgo)
    insertEvent.run('run-1', 'code', 'reviewer', 'text', '{"text":"done"}', twoDaysAgo)

    const stats = loadTuiStats(db)

    expect(stats.overview.totalRuns).toBe(5)
    expect(stats.overview.activeRuns).toBe(2)
    expect(stats.overview.completedRuns).toBe(1)
    expect(stats.overview.errorRuns).toBe(1)
    expect(stats.overview.blockedRuns).toBe(1)

    expect(stats.throughput.runs7d).toBe(4)
    expect(stats.throughput.runs30d).toBe(4)
    expect(stats.throughput.completed7d).toBe(1)
    expect(stats.throughput.error7d).toBe(1)
    expect(stats.throughput.successRate7d).toBeCloseTo(50, 5)

    expect(stats.cost.todayCostUsd).toBeCloseTo(12.5, 5)
    expect(stats.cost.cost7d).toBeCloseTo(16, 5)
    expect(stats.cost.todayRunCount).toBe(2)
    expect(stats.cost.dailyHistory.length).toBe(2)

    expect(stats.queue.activeBatches).toBe(1)
    expect(stats.queue.statuses).toEqual([{ status: 'pending', count: 1 }])

    expect(stats.agents.eventsTotal).toBe(3)
    expect(stats.agents.events24h).toBe(2)
    expect(stats.agents.toolCalls24h).toBe(1)
    expect(stats.agents.thinking24h).toBe(1)
    expect(stats.agents.uniqueRuns7d).toBe(2)
    expect(stats.agents.roleBreakdown7d).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'coder', events: 2 }),
        expect.objectContaining({ role: 'reviewer', events: 1 }),
      ]),
    )

    expect(stats.topRepos30d).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: 'org/repo-a', totalRuns: 2 }),
        expect.objectContaining({ repo: 'org/repo-b', totalRuns: 2 }),
      ]),
    )
  })
})

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function dateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
