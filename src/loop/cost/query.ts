import type Database from 'better-sqlite3'
import { utcDayKey } from '../../utils/time.js'
import type { TokenUsageTotals } from './recorder.js'

/**
 * Read-side of the cost ledger: daily/per-run totals, per-step and
 * per-worker breakdowns, and the R4e integrity check. Split from
 * `cost.ts` in R4d so reporting callers don't drag the recorder +
 * budget policy along with them.
 */

export interface StepCostBreakdown {
  stepId: string
  costUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export interface WorkerCostBreakdown {
  workerType: string
  costUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

interface DailyTokenRow {
  total_prompt_tokens: number | null
  total_completion_tokens: number | null
  total_cache_read_tokens: number | null
}

interface RunTokenRow {
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read_tokens: number | null
}

export function getDailyCost(db: Database.Database): number {
  const today = utcDayKey()
  const row = db
    .prepare('SELECT total_cost_usd FROM daily_costs WHERE date = ?')
    .get(today) as { total_cost_usd: number } | undefined
  return row?.total_cost_usd ?? 0
}

export function getRunCost(db: Database.Database, runId: string): number {
  const row = db
    .prepare('SELECT estimated_cost_usd FROM runs WHERE id = ?')
    .get(runId) as { estimated_cost_usd: number } | undefined
  return row?.estimated_cost_usd ?? 0
}

export function getDailyTokenUsage(db: Database.Database): TokenUsageTotals {
  const today = utcDayKey()
  const row = db
    .prepare('SELECT total_prompt_tokens, total_completion_tokens, total_cache_read_tokens FROM daily_costs WHERE date = ?')
    .get(today) as DailyTokenRow | undefined

  const promptTokens = row?.total_prompt_tokens ?? 0
  const completionTokens = row?.total_completion_tokens ?? 0
  const cacheReadTokens = row?.total_cache_read_tokens ?? 0
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    totalTokens: promptTokens + completionTokens + cacheReadTokens,
  }
}

export function getRunTokenUsage(db: Database.Database, runId: string): TokenUsageTotals {
  const row = db
    .prepare('SELECT prompt_tokens, completion_tokens, cache_read_tokens FROM runs WHERE id = ?')
    .get(runId) as RunTokenRow | undefined

  const promptTokens = row?.prompt_tokens ?? 0
  const completionTokens = row?.completion_tokens ?? 0
  const cacheReadTokens = row?.cache_read_tokens ?? 0
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    totalTokens: promptTokens + completionTokens + cacheReadTokens,
  }
}

export function getRunCostBreakdownByStep(
  db: Database.Database,
  runId: string,
): StepCostBreakdown[] {
  const rows = db
    .prepare(
      `SELECT
         step_id,
         SUM(cost_usd) AS cost_usd,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens
       FROM run_cost_entries
       WHERE run_id = ?
       GROUP BY step_id
       ORDER BY cost_usd DESC, step_id ASC`,
    )
    .all(runId) as Array<{
      step_id: string
      cost_usd: number | null
      prompt_tokens: number | null
      completion_tokens: number | null
      cache_read_tokens: number | null
    }>

  return rows.map((row) => {
    const promptTokens = row.prompt_tokens ?? 0
    const completionTokens = row.completion_tokens ?? 0
    const cacheReadTokens = row.cache_read_tokens ?? 0
    return {
      stepId: row.step_id,
      costUsd: row.cost_usd ?? 0,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      totalTokens: promptTokens + completionTokens + cacheReadTokens,
    }
  })
}

export function getDailyCostBreakdownByStep(
  db: Database.Database,
  date: string = utcDayKey(),
): StepCostBreakdown[] {
  const rows = db
    .prepare(
      `SELECT
         step_id,
         SUM(cost_usd) AS cost_usd,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens
       FROM run_cost_entries
       WHERE date(created_at) = ?
       GROUP BY step_id
       ORDER BY cost_usd DESC, step_id ASC`,
    )
    .all(date) as Array<{
      step_id: string
      cost_usd: number | null
      prompt_tokens: number | null
      completion_tokens: number | null
      cache_read_tokens: number | null
    }>

  return rows.map((row) => {
    const promptTokens = row.prompt_tokens ?? 0
    const completionTokens = row.completion_tokens ?? 0
    const cacheReadTokens = row.cache_read_tokens ?? 0
    return {
      stepId: row.step_id,
      costUsd: row.cost_usd ?? 0,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      totalTokens: promptTokens + completionTokens + cacheReadTokens,
    }
  })
}

export function getDailyCostBreakdownByWorker(
  db: Database.Database,
  date: string = utcDayKey(),
): WorkerCostBreakdown[] {
  const rows = db
    .prepare(
      `SELECT
         COALESCE(worker_type, 'unknown') AS worker_type,
         SUM(cost_usd) AS cost_usd,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens
       FROM run_cost_entries
       WHERE date(created_at) = ?
       GROUP BY worker_type
       ORDER BY cost_usd DESC, worker_type ASC`,
    )
    .all(date) as Array<{
      worker_type: string
      cost_usd: number | null
      prompt_tokens: number | null
      completion_tokens: number | null
      cache_read_tokens: number | null
    }>

  return rows.map((row) => {
    const promptTokens = row.prompt_tokens ?? 0
    const completionTokens = row.completion_tokens ?? 0
    const cacheReadTokens = row.cache_read_tokens ?? 0
    return {
      workerType: row.worker_type,
      costUsd: row.cost_usd ?? 0,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      totalTokens: promptTokens + completionTokens + cacheReadTokens,
    }
  })
}

/**
 * R4e: Verify that the `daily_costs` aggregate matches the ledger sum
 * from `run_cost_entries` for every day that has any entries.
 *
 * Returns the set of dates where the aggregate diverges from the
 * ledger sum, with both values so callers can log the drift. An empty
 * array means the invariant holds.
 */
export function verifyCostLedgerIntegrity(db: Database.Database): Array<{
  date: string
  aggregateUsd: number
  ledgerUsd: number
  deltaUsd: number
}> {
  const rows = db
    .prepare(
      `SELECT
         l.date AS date,
         COALESCE(l.ledger_usd, 0) AS ledger_usd,
         COALESCE(d.total_cost_usd, 0) AS aggregate_usd
       FROM (
         SELECT date(created_at) AS date, SUM(cost_usd) AS ledger_usd
         FROM run_cost_entries
         GROUP BY date(created_at)
       ) l
       LEFT JOIN daily_costs d ON d.date = l.date`,
    )
    .all() as Array<{
    date: string
    ledger_usd: number
    aggregate_usd: number
  }>

  const divergent: Array<{
    date: string
    aggregateUsd: number
    ledgerUsd: number
    deltaUsd: number
  }> = []
  for (const row of rows) {
    const delta = row.aggregate_usd - row.ledger_usd
    if (Math.abs(delta) > 1e-6) {
      divergent.push({
        date: row.date,
        aggregateUsd: row.aggregate_usd,
        ledgerUsd: row.ledger_usd,
        deltaUsd: delta,
      })
    }
  }
  return divergent
}
