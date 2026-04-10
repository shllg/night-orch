/**
 * Cost recording and budget policy — thin facade class.
 *
 * R4d split the original 800-line `cost.ts` into four modules:
 *   - `cost/recorder.ts` — append-only ledger writes + token normalization
 *   - `cost/query.ts`    — read-side totals, breakdowns, integrity check
 *   - `cost/overrides.ts`— per-run and daily cap overrides
 *   - `cost/budget.ts`   — budget policy types and pure helpers
 *
 * This file keeps the `CostTracker` class as a stable public surface.
 * It holds the shared `db` handle, `IssueManager`, and the one-shot
 * warning dedup set for subscription-metered advisories, delegating
 * all real work to the four modules above.
 *
 * **Append-only ledger invariant (post-R0d + R4e):** every cost
 * observation lands in `run_cost_entries` via `persistCostRecord`,
 * inside a single SQLite transaction that also upserts the
 * `daily_costs` aggregate and bumps the per-run columns on `runs`.
 * `verifyCostLedgerIntegrity()` is the runtime safety net that
 * detects any future regression of this invariant.
 */
import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import { IssueManager } from '../state/issues.js'
import { utcDayKey } from '../utils/time.js'
import { logger } from '../utils/logger.js'
import {
  resolveCostPolicy,
  type BudgetStatus,
} from './cost/budget.js'
import {
  normalizeTokenUsage,
  persistCostRecord,
  type CostRecordMetadata,
  type TokenSource,
  type TokenUsageInput,
  type TokenUsageTotals,
} from './cost/recorder.js'
import {
  getDailyCost,
  getDailyCostBreakdownByStep,
  getDailyCostBreakdownByWorker,
  getDailyTokenUsage,
  getRunCost,
  getRunCostBreakdownByStep,
  getRunTokenUsage,
  verifyCostLedgerIntegrity,
  type StepCostBreakdown,
  type WorkerCostBreakdown,
} from './cost/query.js'
import {
  getDailyCapOverride,
  getRunBudgetOverride,
  resetDailyCosts,
  setDailyCapOverride,
  setRunBudgetOverride,
} from './cost/overrides.js'

// Re-export the extracted types + helpers so callers that import from
// './cost.js' continue to work unchanged after R4d.
export { describeBudgetBlock, costLimitRecoveryHint } from './cost/budget.js'
export type { BudgetStatus } from './cost/budget.js'
export type {
  CostRecordMetadata,
  TokenSource,
  TokenUsageInput,
  TokenUsageTotals,
} from './cost/recorder.js'
export type { StepCostBreakdown, WorkerCostBreakdown } from './cost/query.js'

export class CostTracker {
  private issueManager: IssueManager
  private advisoryWarnings = new Set<string>()

  constructor(private db: Database.Database) {
    this.issueManager = new IssueManager(db)
  }

  /**
   * Record a cost entry for a run. Persists both USD amount and token
   * counts. Subscription runs with $0 cost but real tokens still
   * record tokens for analytics — only skipped when both are zero.
   */
  recordCost(
    runId: string,
    costUsd: number,
    tokenUsage?: TokenUsageInput,
    metadata: CostRecordMetadata = {},
  ): void {
    const amountUsd = Number(Math.max(0, costUsd).toFixed(6))
    const normalizedTokens = normalizeTokenUsage(tokenUsage)
    if (amountUsd <= 0 && normalizedTokens.totalTokens <= 0) return

    const today = utcDayKey()
    const costStepId = metadata.stepId?.trim() ? metadata.stepId : null
    const costWorkerType = metadata.workerType?.trim() ? metadata.workerType : null
    const tokenSource: TokenSource = metadata.tokenSource ?? 'reported_cli'
    const tx = this.db.transaction((
      id: string,
      date: string,
      usage: TokenUsageTotals,
      usdAmount: number,
    ) => {
      persistCostRecord(
        this.db,
        this.issueManager,
        id,
        date,
        usage,
        usdAmount,
        costStepId,
        costWorkerType,
        tokenSource,
      )
    })

    tx(runId, today, normalizedTokens, amountUsd)
  }

