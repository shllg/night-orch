import type Database from 'better-sqlite3'

/**
 * Add a per-run cost budget override.
 *
 * When non-null, the value is treated as this run's replacement per-run cap
 * (in USD) AND the run is exempted from the global daily cap. Operators set
 * it from the CLI/TUI/MCP/web when an in-flight run would otherwise be
 * blocked by a cost limit they accept for this specific run.
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'runs', 'cost_budget_override_usd')) {
    db.exec('ALTER TABLE runs ADD COLUMN cost_budget_override_usd REAL')
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
