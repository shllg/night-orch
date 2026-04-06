import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import { IssueManager } from '../state/issues.js'
import { RunManager } from '../state/runs.js'
import { utcDayKey } from '../utils/time.js'

interface TokenUsageInput {
  promptTokens: number
  completionTokens: number
}

export interface TokenUsageTotals {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export class CostTracker {
  private issueManager: IssueManager

  constructor(private db: Database.Database) {
    this.issueManager = new IssueManager(db)
  }

  recordCost(runId: string, costUsd: number, tokenUsage?: TokenUsageInput): void {
    const amountUsd = Number(Math.max(0, costUsd).toFixed(6))
    const normalizedTokens = normalizeTokenUsage(tokenUsage)
    if (amountUsd <= 0 && normalizedTokens.totalTokens <= 0) return

    const today = utcDayKey()
    const tx = this.db.transaction((id: string, date: string, usage: TokenUsageTotals, usdAmount: number) => {
      const runUsageInsert = this.db
        .prepare(
          `INSERT INTO daily_run_usage (date, run_id)
           VALUES (?, ?)
           ON CONFLICT(date, run_id) DO NOTHING`,
        )
        .run(date, id)
      const dailyRunCountIncrement = runUsageInsert.changes > 0 ? 1 : 0

      this.db
        .prepare(
          `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET
             total_cost_usd = total_cost_usd + excluded.total_cost_usd,
             run_count = run_count + excluded.run_count,
             total_prompt_tokens = total_prompt_tokens + excluded.total_prompt_tokens,
             total_completion_tokens = total_completion_tokens + excluded.total_completion_tokens`,
        )
        .run(date, usdAmount, dailyRunCountIncrement, usage.promptTokens, usage.completionTokens)

      this.db
        .prepare(
          `UPDATE runs
           SET estimated_cost_usd = estimated_cost_usd + ?,
               prompt_tokens = prompt_tokens + ?,
               completion_tokens = completion_tokens + ?
           WHERE id = ?`,
        )
        .run(usdAmount, usage.promptTokens, usage.completionTokens, id)

      this.issueManager.syncFromRunId(id)
    })

    tx(runId, today, normalizedTokens, amountUsd)
  }

  getDailyCost(): number {
    const today = utcDayKey()
    const row = this.db
      .prepare('SELECT total_cost_usd FROM daily_costs WHERE date = ?')
      .get(today) as { total_cost_usd: number } | undefined
    return row?.total_cost_usd ?? 0
  }

  getRunCost(runId: string): number {
    const row = this.db
      .prepare('SELECT estimated_cost_usd FROM runs WHERE id = ?')
      .get(runId) as { estimated_cost_usd: number } | undefined
    return row?.estimated_cost_usd ?? 0
  }

  getDailyTokenUsage(): TokenUsageTotals {
    const today = utcDayKey()
    const row = this.db
      .prepare('SELECT total_prompt_tokens, total_completion_tokens FROM daily_costs WHERE date = ?')
      .get(today) as DailyTokenRow | undefined

    const promptTokens = row?.total_prompt_tokens ?? 0
    const completionTokens = row?.total_completion_tokens ?? 0
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    }
  }

