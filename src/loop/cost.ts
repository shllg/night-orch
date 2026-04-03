import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import { IssueManager } from '../state/issues.js'
import { utcDayKey } from '../utils/time.js'

export class CostTracker {
  private issueManager: IssueManager

  constructor(private db: Database.Database) {
    this.issueManager = new IssueManager(db)
  }

  recordCost(runId: string, costUsd: number): void {
    if (costUsd <= 0) return

    const today = utcDayKey()
    const tx = this.db.transaction((id: string, date: string, amountUsd: number) => {
      const row = this.db
        .prepare('SELECT estimated_cost_usd FROM runs WHERE id = ?')
        .get(id) as { estimated_cost_usd: number } | undefined
      const firstCostForRun = (row?.estimated_cost_usd ?? 0) <= 0

      this.db
        .prepare(
          `INSERT INTO daily_costs (date, total_cost_usd, run_count)
           VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET
             total_cost_usd = total_cost_usd + excluded.total_cost_usd,
             run_count = run_count + excluded.run_count`,
        )
        .run(date, amountUsd, firstCostForRun ? 1 : 0)

      this.db
        .prepare('UPDATE runs SET estimated_cost_usd = estimated_cost_usd + ? WHERE id = ?')
        .run(amountUsd, id)

      this.issueManager.syncFromRunId(id)
    })

    tx(runId, today, costUsd)
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

  isOverBudget(runId: string, limits: Config['security']): boolean {
    const dailyCost = this.getDailyCost()
    if (dailyCost >= limits.maxDailyCostUsd) return true

    const runCost = this.getRunCost(runId)
    if (runCost >= limits.maxCostPerRunUsd) return true

    return false
  }
}
