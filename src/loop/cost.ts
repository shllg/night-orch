import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import { IssueManager } from '../state/issues.js'
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

  isOverBudget(runId: string, limits: Config['security']): boolean {
    const dailyCost = this.getDailyCost()
    if (dailyCost >= limits.maxDailyCostUsd) return true

    const runCost = this.getRunCost(runId)
    if (runCost >= limits.maxCostPerRunUsd) return true

    return false
  }
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
