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
 * It holds the shared `db` handle, `IssueManager`, and the subscription
 * advisory logger, delegating
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
import {
  evaluateSubscriptionQuota,
  resolveCostPolicy,
  type BudgetStatus,
  type ResolvedCostPolicy,
  type SubscriptionQuotaStatus,
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
  getDailyTheoreticalCost,
  getDailyTokenUsage,
  getMonthlyTheoreticalCost,
  getRunCost,
  getRunCostBreakdownByStep,
  getRunTheoreticalCost,
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
import { SubscriptionAdvisoryWarnings, quotaPeriodKey } from './cost/advisory.js'

// Re-export the extracted types + helpers so callers that import from
// './cost.js' continue to work unchanged after R4d.
export { describeBudgetBlock, costLimitRecoveryHint } from './cost/budget.js'
export type { BudgetStatus, SubscriptionQuotaStatus } from './cost/budget.js'
export type {
  CostRecordMetadata,
  TokenSource,
  TokenUsageInput,
  TokenUsageTotals,
} from './cost/recorder.js'
export type { StepCostBreakdown, WorkerCostBreakdown } from './cost/query.js'

/**
 * Resolve the layer-2 theoretical cost to record. Defaults to the real
 * `amountUsd` when callers don't supply one (correct for pay-per-use,
 * where theoretical == real). Negative/NaN inputs collapse to the
 * default so a bad caller can never write a nonsensical ledger value.
 */
function resolveTheoreticalUsd(theoreticalCostUsd: number | undefined, amountUsd: number): number {
  if (typeof theoreticalCostUsd !== 'number' || !Number.isFinite(theoreticalCostUsd) || theoreticalCostUsd < 0) {
    return amountUsd
  }
  return Number(theoreticalCostUsd.toFixed(6))
}

export class CostTracker {
  private issueManager: IssueManager
  private subscriptionAdvisories = new SubscriptionAdvisoryWarnings()

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
    const theoreticalUsd = resolveTheoreticalUsd(metadata.theoreticalCostUsd, amountUsd)
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
        theoreticalUsd,
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
    const theoreticalUsd = resolveTheoreticalUsd(metadata.theoreticalCostUsd, amountUsd)

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
        theoreticalUsd,
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

    // Subscription quota: once cumulative theoretical (layer-2) spend
    // for the period exceeds the included allowance, billing has swapped
    // to usage-based. Warn always; when `enforce`, apply the daily cap
    // against the overage so a blown quota can block new work even
    // though the *real* charge column reads $0 under the subscription.
    const quotaBlock = this.checkQuotaExhaustionBudget(runId, limits, policy)
    if (quotaBlock) return quotaBlock

    if (policy.model === 'subscription') {
      return { overBudget: false }
    }

    const snapshot = this.buildBudgetSnapshot(runId, limits)

    if (policy.model === 'subscription-metered') {
      return this.checkSubscriptionMeteredBudget(runId, policy, snapshot)
    }

    return this.checkPayPerUseBudget(snapshot)
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

  getDailyTheoreticalCost(): number {
    return getDailyTheoreticalCost(this.db)
  }

  getRunTheoreticalCost(runId: string): number {
    return getRunTheoreticalCost(this.db, runId)
  }

  /**
   * Evaluate the configured subscription quota against cumulative
   * theoretical spend for its period. Returns null when no quota is
   * configured or the billing model isn't subscription-based (quota only
   * makes sense when real charges are normalized away).
   */
  getSubscriptionQuotaStatus(
    costPolicyInput: Config['cost']['model'] | Config['cost'] | undefined = 'pay-per-use',
  ): SubscriptionQuotaStatus | null {
    return this.evaluateQuota(resolveCostPolicy(costPolicyInput))
  }

  private evaluateQuota(policy: ResolvedCostPolicy): SubscriptionQuotaStatus | null {
    const quota = policy.subscriptionQuota
    if (!quota) return null
    if (policy.model !== 'subscription' && policy.model !== 'subscription-metered') return null
    const periodTheoretical =
      quota.period === 'day'
        ? this.getDailyTheoreticalCost()
        : getMonthlyTheoreticalCost(this.db, quotaPeriodKey('month'))
    return evaluateSubscriptionQuota(quota, periodTheoretical)
  }

  private checkQuotaExhaustionBudget(
    runId: string,
    limits: Config['security'],
    policy: ResolvedCostPolicy,
  ): BudgetStatus | null {
    const quotaStatus = this.evaluateQuota(policy)
    if (!quotaStatus?.exhausted) return null

    this.subscriptionAdvisories.warnOnce(
      `${runId}:quota:${quotaStatus.period}:${quotaPeriodKey(quotaStatus.period)}`,
      {
        runId,
        includedUsd: quotaStatus.includedUsd,
        theoreticalUsd: quotaStatus.theoreticalUsd,
        overageUsd: quotaStatus.overageUsd,
        period: quotaStatus.period,
      },
      'subscription quota exhausted — billing has swapped to usage-based',
    )

    if (quotaStatus.onExhausted !== 'enforce') return null

    const override = this.getRunBudgetOverride(runId)
    const dailyCapOverride = this.getDailyCapOverride()
    const effectiveDailyLimit = dailyCapOverride ?? limits.maxDailyCostUsd
    if (override === null && quotaStatus.overageUsd >= effectiveDailyLimit) {
      return {
        overBudget: true,
        limit: 'daily',
        actualUsd: quotaStatus.overageUsd,
        limitUsd: effectiveDailyLimit,
      }
    }
    return null
  }

  private buildBudgetSnapshot(runId: string, limits: Config['security']): BudgetSnapshot {
    const override = this.getRunBudgetOverride(runId)
    const runCost = this.getRunCost(runId)
    const dailyCost = this.getDailyCost()
    const dailyCapOverride = this.getDailyCapOverride()
    const effectivePerRunLimit = override ?? limits.maxCostPerRunUsd
    const effectiveDailyLimit = dailyCapOverride ?? limits.maxDailyCostUsd

    return {
      override,
      runCost,
      dailyCost,
      effectivePerRunLimit,
      effectiveDailyLimit,
      runOverLimit: runCost >= effectivePerRunLimit,
      dailyOverLimit: dailyCost >= effectiveDailyLimit,
    }
  }

  private checkSubscriptionMeteredBudget(
    runId: string,
    policy: ResolvedCostPolicy,
    snapshot: BudgetSnapshot,
  ): BudgetStatus {
    this.logSubscriptionMeteredAdvisories(runId, policy, snapshot)

    if (snapshot.runOverLimit && policy.subscriptionMetered.enforcePerRunLimit) {
      return this.blockedByPerRunLimit(snapshot.runCost, snapshot.effectivePerRunLimit)
    }

    if (snapshot.override !== null) {
      return { overBudget: false }
    }

    if (snapshot.dailyOverLimit && policy.subscriptionMetered.enforceDailyLimit) {
      return this.blockedByDailyLimit(snapshot.dailyCost, snapshot.effectiveDailyLimit)
    }

    return { overBudget: false }
  }

  private logSubscriptionMeteredAdvisories(
    runId: string,
    policy: ResolvedCostPolicy,
    snapshot: BudgetSnapshot,
  ): void {
    const advisoryThreshold = policy.subscriptionMetered.advisoryThresholdUsd
    if (advisoryThreshold !== null) {
      if (snapshot.runCost >= advisoryThreshold) {
        this.subscriptionAdvisories.warnOnce(
          `${runId}:advisory:run:${advisoryThreshold}`,
          {
            runId,
            thresholdUsd: advisoryThreshold,
            runCostUsd: snapshot.runCost,
          },
          'subscription-metered advisory threshold exceeded (run)',
        )
      }
      if (snapshot.dailyCost >= advisoryThreshold) {
        this.subscriptionAdvisories.warnOnce(
          `${runId}:advisory:daily:${advisoryThreshold}:${utcDayKey()}`,
          {
            runId,
            thresholdUsd: advisoryThreshold,
            dailyCostUsd: snapshot.dailyCost,
          },
          'subscription-metered advisory threshold exceeded (daily)',
        )
      }
    }

    if (snapshot.runOverLimit && !policy.subscriptionMetered.enforcePerRunLimit) {
      this.subscriptionAdvisories.warnOnce(
        `${runId}:soft:per-run:${snapshot.effectivePerRunLimit}`,
        {
          runId,
          runCostUsd: snapshot.runCost,
          effectivePerRunLimitUsd: snapshot.effectivePerRunLimit,
        },
        'subscription-metered soft per-run limit exceeded',
      )
    }

    if (snapshot.override !== null) return

    if (snapshot.dailyOverLimit && !policy.subscriptionMetered.enforceDailyLimit) {
      this.subscriptionAdvisories.warnOnce(
        `${runId}:soft:daily:${snapshot.effectiveDailyLimit}:${utcDayKey()}`,
        {
          runId,
          dailyCostUsd: snapshot.dailyCost,
          effectiveDailyLimitUsd: snapshot.effectiveDailyLimit,
        },
        'subscription-metered soft daily limit exceeded',
      )
    }
  }

  private checkPayPerUseBudget(snapshot: BudgetSnapshot): BudgetStatus {
    if (snapshot.runOverLimit) {
      return this.blockedByPerRunLimit(snapshot.runCost, snapshot.effectivePerRunLimit)
    }

    // Override grants a one-time bypass of the daily cap so a stuck
    // run can make forward progress even if the day has already blown
    // past the limit.
    if (snapshot.override !== null) {
      return { overBudget: false }
    }

    if (snapshot.dailyOverLimit) {
      return this.blockedByDailyLimit(snapshot.dailyCost, snapshot.effectiveDailyLimit)
    }

    return { overBudget: false }
  }

  private blockedByPerRunLimit(actualUsd: number, limitUsd: number): BudgetStatus {
    return {
      overBudget: true,
      limit: 'per-run',
      actualUsd,
      limitUsd,
    }
  }

  private blockedByDailyLimit(actualUsd: number, limitUsd: number): BudgetStatus {
    return {
      overBudget: true,
      limit: 'daily',
      actualUsd,
      limitUsd,
    }
  }

}

type BudgetSnapshot = {
  override: number | null
  runCost: number
  dailyCost: number
  effectivePerRunLimit: number
  effectiveDailyLimit: number
  runOverLimit: boolean
  dailyOverLimit: boolean
}
