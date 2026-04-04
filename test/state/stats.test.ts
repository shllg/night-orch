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
    expect(stats.reliability.failureCount7d).toBe(0)
    expect(stats.cost.model).toBe('pay-per-use')
    expect(stats.cost.todayCostUsd).toBe(0)
    expect(stats.usage.todayTotalTokens).toBe(0)
    expect(stats.efficiency.avgCostPerRun7d).toBe(0)
    expect(stats.efficiency.avgTokensPerRun7d).toBe(0)
    expect(stats.resources.activeLeases).toBe(0)
    expect(stats.timing.sampleSize30d).toBe(0)
    expect(stats.queue.activeBatches).toBe(0)
    expect(stats.agents.eventsTotal).toBe(0)
    expect(stats.topRepos30d).toEqual([])
  })

  it('aggregates run, cost, queue, and agent stats from the database', () => {
    const now = Date.now()
    const oneHourAgo = iso(now - (1 * 60 * 60 * 1000))
    const tenMinutesAgo = iso(now - (10 * 60 * 1000))
    const tenMinutesFromNow = iso(now + (10 * 60 * 1000))
    const oneHourFromNow = iso(now + (1 * 60 * 60 * 1000))
    const oneDayAgo = iso(now - (24 * 60 * 60 * 1000))
    const oneDayAgoPlusThirtyMinutes = iso(now - (24 * 60 * 60 * 1000) + (30 * 60 * 1000))
    const twoDaysAgo = iso(now - (2 * 24 * 60 * 60 * 1000))
    const twoDaysAgoPlusFortyFiveMinutes = iso(now - (2 * 24 * 60 * 60 * 1000) + (45 * 60 * 1000))
    const thirtyFiveDaysAgo = iso(now - (35 * 24 * 60 * 60 * 1000))

    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, status, current_phase, iteration_count, estimated_cost_usd, prompt_tokens, completion_tokens, started_at, ended_at,
        last_error, block_reason, worktree_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    insertRun.run(
      'run-1',
      'org/repo-a',
      1,
      'completed',
      'publish',
      2,
      4.2,
      900,
      300,
      twoDaysAgo,
      twoDaysAgoPlusFortyFiveMinutes,
      null,
      null,
      '/tmp/wt-repo-a-1',
      twoDaysAgo,
      oneHourAgo,
    )
    insertRun.run(
      'run-2',
      'org/repo-a',
      2,
      'error',
      'code',
      1,
      1.5,
      200,
      100,
      oneDayAgo,
      oneDayAgoPlusThirtyMinutes,
      'API timeout after 30s while calling provider',
      null,
      '/tmp/wt-repo-a-2',
      oneDayAgo,
      oneHourAgo,
    )
    insertRun.run(
      'run-3',
      'org/repo-b',
      3,
      'running',
      'plan',
      0,
      0.4,
      100,
      50,
      oneHourAgo,
      null,
      null,
      null,
      '/tmp/wt-repo-b-3',
      oneHourAgo,
      oneHourAgo,
    )
    insertRun.run(
      'run-4',
      'org/repo-b',
      4,
      'queued',
      'plan',
      0,
      0,
      0,
      0,
      oneHourAgo,
      null,
      null,
      null,
      null,
      oneHourAgo,
      oneHourAgo,
    )
    insertRun.run(
      'run-5',
      'org/repo-c',
      5,
      'blocked',
      'review',
      3,
      2,
      50,
      25,
      thirtyFiveDaysAgo,
      oneDayAgo,
      null,
      'Lease expired for issue 5',
      '/tmp/wt-repo-c-5',
      thirtyFiveDaysAgo,
      oneDayAgo,
    )

    const today = dateOnly(now)
    const yesterday = dateOnly(now - (24 * 60 * 60 * 1000))
    db.prepare(
      'INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens) VALUES (?, ?, ?, ?, ?)',
    ).run(today, 12.5, 2, 1500, 500)
    db.prepare(
      'INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens) VALUES (?, ?, ?, ?, ?)',
    ).run(yesterday, 3.5, 1, 400, 100)

    const insertLease = db.prepare(
      'INSERT INTO leases (repo, issue_number, lease_owner, leased_until) VALUES (?, ?, ?, ?)',
    )
    insertLease.run('org/repo-a', 1, 'worker-a', oneHourFromNow)
    insertLease.run('org/repo-b', 3, 'worker-b', tenMinutesFromNow)
    insertLease.run('org/repo-c', 5, 'worker-c', tenMinutesAgo)

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
    expect(stats.overview.activeRuns).toBe(4)
    expect(stats.overview.completedRuns).toBe(1)
    expect(stats.overview.errorRuns).toBe(1)
    expect(stats.overview.blockedRuns).toBe(1)

    expect(stats.throughput.runs7d).toBe(4)
    expect(stats.throughput.runs30d).toBe(4)
    expect(stats.throughput.completed7d).toBe(1)
    expect(stats.throughput.error7d).toBe(1)
    expect(stats.throughput.successRate7d).toBeCloseTo(50, 5)
    expect(stats.reliability.failureCount7d).toBe(1)
    expect(stats.reliability.failureRate7d).toBeCloseTo(50, 5)
    expect(stats.reliability.topErrorPatterns7d).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          count: 1,
          pattern: expect.stringContaining('API timeout after 30s'),
        }),
      ]),
    )

    expect(stats.cost.todayCostUsd).toBeCloseTo(12.5, 5)
    expect(stats.cost.cost7d).toBeCloseTo(16, 5)
    expect(stats.cost.todayRunCount).toBe(2)
    expect(stats.cost.dailyHistory.length).toBe(2)
    expect(stats.usage.todayTotalTokens).toBe(2000)
    expect(stats.usage.tokens7d).toBe(2500)
    expect(stats.usage.avgDailyTokens7d).toBe(1250)
    expect(stats.usage.dailyHistory.length).toBe(2)
    expect(stats.efficiency.totalCostUsd7d).toBeCloseTo(6.1, 5)
    expect(stats.efficiency.avgCostPerRun7d).toBeCloseTo(1.525, 5)
    expect(stats.efficiency.avgCostPerSuccess7d).toBeCloseTo(6.1, 5)
    expect(stats.efficiency.avgCostPerIteration7d).toBeCloseTo(6.1 / 3, 5)
    expect(stats.efficiency.completedPerDollar7d).toBeCloseTo(1 / 6.1, 5)
    expect(stats.efficiency.avgTokensPerRun7d).toBeCloseTo(1650 / 4, 5)
    expect(stats.efficiency.avgTokensPerSuccess7d).toBeCloseTo(1650, 5)
    expect(stats.efficiency.avgTokensPerIteration7d).toBeCloseTo(1650 / 3, 5)

    expect(stats.resources.activeLeases).toBe(2)
    expect(stats.resources.expiringLeases).toBe(1)
    expect(stats.resources.expiredLeases).toBe(1)
    expect(stats.resources.leasedRepos).toBe(2)
    expect(stats.resources.activeWorktrees).toBe(3)
    expect(stats.resources.missingWorktrees).toBe(1)
    expect(stats.resources.staleWorktrees).toBe(1)

    expect(stats.timing.sampleSize30d).toBe(2)
    expect(stats.timing.p50Minutes).toBeCloseTo(37.5, 5)
    expect(stats.timing.p90Minutes).toBeCloseTo(43.5, 5)
    expect(stats.timing.p99Minutes).toBeCloseTo(44.85, 5)

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
