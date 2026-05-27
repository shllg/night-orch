import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CostTracker } from '../../src/loop/cost.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import type { Config } from '../../src/config/schema.js'

const SECURITY: Config['security'] = {
  maxChangedFiles: 50,
  maxChangedLines: 5000,
  maxDailyCostUsd: 10,
  maxCostPerRunUsd: 8,
}

function costConfig(overrides: Partial<Config['cost']>): Config['cost'] {
  return {
    model: 'subscription',
    subscriptionMetered: { advisoryThresholdUsd: null, enforcePerRunLimit: false, enforceDailyLimit: false },
    allowEstimatedDuration: false,
    ...overrides,
  } as Config['cost']
}

describe('cost layer 2 (theoretical) + subscription quota', () => {
  let tmpDir: string
  let db: Database.Database
  let costTracker: CostTracker
  let runId: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-cost-theo-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    costTracker = new CostTracker(db)
    const run = new RunManager(db).create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: 'n1',
      planner: 'claude',
      coder: 'codex',
      reviewer: 'codex',
    })
    runId = run.id
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records theoretical cost separately from real cost ($0 under subscription)', () => {
    costTracker.recordCost(runId, 0, { promptTokens: 1000, completionTokens: 500 }, {
      stepId: 'code',
      theoreticalCostUsd: 5.25,
    })
    expect(costTracker.getRunCost(runId)).toBe(0)
    expect(costTracker.getRunTheoreticalCost(runId)).toBeCloseTo(5.25, 6)
    expect(costTracker.getDailyTheoreticalCost()).toBeCloseTo(5.25, 6)
  })

  it('defaults theoretical to real cost when not supplied (pay-per-use parity)', () => {
    costTracker.recordCost(runId, 2, { promptTokens: 10 }, { stepId: 'code' })
    expect(costTracker.getRunCost(runId)).toBe(2)
    expect(costTracker.getRunTheoreticalCost(runId)).toBe(2)
  })

  it('reports quota exhausted once monthly theoretical exceeds includedUsd', () => {
    const cfg = costConfig({ subscriptionQuota: { includedUsd: 4, period: 'month', onExhausted: 'warn' } })
    costTracker.recordCost(runId, 0, { promptTokens: 1 }, { stepId: 'code', theoreticalCostUsd: 6 })
    const status = costTracker.getSubscriptionQuotaStatus(cfg)
    expect(status?.exhausted).toBe(true)
    expect(status?.overageUsd).toBeCloseTo(2, 6)
  })

  it('warn mode never blocks even when quota is blown', () => {
    const cfg = costConfig({ subscriptionQuota: { includedUsd: 1, period: 'month', onExhausted: 'warn' } })
    costTracker.recordCost(runId, 0, { promptTokens: 1 }, { stepId: 'code', theoreticalCostUsd: 100 })
    expect(costTracker.checkBudget(runId, SECURITY, cfg).overBudget).toBe(false)
  })

  it('enforce mode blocks on daily cap once overage exceeds maxDailyCostUsd', () => {
    const cfg = costConfig({ subscriptionQuota: { includedUsd: 1, period: 'month', onExhausted: 'enforce' } })
    // overage = 100 - 1 = 99 >= maxDailyCostUsd (10) → block
    costTracker.recordCost(runId, 0, { promptTokens: 1 }, { stepId: 'code', theoreticalCostUsd: 100 })
    const status = costTracker.checkBudget(runId, SECURITY, cfg)
    expect(status.overBudget).toBe(true)
    if (status.overBudget) {
      expect(status.limit).toBe('daily')
      expect(status.actualUsd).toBeCloseTo(99, 6)
    }
  })

  it('enforce mode stays under budget while quota has headroom', () => {
    const cfg = costConfig({ subscriptionQuota: { includedUsd: 1000, period: 'month', onExhausted: 'enforce' } })
    costTracker.recordCost(runId, 0, { promptTokens: 1 }, { stepId: 'code', theoreticalCostUsd: 5 })
    expect(costTracker.checkBudget(runId, SECURITY, cfg).overBudget).toBe(false)
  })

  it('quota is ignored for non-subscription models', () => {
    const cfg = costConfig({ model: 'pay-per-use', subscriptionQuota: { includedUsd: 1, period: 'month', onExhausted: 'enforce' } })
    costTracker.recordCost(runId, 0, { promptTokens: 1 }, { stepId: 'code', theoreticalCostUsd: 100 })
    expect(costTracker.getSubscriptionQuotaStatus(cfg)).toBeNull()
  })
})
