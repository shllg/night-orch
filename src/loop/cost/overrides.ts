import type Database from 'better-sqlite3'
import { RunManager } from '../../state/runs.js'
import { utcDayKey } from '../../utils/time.js'
import { logger } from '../../utils/logger.js'

/**
 * Per-run and per-day budget-override helpers. These are the
 * "additive" escape hatches operators use when a single run needs
 * more headroom than the configured cap (per-run override) or when
 * the whole day needs a bumped cap (daily cap override). Extracted
 * from `cost.ts` in R4d so override logic doesn't mix with the
 * append-only ledger path.
 */

export function getRunBudgetOverride(db: Database.Database, runId: string): number | null {
  const row = db
    .prepare('SELECT cost_budget_override_usd FROM runs WHERE id = ?')
    .get(runId) as { cost_budget_override_usd: number | null } | undefined
  if (!row) return null
  return row.cost_budget_override_usd ?? null
}

export function setRunBudgetOverride(
  db: Database.Database,
  runId: string,
  overrideUsd: number | null,
): void {
  if (overrideUsd !== null) {
    if (!Number.isFinite(overrideUsd) || overrideUsd <= 0) {
      throw new Error(`cost budget override must be a positive finite number, got ${overrideUsd}`)
    }
  }
  new RunManager(db).setCostBudgetOverride(runId, overrideUsd)
}

export function getDailyCapOverride(
  db: Database.Database,
  date: string = utcDayKey(),
): number | null {
  const row = db
    .prepare('SELECT daily_cost_cap_override_usd FROM daily_costs WHERE date = ?')
    .get(date) as { daily_cost_cap_override_usd: number | null } | undefined
  if (!row) return null
  return row.daily_cost_cap_override_usd ?? null
}

/**
 * Set or clear the daily cost cap override for a UTC day. Upserts the
 * `daily_costs` row so the override works even on a day with no
 * recorded spend yet. The override auto-expires when the UTC day
 * rolls over — operators do not need to clear it manually.
 */
export function setDailyCapOverride(
  db: Database.Database,
  overrideUsd: number | null,
  date: string = utcDayKey(),
): void {
  if (overrideUsd !== null) {
    if (!Number.isFinite(overrideUsd) || overrideUsd <= 0) {
      throw new Error(`daily cap override must be a positive finite number, got ${overrideUsd}`)
    }
  }
  db
    .prepare(
      `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens, daily_cost_cap_override_usd)
       VALUES (?, 0, 0, 0, 0, 0, ?)
       ON CONFLICT(date) DO UPDATE SET daily_cost_cap_override_usd = excluded.daily_cost_cap_override_usd`,
    )
    .run(date, overrideUsd)
}

/**
 * Reset daily cost counters for a specific UTC day. Zeros the usage
 * columns while preserving `daily_cost_cap_override_usd`. Returns the
 * previous daily cost before resetting.
 */
export function resetDailyCosts(
  db: Database.Database,
  date: string = utcDayKey(),
): { previousCostUsd: number } {
  const row = db
    .prepare('SELECT total_cost_usd FROM daily_costs WHERE date = ?')
    .get(date) as { total_cost_usd: number } | undefined
  const previousCostUsd = row?.total_cost_usd ?? 0

  db
    .prepare(
      `UPDATE daily_costs
       SET total_cost_usd = 0,
           total_prompt_tokens = 0,
           total_completion_tokens = 0,
           total_cache_read_tokens = 0
       WHERE date = ?`,
    )
    .run(date)

  logger.info({ date, previousCostUsd }, 'Reset daily cost counters')

  return { previousCostUsd }
}