  /**
   * Record a cost entry and immediately check budget limits. Primary
   * entry point for worker cost recording during loop execution.
   * Returns a `BudgetStatus` indicating whether the run is over budget.
   */
  recordCostAndCheckBudget(
    runId: string,
    costUsd: number,
    tokenUsage: TokenUsageInput | undefined,
    metadata: CostRecordMetadata,
    limits: Config['security'],
    costPolicyInput: Config['cost']['model'] | Config['cost'] | undefined = 'pay-per-use',
  ): BudgetStatus {
    const amountUsd = Number(Math.max(0, costUsd).toFixed(6))
    const normalizedTokens = normalizeTokenUsage(tokenUsage)
    if (amountUsd <= 0 && normalizedTokens.totalTokens <= 0) {
      return this.checkBudget(runId, limits, costPolicyInput)
    }

    const today = utcDayKey()
    const costStepId = metadata.stepId?.trim() ? metadata.stepId : null
    const costWorkerType = metadata.workerType?.trim() ? metadata.workerType : null
    const tokenSource: TokenSource = metadata.tokenSource ?? 'reported_cli'

    const tx = this.db.transaction((
      id: string,
      date: string,
      usage: TokenUsageTotals,
      usdAmount: number,
      securityLimits: Config['security'],
      policyInput: Config['cost']['model'] | Config['cost'] | undefined,
    ): BudgetStatus => {
      persistCostRecord(
        this.db,
        this.issueManager,
        id,
        date,
        usage,
        usdAmount,
        costStepId,
        costWorkerType,
        tokenSource,
      )
      return this.checkBudget(id, securityLimits, policyInput)
    })

    return tx(runId, today, normalizedTokens, amountUsd, limits, costPolicyInput)
  }

  verifyCostLedgerIntegrity(): ReturnType<typeof verifyCostLedgerIntegrity> {
    return verifyCostLedgerIntegrity(this.db)
  }

  getDailyCost(): number {
    return getDailyCost(this.db)
  }

  getRunCost(runId: string): number {
    return getRunCost(this.db, runId)
  }

  getDailyTokenUsage(): TokenUsageTotals {
    return getDailyTokenUsage(this.db)
  }

  getRunTokenUsage(runId: string): TokenUsageTotals {
    return getRunTokenUsage(this.db, runId)
  }

  getRunCostBreakdownByStep(runId: string): StepCostBreakdown[] {
    return getRunCostBreakdownByStep(this.db, runId)
  }

  getDailyCostBreakdownByStep(date: string = utcDayKey()): StepCostBreakdown[] {
    return getDailyCostBreakdownByStep(this.db, date)
  }

  getDailyCostBreakdownByWorker(date: string = utcDayKey()): WorkerCostBreakdown[] {
    return getDailyCostBreakdownByWorker(this.db, date)
  }

