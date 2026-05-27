import type { Config } from '../../config/schema.js'

/**
 * Standalone budget-policy types and helpers extracted from `cost.ts`
 * as part of R4d. These were already pure functions in the original
 * file — the extraction just moves them to their own module so callers
 * that only need the budget types don't drag in the full `CostTracker`
 * class.
 *
 * `src/loop/cost.ts` still re-exports the public types and functions,
 * so existing call sites that `import { BudgetStatus } from './cost.js'`
 * continue to work unchanged.
 */

export interface SubscriptionMeteredPolicy {
  advisoryThresholdUsd: number | null
  enforcePerRunLimit: boolean
  enforceDailyLimit: boolean
}

export interface SubscriptionQuotaConfig {
  includedUsd: number
  period: 'day' | 'month'
  onExhausted: 'warn' | 'enforce'
}

export interface ResolvedCostPolicy {
  model: Config['cost']['model']
  subscriptionMetered: SubscriptionMeteredPolicy
  subscriptionQuota: SubscriptionQuotaConfig | null
}

/** Result of comparing period theoretical spend against the included quota. */
export interface SubscriptionQuotaStatus {
  exhausted: boolean
  includedUsd: number
  theoreticalUsd: number
  /** Theoretical spend beyond the included allowance (0 until exhausted). */
  overageUsd: number
  period: 'day' | 'month'
  onExhausted: 'warn' | 'enforce'
}

/**
 * Pure comparison of cumulative theoretical (layer-2) spend for a period
 * against the included subscription allowance. The recorder/checkBudget
 * path supplies `periodTheoreticalUsd`; this helper only decides whether
 * the quota is blown and by how much.
 */
export function evaluateSubscriptionQuota(
  quota: SubscriptionQuotaConfig,
  periodTheoreticalUsd: number,
): SubscriptionQuotaStatus {
  const theoreticalUsd = Number.isFinite(periodTheoreticalUsd) ? Math.max(0, periodTheoreticalUsd) : 0
  const overageUsd = Math.max(0, theoreticalUsd - quota.includedUsd)
  return {
    exhausted: theoreticalUsd >= quota.includedUsd,
    includedUsd: quota.includedUsd,
    theoreticalUsd,
    overageUsd,
    period: quota.period,
    onExhausted: quota.onExhausted,
  }
}

/**
 * Outcome of a budget check. `overBudget: false` is the happy path;
 * the blocked variant carries the specific limit that tripped along
 * with the observed and configured amounts so the engine can
 * construct a precise `BlockedReason.costLimit`.
 */
export type BudgetStatus =
  | { overBudget: false }
  | {
      overBudget: true
      limit: 'daily' | 'per-run'
      actualUsd: number
      limitUsd: number
    }

/** Human-readable message naming the specific limit that tripped. */
export function describeBudgetBlock(
  status: Extract<BudgetStatus, { overBudget: true }>,
): string {
  const label = status.limit === 'daily' ? 'Daily cost limit' : 'Per-run cost limit'
  return `${label} exceeded: $${status.actualUsd.toFixed(2)} >= $${status.limitUsd.toFixed(2)}`
}

/** Actionable recovery hint shown alongside the block reason. */
export function costLimitRecoveryHint(limit: 'daily' | 'per-run'): string {
  if (limit === 'daily') {
    return (
      'Raise today\'s cap via the web dashboard or Settings (auto-expires at 00:00 UTC), ' +
      'grant this run a budget override, ' +
      'or wait until 00:00 UTC for the daily counter to reset.'
    )
  }
  return (
    'Raise `security.maxCostPerRunUsd` via Settings or grant this run a budget override to continue.'
  )
}

/**
 * Normalize the polymorphic cost-policy input accepted by
 * `CostTracker.recordCostAndCheckBudget` and `CostTracker.checkBudget`.
 * Callers may pass either a bare model string (`'pay-per-use'`, etc)
 * or the full `Config['cost']` object; this helper collapses both
 * into a consistent `ResolvedCostPolicy` shape.
 */
export function resolveCostPolicy(
  input: Config['cost']['model'] | Config['cost'] | undefined,
): ResolvedCostPolicy {
  if (typeof input === 'string') {
    return {
      model: input,
      subscriptionMetered: {
        advisoryThresholdUsd: null,
        enforcePerRunLimit: false,
        enforceDailyLimit: false,
      },
      subscriptionQuota: null,
    }
  }

  const model = input?.model ?? 'pay-per-use'
  const subscriptionMetered = input?.subscriptionMetered
  const quota = input?.subscriptionQuota
  return {
    model,
    subscriptionMetered: {
      advisoryThresholdUsd: subscriptionMetered?.advisoryThresholdUsd ?? null,
      enforcePerRunLimit: subscriptionMetered?.enforcePerRunLimit ?? false,
      enforceDailyLimit: subscriptionMetered?.enforceDailyLimit ?? false,
    },
    subscriptionQuota: quota
      ? {
          includedUsd: quota.includedUsd,
          period: quota.period,
          onExhausted: quota.onExhausted,
        }
      : null,
  }
}
