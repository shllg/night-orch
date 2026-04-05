import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { CostTracker } from '../../src/loop/cost.js'
import { setDailyCostCapOverride } from '../../src/ops/daily-cost-override.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('setDailyCostCapOverride', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-daily-override-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sets the override and returns the previous value (null on first set)', () => {
    const result = setDailyCostCapOverride(db, 250)
    expect(result.overrideUsd).toBe(250)
    expect(result.previousUsd).toBeNull()
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const tracker = new CostTracker(db)
    expect(tracker.getDailyCapOverride()).toBe(250)
  })

  it('returns the previous value when updating an existing override', () => {
    setDailyCostCapOverride(db, 100)
    const result = setDailyCostCapOverride(db, 300)
    expect(result.previousUsd).toBe(100)
    expect(result.overrideUsd).toBe(300)
  })

  it('clears the override when passed null', () => {
    setDailyCostCapOverride(db, 100)
    const result = setDailyCostCapOverride(db, null)
    expect(result.previousUsd).toBe(100)
    expect(result.overrideUsd).toBeNull()

    const tracker = new CostTracker(db)
    expect(tracker.getDailyCapOverride()).toBeNull()
  })

  it('rejects non-positive values', () => {
    expect(() => setDailyCostCapOverride(db, 0)).toThrow(/positive finite/)
    expect(() => setDailyCostCapOverride(db, -10)).toThrow(/positive finite/)
  })
})