  /**
   * Evaluate whether a run has crossed any spend limit. Returns a
   * discriminated status so callers can build messages that name the
   * specific limit that tripped (daily vs per-run) instead of guessing.
   *
   * - `subscription` mode: enforcement always skipped.
   * - `subscription-metered`: warnings emitted; enforcement optional
   *   per configured knob.
   *
   * A non-null `cost_budget_override_usd` on the run row overrides the
   * per-run cap AND exempts the run from the daily cap. A non-null
   * `daily_cost_cap_override_usd` on today's `daily_costs` row replaces
   * `limits.maxDailyCostUsd` for today only; it auto-expires at 00:00 UTC.
   */
  checkBudget(
    runId: string,
    limits: Config['security'],
    costPolicyInput: Config['cost']['model'] | Config['cost'] | undefined = 'pay-per-use',
  ): BudgetStatus {
    const policy = resolveCostPolicy(costPolicyInput)

    if (policy.model === 'subscription') {
      return { overBudget: false }
    }

    const override = this.getRunBudgetOverride(runId)
    const runCost = this.getRunCost(runId)
    const effectivePerRunLimit = override ?? limits.maxCostPerRunUsd
    const runOverLimit = runCost >= effectivePerRunLimit

    const dailyCost = this.getDailyCost()
    const dailyCapOverride = this.getDailyCapOverride()
    const effectiveDailyLimit = dailyCapOverride ?? limits.maxDailyCostUsd
    const dailyOverLimit = dailyCost >= effectiveDailyLimit

    if (policy.model === 'subscription-metered') {
      const advisoryThreshold = policy.subscriptionMetered.advisoryThresholdUsd
      if (advisoryThreshold !== null) {
        if (runCost >= advisoryThreshold) {
          this.logSubscriptionMeteredWarningOnce(
            `${runId}:advisory:run:${advisoryThreshold}`,
            {
              runId,
              thresholdUsd: advisoryThreshold,
              runCostUsd: runCost,
            },
            'subscription-metered advisory threshold exceeded (run)',
          )
        }
        if (dailyCost >= advisoryThreshold) {
          this.logSubscriptionMeteredWarningOnce(
            `${runId}:advisory:daily:${advisoryThreshold}:${utcDayKey()}`,
            {
              runId,
              thresholdUsd: advisoryThreshold,
              dailyCostUsd: dailyCost,
            },
            'subscription-metered advisory threshold exceeded (daily)',
          )
        }
      }

      if (runOverLimit && !policy.subscriptionMetered.enforcePerRunLimit) {
        this.logSubscriptionMeteredWarningOnce(
          `${runId}:soft:per-run:${effectivePerRunLimit}`,
          {
            runId,
            runCostUsd: runCost,
            effectivePerRunLimitUsd: effectivePerRunLimit,
          },
          'subscription-metered soft per-run limit exceeded',
        )
      }

      if (runOverLimit && policy.subscriptionMetered.enforcePerRunLimit) {
        return {
          overBudget: true,
          limit: 'per-run',
          actualUsd: runCost,
          limitUsd: effectivePerRunLimit,
        }
      }

      if (override !== null) {
        return { overBudget: false }
      }

      if (dailyOverLimit && !policy.subscriptionMetered.enforceDailyLimit) {
        this.logSubscriptionMeteredWarningOnce(
          `${runId}:soft:daily:${effectiveDailyLimit}:${utcDayKey()}`,
          {
            runId,
            dailyCostUsd: dailyCost,
            effectiveDailyLimitUsd: effectiveDailyLimit,
          },
          'subscription-metered soft daily limit exceeded',
        )
      }

      if (dailyOverLimit && policy.subscriptionMetered.enforceDailyLimit) {
        return {
          overBudget: true,
          limit: 'daily',
          actualUsd: dailyCost,
          limitUsd: effectiveDailyLimit,
        }
      }

      return { overBudget: false }
    }

    if (runOverLimit) {
      return {
        overBudget: true,
        limit: 'per-run',
        actualUsd: runCost,
        limitUsd: effectivePerRunLimit,
      }
    }

    // Override grants a one-time bypass of the daily cap so a stuck
    // run can make forward progress even if the day has already blown
    // past the limit.
    if (override !== null) {
      return { overBudget: false }
    }

    if (dailyOverLimit) {
      return {
        overBudget: true,
        limit: 'daily',
        actualUsd: dailyCost,
        limitUsd: effectiveDailyLimit,
      }
    }

    return { overBudget: false }
  }

  getRunBudgetOverride(runId: string): number | null {
    return getRunBudgetOverride(this.db, runId)
  }

  setRunBudgetOverride(runId: string, overrideUsd: number | null): void {
    setRunBudgetOverride(this.db, runId, overrideUsd)
  }

  getDailyCapOverride(date: string = utcDayKey()): number | null {
    return getDailyCapOverride(this.db, date)
  }

  setDailyCapOverride(overrideUsd: number | null, date: string = utcDayKey()): void {
    setDailyCapOverride(this.db, overrideUsd, date)
  }

  resetDailyCosts(date: string = utcDayKey()): { previousCostUsd: number } {
    return resetDailyCosts(this.db, date)
  }

  private logSubscriptionMeteredWarningOnce(
    key: string,
    data: Record<string, unknown>,
    message: string,
  ): void {
    if (this.advisoryWarnings.has(key)) return
    this.advisoryWarnings.add(key)
    logger.warn(data, message)
  }
}
