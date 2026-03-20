import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'

export class CostTracker {
  constructor(private db: Database.Database) {}

  recordCost(runId: string, costUsd: number): void {
    const today = new Date().toISOString().split('T')[0]!

    // Update daily cost
    this.db
      .prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count)
         VALUES (?, ?, 1)
         ON CONFLICT(date) DO UPDATE SET
           total_cost_usd = total_cost_usd + ?,
           run_count = run_count + 1`,
      )
      .run(today, costUsd, costUsd)

    // Update run cost
    this.db
      .prepare('UPDATE runs SET estimated_cost_usd = estimated_cost_usd + ? WHERE id = ?')
      .run(costUsd, runId)
  }

  getDailyCost(): number {
    const today = new Date().toISOString().split('T')[0]!
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

  isOverBudget(runId: string, limits: Config['security']): boolean {
    const dailyCost = this.getDailyCost()
    if (dailyCost >= limits.maxDailyCostUsd) return true

    const runCost = this.getRunCost(runId)
    if (runCost >= limits.maxCostPerRunUsd) return true

    return false
  }
}