  getRunTokenUsage(runId: string): TokenUsageTotals {
    const row = this.db
      .prepare('SELECT prompt_tokens, completion_tokens FROM runs WHERE id = ?')
      .get(runId) as RunTokenRow | undefined

    const promptTokens = row?.prompt_tokens ?? 0
    const completionTokens = row?.completion_tokens ?? 0
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    }
  }

  /**
   * Evaluate whether a run has crossed any spend limit.
   * Returns a discriminated status so callers can build messages that name
   * the specific limit that tripped (daily vs per-run) instead of guessing.
   *
   * When `costModel === 'subscription'` (Claude Pro/Max, Codex Pro, etc.) the
   * USD estimate is advisory only — the operator pays a flat subscription fee,
   * not per-token — so enforcement is skipped entirely. Tokens and the
   * advisory USD estimate continue to be written to the DB for analytics.
   *
   * A non-null `cost_budget_override_usd` on the run row overrides the
   * per-run cap with the stored value AND exempts the run from the daily
   * cap. Operators grant this override to push a specific run through when
   * they accept the extra spend.
   *
   * A non-null `daily_cost_cap_override_usd` on today's `daily_costs` row
   * replaces `limits.maxDailyCostUsd` for today only. It auto-expires when
   * the UTC day rolls over (next day's row starts NULL).
   */
  checkBudget(
    runId: string,
    limits: Config['security'],
    costModel: Config['cost']['model'] = 'pay-per-use',
  ): BudgetStatus {
    // Subscription plans are flat-rate. The per-token USD numbers the worker
    // adapters report are "what this would have cost on the API" estimates and
    // have no relationship to what the operator actually pays, so enforcing
    // them would block every run the moment tokens add up.
    if (costModel === 'subscription') {
      return { overBudget: false }
    }
    const override = this.getRunBudgetOverride(runId)
    const runCost = this.getRunCost(runId)

    const effectivePerRunLimit = override ?? limits.maxCostPerRunUsd
    if (runCost >= effectivePerRunLimit) {
      return {
        overBudget: true,
        limit: 'per-run',
        actualUsd: runCost,
        limitUsd: effectivePerRunLimit,
      }
    }

    // Override grants a one-time bypass of the daily cap so a stuck run can
    // make forward progress even if the day has already blown past the limit.
    if (override !== null) {
      return { overBudget: false }
    }

    const dailyCost = this.getDailyCost()
    const dailyCapOverride = this.getDailyCapOverride()
    const effectiveDailyLimit = dailyCapOverride ?? limits.maxDailyCostUsd
    if (dailyCost >= effectiveDailyLimit) {
      return {
        overBudget: true,
        limit: 'daily',
        actualUsd: dailyCost,
        limitUsd: effectiveDailyLimit,
      }
    }

    return { overBudget: false }
  }

  /**
   * Read the cost budget override for a run, or null if no override is set.
   */
  getRunBudgetOverride(runId: string): number | null {
    const row = this.db
      .prepare('SELECT cost_budget_override_usd FROM runs WHERE id = ?')
      .get(runId) as { cost_budget_override_usd: number | null } | undefined
    if (!row) return null
    return row.cost_budget_override_usd ?? null
  }

  /**
   * Grant a per-run cost override. Pass null to clear it.
   * When set, the value becomes the run's per-run cap and the daily cap
   * is bypassed for this run.
   */
  setRunBudgetOverride(runId: string, overrideUsd: number | null): void {
    if (overrideUsd !== null) {
      if (!Number.isFinite(overrideUsd) || overrideUsd <= 0) {
        throw new Error(`cost budget override must be a positive finite number, got ${overrideUsd}`)
      }
    }
    new RunManager(this.db).setCostBudgetOverride(runId, overrideUsd)
  }

  /**
   * Read the daily cost cap override for a UTC day (defaults to today).
   * Returns null when no override is set.
   */
  getDailyCapOverride(date: string = utcDayKey()): number | null {
    const row = this.db
      .prepare('SELECT daily_cost_cap_override_usd FROM daily_costs WHERE date = ?')
      .get(date) as { daily_cost_cap_override_usd: number | null } | undefined
    if (!row) return null
    return row.daily_cost_cap_override_usd ?? null
  }

  /**
   * Set or clear the daily cost cap override for a UTC day (defaults to
   * today). Upserts the `daily_costs` row so the override works even on a
   * day with no recorded spend yet. The override auto-expires when the UTC
   * day rolls over — operators do not need to clear it manually.
   */
  setDailyCapOverride(overrideUsd: number | null, date: string = utcDayKey()): void {
    if (overrideUsd !== null) {
      if (!Number.isFinite(overrideUsd) || overrideUsd <= 0) {
        throw new Error(`daily cap override must be a positive finite number, got ${overrideUsd}`)
      }
    }
    this.db
      .prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, daily_cost_cap_override_usd)
         VALUES (?, 0, 0, 0, 0, ?)
         ON CONFLICT(date) DO UPDATE SET daily_cost_cap_override_usd = excluded.daily_cost_cap_override_usd`,
      )
      .run(date, overrideUsd)
  }
}

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
      'Run `night-orch daily-cost-override <amount>` to raise today\'s cap (auto-expires at 00:00 UTC), ' +
      'grant this specific run a budget override via `night-orch cost-override <repo> <issue> <amount>`, ' +
      'permanently raise `security.maxDailyCostUsd` via `night-orch settings set`, ' +
      'or wait until 00:00 UTC for the daily counter to reset.'
    )
  }
  return (
    'Raise `security.maxCostPerRunUsd` in Settings (TUI/web/CLI `night-orch settings set`) ' +
    'or grant this run a budget override to continue.'
  )
}

function normalizeTokenUsage(tokenUsage: TokenUsageInput | undefined): TokenUsageTotals {
  const promptTokens = normalizeTokenCount(tokenUsage?.promptTokens)
  const completionTokens = normalizeTokenCount(tokenUsage?.completionTokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  }
}

function normalizeTokenCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

interface DailyTokenRow {
  total_prompt_tokens: number | null
  total_completion_tokens: number | null
}

interface RunTokenRow {
  prompt_tokens: number | null
  completion_tokens: number | null
}
