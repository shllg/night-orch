import type Database from 'better-sqlite3'

/**
 * Layer-2 (theoretical) cost columns.
 *
 * The cost ledger previously tracked a single `cost_usd` — the *real*
 * subscription-normalized charge (layer 3), which is $0 under a
 * subscription plan. That collapses two distinct numbers:
 *
 *  - **theoretical cost** = tokens × list price, i.e. what the work
 *    WOULD cost on metered pay-per-use pricing. Always > 0 when tokens
 *    were spent, regardless of billing model.
 *  - **real cost** = what was actually charged ($0 inside a
 *    subscription quota; > 0 once metered or overflowed).
 *
 * Recording both lets reports show subscription savings and — combined
 * with `cost.subscriptionQuota` — detect when the included quota is
 * exhausted and billing swaps to usage-based. Columns are additive and
 * default to 0; existing rows keep `theoretical = 0` (back-compat:
 * historical rows already carry real cost in `cost_usd`).
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'run_cost_entries', 'theoretical_cost_usd')) {
    db.exec(
      `ALTER TABLE run_cost_entries ADD COLUMN theoretical_cost_usd REAL NOT NULL DEFAULT 0`,
    )
  }
  if (!hasColumn(db, 'runs', 'theoretical_cost_usd')) {
    db.exec(`ALTER TABLE runs ADD COLUMN theoretical_cost_usd REAL NOT NULL DEFAULT 0`)
  }
  if (!hasColumn(db, 'daily_costs', 'total_theoretical_cost_usd')) {
    db.exec(
      `ALTER TABLE daily_costs ADD COLUMN total_theoretical_cost_usd REAL NOT NULL DEFAULT 0`,
    )
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
