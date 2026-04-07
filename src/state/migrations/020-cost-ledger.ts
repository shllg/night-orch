import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  if (!hasColumn(db, 'runs', 'cache_read_tokens')) {
    db.exec('ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'daily_costs', 'total_cache_read_tokens')) {
    db.exec('ALTER TABLE daily_costs ADD COLUMN total_cache_read_tokens INTEGER NOT NULL DEFAULT 0')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      worker_type TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_run_cost_entries_run_step
      ON run_cost_entries(run_id, step_id);

    CREATE INDEX IF NOT EXISTS idx_run_cost_entries_created_at
      ON run_cost_entries(created_at);

    CREATE INDEX IF NOT EXISTS idx_run_cost_entries_worker_type
      ON run_cost_entries(worker_type);
  `)
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
