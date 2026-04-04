import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CostTracker } from '../../src/loop/cost.js'
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
      totalTokens: 165,
    })
    expect(costTracker.getDailyTokenUsage()).toEqual({
      promptTokens: 120,
      completionTokens: 45,
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

  it('detects per-run budget exceeded', () => {
    costTracker.recordCost(runId, 11.0)
    expect(costTracker.isOverBudget(runId, {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    })).toBe(true)
  })

  it('detects daily budget exceeded', () => {
    costTracker.recordCost(runId, 51.0)
    expect(costTracker.isOverBudget(runId, {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 100,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    })).toBe(true)
  })

  it('under budget returns false', () => {
    costTracker.recordCost(runId, 5.0)
    expect(costTracker.isOverBudget(runId, {
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
      maxChangedFiles: 50,
      maxChangedLines: 5000,
    })).toBe(false)
  })
})
