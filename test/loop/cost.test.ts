import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CostTracker, describeBudgetBlock, costLimitRecoveryHint } from '../../src/loop/cost.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

describe('CostTracker', () => {
  let tmpDir: string
  let db: Database.Database
  let costTracker: CostTracker
  let runId: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-cost-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    costTracker = new CostTracker(db)

    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: 'n1',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runId = run.id
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records and retrieves run cost', () => {
    costTracker.recordCost(runId, 1.5)
    expect(costTracker.getRunCost(runId)).toBe(1.5)
  })

  it('accumulates cost', () => {
    costTracker.recordCost(runId, 1.0)
    costTracker.recordCost(runId, 0.5)
    expect(costTracker.getRunCost(runId)).toBe(1.5)
  })

  it('tracks daily cost', () => {
    costTracker.recordCost(runId, 2.0)
    expect(costTracker.getDailyCost()).toBe(2.0)
  })

  it('tracks token usage per run and per day', () => {
    costTracker.recordCost(runId, 0, { promptTokens: 120, completionTokens: 45 })

    expect(costTracker.getRunTokenUsage(runId)).toEqual({
      promptTokens: 120,
      completionTokens: 45,
      cacheReadTokens: 0,
      totalTokens: 165,
    })
    expect(costTracker.getDailyTokenUsage()).toEqual({
      promptTokens: 120,
      completionTokens: 45,
      cacheReadTokens: 0,
      totalTokens: 165,
    })
  })

  it('increments daily run_count once per run', () => {
    costTracker.recordCost(runId, 1.0)
    costTracker.recordCost(runId, 0.5)

    const today = new Date().toISOString().split('T')[0]
    const row = db
      .prepare('SELECT run_count FROM daily_costs WHERE date = ?')
      .get(today) as { run_count: number } | undefined

    expect(row?.run_count).toBe(1)
  })

  it('increments daily run_count once for token-only updates', () => {
    costTracker.recordCost(runId, 0, { promptTokens: 10, completionTokens: 5 })
    costTracker.recordCost(runId, 0, { promptTokens: 20, completionTokens: 2 })

    const today = new Date().toISOString().split('T')[0]
    const row = db
      .prepare('SELECT run_count FROM daily_costs WHERE date = ?')
      .get(today) as { run_count: number } | undefined

    expect(row?.run_count).toBe(1)
  })

  it('increments daily run_count once per UTC day for long-running runs', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-04-01T23:59:00.000Z'))
      costTracker.recordCost(runId, 1.0, { promptTokens: 10, completionTokens: 5 })
      costTracker.recordCost(runId, 0.5, { promptTokens: 20, completionTokens: 2 })

      vi.setSystemTime(new Date('2026-04-02T00:01:00.000Z'))
      costTracker.recordCost(runId, 0.25, { promptTokens: 7, completionTokens: 3 })

      const firstDay = db
        .prepare('SELECT run_count FROM daily_costs WHERE date = ?')
        .get('2026-04-01') as { run_count: number } | undefined
      const secondDay = db
        .prepare('SELECT run_count FROM daily_costs WHERE date = ?')
        .get('2026-04-02') as { run_count: number } | undefined

      expect(firstDay?.run_count).toBe(1)
      expect(secondDay?.run_count).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('checkBudget detects per-run budget exceeded and reports per-run limit', () => {
    costTracker.recordCost(runId, 11.0)
    const status = costTracker.checkBudget(runId, {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    })
    expect(status.overBudget).toBe(true)
    if (status.overBudget) {
      expect(status.limit).toBe('per-run')
      expect(status.actualUsd).toBe(11.0)
      expect(status.limitUsd).toBe(10)
    }
  })

  it('checkBudget detects daily budget exceeded and reports daily limit', () => {
    // Put the run at $0 so the per-run check does not pre-empt the daily one.
    // We need daily cost to grow without the run cost — seed daily_costs directly.
    const today = new Date().toISOString().split('T')[0]
    db.prepare(
      `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
       VALUES (?, ?, 0, 0, 0)`,
    ).run(today, 51.0)

    const status = costTracker.checkBudget(runId, {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 100,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    })
    expect(status.overBudget).toBe(true)
    if (status.overBudget) {
      expect(status.limit).toBe('daily')
      expect(status.actualUsd).toBe(51.0)
      expect(status.limitUsd).toBe(50)
    }
  })

  it('checkBudget reports per-run limit first when both caps are tripped', () => {
    costTracker.recordCost(runId, 11.0)
    const today = new Date().toISOString().split('T')[0]
    db.prepare(
      `UPDATE daily_costs SET total_cost_usd = 200 WHERE date = ?`,
    ).run(today)

    const status = costTracker.checkBudget(runId, {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    })
    expect(status.overBudget).toBe(true)
    if (status.overBudget) {
      // Per-run tripped first — it is the more specific and actionable signal.
      expect(status.limit).toBe('per-run')
    }
  })

  it('checkBudget returns under-budget when both caps have headroom', () => {
    costTracker.recordCost(runId, 5.0)
    const status = costTracker.checkBudget(runId, {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    })
    expect(status.overBudget).toBe(false)
  })

  it('describeBudgetBlock names the daily limit when that is what tripped', () => {
    const msg = describeBudgetBlock({
      overBudget: true,
      limit: 'daily',
      actualUsd: 30.7455,
      limitUsd: 25,
    })
    expect(msg).toBe('Daily cost limit exceeded: $30.75 >= $25.00')
  })

  it('describeBudgetBlock names the per-run limit when that is what tripped', () => {
    const msg = describeBudgetBlock({
      overBudget: true,
      limit: 'per-run',
      actualUsd: 8.12,
      limitUsd: 8,
    })
    expect(msg).toBe('Per-run cost limit exceeded: $8.12 >= $8.00')
  })

  it('costLimitRecoveryHint mentions the matching setting key', () => {
    expect(costLimitRecoveryHint('daily')).toContain('security.maxDailyCostUsd')
    expect(costLimitRecoveryHint('per-run')).toContain('security.maxCostPerRunUsd')
  })

  it('costLimitRecoveryHint for daily mentions the daily-cost-override command', () => {
    expect(costLimitRecoveryHint('daily')).toContain('daily-cost-override')
  })

  describe('subscription cost model', () => {
    const limits = {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    }

    it('never reports over-budget when the per-run cap would otherwise trip', () => {
      costTracker.recordCost(runId, 500)
      const status = costTracker.checkBudget(runId, limits, 'subscription')
      expect(status.overBudget).toBe(false)
    })

    it('never reports over-budget when the daily cap would otherwise trip', () => {
      const today = new Date().toISOString().split('T')[0]
      db.prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
         VALUES (?, ?, 0, 0, 0)`,
      ).run(today, 9999)
      const status = costTracker.checkBudget(runId, limits, 'subscription')
      expect(status.overBudget).toBe(false)
    })

    it('pay-per-use remains the default when cost model is omitted', () => {
      costTracker.recordCost(runId, 500)
      const status = costTracker.checkBudget(runId, limits)
      expect(status.overBudget).toBe(true)
    })
  })

  describe('run cost budget override', () => {
    const limits = {
      maxDailyCostUsd: 25,
      maxCostPerRunUsd: 8,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    }

    it('returns null override when none is set', () => {
      expect(costTracker.getRunBudgetOverride(runId)).toBeNull()
    })

    it('lets a run with an override exceed the original per-run cap', () => {
      costTracker.recordCost(runId, 9.0)
      expect(costTracker.checkBudget(runId, limits).overBudget).toBe(true)

      costTracker.setRunBudgetOverride(runId, 15)
      const status = costTracker.checkBudget(runId, limits)
      expect(status.overBudget).toBe(false)
      expect(costTracker.getRunBudgetOverride(runId)).toBe(15)
    })

    it('enforces the override as the new per-run cap', () => {
      costTracker.setRunBudgetOverride(runId, 10)
      costTracker.recordCost(runId, 11)
      const status = costTracker.checkBudget(runId, limits)
      expect(status.overBudget).toBe(true)
      if (status.overBudget) {
        expect(status.limit).toBe('per-run')
        expect(status.limitUsd).toBe(10)
      }
    })

    it('bypasses the daily cap for runs with an override', () => {
      const today = new Date().toISOString().split('T')[0]
      db.prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
         VALUES (?, ?, 0, 0, 0)`,
      ).run(today, 200)

      // Without override — blocked by daily cap.
      expect(costTracker.checkBudget(runId, limits).overBudget).toBe(true)

      // With override — under its own per-run cap and daily check is skipped.
      costTracker.setRunBudgetOverride(runId, 15)
      expect(costTracker.checkBudget(runId, limits).overBudget).toBe(false)
    })

    it('clears the override when set to null', () => {
      costTracker.setRunBudgetOverride(runId, 20)
      expect(costTracker.getRunBudgetOverride(runId)).toBe(20)
      costTracker.setRunBudgetOverride(runId, null)
      expect(costTracker.getRunBudgetOverride(runId)).toBeNull()
    })

    it('rejects non-positive or non-finite override values', () => {
      expect(() => costTracker.setRunBudgetOverride(runId, 0)).toThrow(/positive finite/)
      expect(() => costTracker.setRunBudgetOverride(runId, -5)).toThrow(/positive finite/)
      expect(() => costTracker.setRunBudgetOverride(runId, Number.NaN)).toThrow(/positive finite/)
      expect(() => costTracker.setRunBudgetOverride(runId, Number.POSITIVE_INFINITY)).toThrow(
        /positive finite/,
      )
    })
  })

  describe('daily cost cap override', () => {
    const limits = {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 100,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    }

    const today = (): string => new Date().toISOString().split('T')[0] as string

    it('returns null when no daily cap override is set', () => {
      expect(costTracker.getDailyCapOverride()).toBeNull()
    })

    it('lets the day exceed the base daily cap when override is higher', () => {
      db.prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
         VALUES (?, ?, 0, 0, 0)`,
      ).run(today(), 75)

      // Without override → blocked by base $50 cap.
      expect(costTracker.checkBudget(runId, limits).overBudget).toBe(true)

      // With override $200 → now under the effective cap.
      costTracker.setDailyCapOverride(200)
      const status = costTracker.checkBudget(runId, limits)
      expect(status.overBudget).toBe(false)
      expect(costTracker.getDailyCapOverride()).toBe(200)
    })

    it('reports the override value as limitUsd when the override is still exceeded', () => {
      db.prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
         VALUES (?, ?, 0, 0, 0)`,
      ).run(today(), 300)

      costTracker.setDailyCapOverride(200)
      const status = costTracker.checkBudget(runId, limits)
      expect(status.overBudget).toBe(true)
      if (status.overBudget) {
        expect(status.limit).toBe('daily')
        expect(status.limitUsd).toBe(200)
        expect(status.actualUsd).toBe(300)
      }
    })

    it('setDailyCapOverride creates a row when none exists', () => {
      costTracker.setDailyCapOverride(150)
      expect(costTracker.getDailyCapOverride()).toBe(150)
      expect(costTracker.getDailyCost()).toBe(0)
    })

    it('clears the override when set to null', () => {
      costTracker.setDailyCapOverride(150)
      expect(costTracker.getDailyCapOverride()).toBe(150)
      costTracker.setDailyCapOverride(null)
      expect(costTracker.getDailyCapOverride()).toBeNull()
    })

    it('recording cost does not wipe an existing daily cap override', () => {
      costTracker.setDailyCapOverride(150)
      costTracker.recordCost(runId, 3.0)
      expect(costTracker.getDailyCapOverride()).toBe(150)
      expect(costTracker.getDailyCost()).toBe(3.0)
    })

    it('does not leak override across UTC day rollover', () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'))
        costTracker.setDailyCapOverride(500)
        expect(costTracker.getDailyCapOverride('2026-04-01')).toBe(500)

        vi.setSystemTime(new Date('2026-04-02T12:00:00.000Z'))
        // Tomorrow has no override row yet → null.
        expect(costTracker.getDailyCapOverride()).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('per-run override still bypasses daily cap when a daily override is also set', () => {
      db.prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
         VALUES (?, ?, 0, 0, 0)`,
      ).run(today(), 1000)
      costTracker.setDailyCapOverride(100) // still under 1000, so would block
      costTracker.setRunBudgetOverride(runId, 20)

      const status = costTracker.checkBudget(runId, limits)
      expect(status.overBudget).toBe(false)
    })

    it('rejects non-positive or non-finite override values', () => {
      expect(() => costTracker.setDailyCapOverride(0)).toThrow(/positive finite/)
      expect(() => costTracker.setDailyCapOverride(-5)).toThrow(/positive finite/)
      expect(() => costTracker.setDailyCapOverride(Number.NaN)).toThrow(/positive finite/)
      expect(() => costTracker.setDailyCapOverride(Number.POSITIVE_INFINITY)).toThrow(/positive finite/)
    })
  })
})
