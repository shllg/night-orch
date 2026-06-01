import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import {
  applyEstimatedWorkerCost,
  checkRunawayBudget,
  describeRunawayBudgetBlock,
  runawayLimitToBlockReason,
} from '../../../src/loop/cost/budget-guard.js'
import type { CostTracker } from '../../../src/loop/cost.js'
import type { RunContext } from '../../../src/loop/types.js'
import { initDatabase } from '../../../src/state/db.js'
import { RunManager } from '../../../src/state/runs.js'
import { makeTestConfig } from '../../helpers/factories.js'

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-1',
    repo: 'org/repo',
    issueNumber: 42,
    issue: {
      number: 42,
      nodeId: 'issue-node',
      repo: 'org/repo',
      title: 'Fix AFK path',
      body: '',
      labels: [],
      assignees: [],
      state: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://example.com/org/repo/issues/42',
    },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/42-fix-afk-path',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'code',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    diffError: null,
    emptyDiffRetries: 0,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
    ...overrides,
  }
}

function fakeCostTracker(overrides: Partial<CostTracker> = {}): CostTracker {
  return {
    getRunTokenUsage: vi.fn().mockReturnValue({
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    }),
    getDailyTokenUsage: vi.fn().mockReturnValue({
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    }),
    recordCostAndCheckBudget: vi.fn().mockReturnValue({ overBudget: false }),
    ...overrides,
  } as unknown as CostTracker
}

describe('budget-guard', () => {
  let tmpDir: string
  let db: Database.Database
  let runManager: RunManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-budget-guard-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    runManager = new RunManager(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports run token exhaustion before broader issue or daily token limits', () => {
    const status = checkRunawayBudget(
      db,
      fakeCostTracker({
        getRunTokenUsage: vi.fn().mockReturnValue({ totalTokens: 60 }),
        getDailyTokenUsage: vi.fn().mockReturnValue({ totalTokens: 500 }),
      }),
      makeCtx(),
      makeTestConfig({
        loop: {
          maxRunTokens: 50,
          maxIssueTokens: 10,
          maxDailyTokens: 10,
        },
      }).loop,
    )

    expect(status).toEqual({
      overBudget: true,
      limit: 'run_tokens',
      actual: 60,
      threshold: 50,
    })
  })

  it('sums prior top-level attempts for issue token exhaustion', () => {
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 42,
      issueNodeId: 'issue-node',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      promptTokens: 7,
      completionTokens: 4,
      cacheReadTokens: 2,
    })

    const status = checkRunawayBudget(
      db,
      fakeCostTracker(),
      makeCtx({ runId: run.id }),
      makeTestConfig({ loop: { maxIssueTokens: 10 } }).loop,
    )

    expect(status.overBudget).toBe(true)
    expect(status.limit).toBe('issue_tokens')
    expect(status.actual).toBe(13)
    expect(status.threshold).toBe(10)
  })

  it('reports run wall-clock exhaustion from the persisted run start time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'))
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 42,
      issueNodeId: 'issue-node',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', run.id)

    const status = checkRunawayBudget(
      db,
      fakeCostTracker(),
      makeCtx({ runId: run.id }),
      makeTestConfig({ loop: { maxRunWallClockMinutes: 5 } }).loop,
    )

    expect(status.overBudget).toBe(true)
    expect(status.limit).toBe('run_wall_clock')
    expect(status.actual).toBe(10)
    expect(status.threshold).toBe(5)
  })

  it('records estimated worker cost, returns budget status, and updates context cost', () => {
    const costTracker = fakeCostTracker()
    const metrics = {
      incCostTokenSource: vi.fn(),
      addEstimatedCost: vi.fn(),
    }

    const result = applyEstimatedWorkerCost(
      makeCtx(),
      costTracker,
      makeTestConfig().cost,
      makeTestConfig().security,
      'code',
      'coder',
      { role: 'coder', workerType: 'claude', pricingModel: null },
      10_000,
      { promptTokens: 1_000, completionTokens: 100 },
      metrics as never,
    )

    expect(result.budget).toEqual({ overBudget: false })
    expect(result.ctx.estimatedCostUsd).toBe(0.0045)
    expect(costTracker.recordCostAndCheckBudget).toHaveBeenCalledWith(
      'run-1',
      0.0045,
      { promptTokens: 1_000, completionTokens: 100 },
      expect.objectContaining({
        stepId: 'code',
        workerType: 'claude',
        tokenSource: 'reported_cli',
        theoreticalCostUsd: 0.0045,
      }),
      makeTestConfig().security,
      makeTestConfig().cost,
    )
    expect(metrics.incCostTokenSource).toHaveBeenCalledWith('reported_cli')
    expect(metrics.addEstimatedCost).toHaveBeenCalledWith('org/repo', 'claude', 0.0045)
  })

  it('keeps metrics best-effort while recording cost', () => {
    const result = applyEstimatedWorkerCost(
      makeCtx(),
      fakeCostTracker(),
      makeTestConfig().cost,
      makeTestConfig().security,
      'code',
      'coder',
      { role: 'coder', workerType: 'claude', pricingModel: null },
      10_000,
      { promptTokens: 1_000, completionTokens: 100 },
      {
        incCostTokenSource: vi.fn(() => { throw new Error('metrics down') }),
        addEstimatedCost: vi.fn(() => { throw new Error('metrics down') }),
      } as never,
    )

    expect(result.ctx.estimatedCostUsd).toBe(0.0045)
  })

  it('formats budget block messages and legacy block reasons', () => {
    expect(describeRunawayBudgetBlock({
      overBudget: true,
      limit: 'daily_tokens',
      actual: 2500.9,
      threshold: 2000,
    })).toBe('Daily token budget exceeded (2500 >= 2000 tokens)')
    expect(describeRunawayBudgetBlock({ overBudget: false })).toBe('Runaway budget exceeded')
    expect(runawayLimitToBlockReason('run_wall_clock')).toBe('run_wall_clock_limit')
    expect(runawayLimitToBlockReason(undefined)).toBe('iteration_limit')
  })
})
