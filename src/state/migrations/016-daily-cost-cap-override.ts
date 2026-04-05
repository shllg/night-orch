import type Database from 'better-sqlite3'

/**
 * Add a per-day daily cost cap override.
 *
 * When non-null on a given `daily_costs` row, the value replaces the global
 * `security.maxDailyCostUsd` cap for that UTC day. The override is scoped to
 * a single date row, so it auto-expires when the day rolls over at 00:00 UTC
 * — the next day's row is created with a NULL override by default.
 *
 * Operators set this from CLI/TUI/MCP when the whole day is blocked and
 * raising the cap for every queued issue via the per-run override would be
 * impractical.
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'daily_costs', 'daily_cost_cap_override_usd')) {
    db.exec('ALTER TABLE daily_costs ADD COLUMN daily_cost_cap_override_usd REAL')
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
