import type Database from 'better-sqlite3'
import type { TokenUsage } from '../../workers/types.js'
import type { IssueManager } from '../../state/issues.js'

/**
 * Append-only cost ledger writer. Extracted from `cost.ts` in R4d so
 * the transactional persist path lives next to the helpers that
 * normalize token usage. No mutation of prior entries — every call is
 * an INSERT into `run_cost_entries` plus the corresponding upserts on
 * `daily_costs` and `runs`.
 */

export type TokenUsageInput = TokenUsage

export interface TokenUsageTotals {
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

/**
 * Provenance tag for a cost-ledger entry. Each recorder call must
 * declare where the token counts came from so reports can flag
 * degraded-confidence rows:
 *
 *  - `reported_cli` — extracted from a Claude/Codex/opencode CLI
 *    response (the normal path for code-editing work).
 *  - `measured_api` — returned directly by a provider API call (Phase 3
 *    `OrchestratorAI` hook; same precision as CLI but different code path).
 *  - `estimated_duration` — explicit opt-in fallback, only legal when
 *    `cost.allowEstimatedDuration: true`. R4a throws instead of writing
 *    this tag by default because the duration estimate undercounted by
 *    10–100× in production.
 *  - `fallback_zero` — reserved for audit rows when the recorder is
 *    called with a zero token count that came from somewhere other
 *    than a real worker (e.g. subscription-mode runs that never
 *    reported usage but we still want to track the attempt).
 */
export type TokenSource =
  | 'reported_cli'
  | 'measured_api'
  | 'estimated_duration'
  | 'fallback_zero'

export interface CostRecordMetadata {
  stepId?: string
  workerType?: string | null
  /**
   * Provenance of the token counts being recorded. Defaults to
   * `'reported_cli'` for back-compat with existing call sites; engine
   * code that knows it's recording a duration-estimate or API-measured
   * row should pass the explicit value.
   */
  tokenSource?: TokenSource
}

export function normalizeTokenUsage(tokenUsage: TokenUsageInput | undefined): TokenUsageTotals {
  const promptTokens = normalizeTokenCount(tokenUsage?.promptTokens)
  const completionTokens = normalizeTokenCount(tokenUsage?.completionTokens)
  const cacheReadTokens = normalizeTokenCount(tokenUsage?.cacheReadTokens)
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    totalTokens: promptTokens + completionTokens + cacheReadTokens,
  }
}

function normalizeTokenCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/**
 * Persist a single cost-ledger entry. Must run inside a SQLite
 * transaction — the caller is responsible for wrapping this in
 * `db.transaction(...)` so the four writes land atomically.
 */
export function persistCostRecord(
  db: Database.Database,
  issueManager: IssueManager,
  runId: string,
  date: string,
  usage: TokenUsageTotals,
  usdAmount: number,
  costStepId: string | null,
  costWorkerType: string | null,
  tokenSource: TokenSource,
): void {
  const runUsageInsert = db
    .prepare(
      `INSERT INTO daily_run_usage (date, run_id)
       VALUES (?, ?)
       ON CONFLICT(date, run_id) DO NOTHING`,
    )
    .run(date, runId)
  const dailyRunCountIncrement = runUsageInsert.changes > 0 ? 1 : 0

  db
    .prepare(
      `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total_cost_usd = total_cost_usd + excluded.total_cost_usd,
         run_count = run_count + excluded.run_count,
         total_prompt_tokens = total_prompt_tokens + excluded.total_prompt_tokens,
         total_completion_tokens = total_completion_tokens + excluded.total_completion_tokens,
         total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens`,
    )
    .run(
      date,
      usdAmount,
      dailyRunCountIncrement,
      usage.promptTokens,
      usage.completionTokens,
      usage.cacheReadTokens,
    )

  db
    .prepare(
      `UPDATE runs
       SET estimated_cost_usd = estimated_cost_usd + ?,
           prompt_tokens = prompt_tokens + ?,
           completion_tokens = completion_tokens + ?,
           cache_read_tokens = cache_read_tokens + ?
       WHERE id = ?`,
    )
    .run(usdAmount, usage.promptTokens, usage.completionTokens, usage.cacheReadTokens, runId)

  if (costStepId !== null) {
    db
      .prepare(
        `INSERT INTO run_cost_entries (
           run_id,
           step_id,
           worker_type,
           cost_usd,
           prompt_tokens,
           completion_tokens,
           cache_read_tokens,
           token_source
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        costStepId,
        costWorkerType,
        usdAmount,
        usage.promptTokens,
        usage.completionTokens,
        usage.cacheReadTokens,
        tokenSource,
      )
  }

  issueManager.syncFromRunId(runId)
}
