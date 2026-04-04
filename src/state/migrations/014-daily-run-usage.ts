import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_run_usage (
      date TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (date, run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_run_usage_run_id
      ON daily_run_usage(run_id);
  `)
}
