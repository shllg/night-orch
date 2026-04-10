import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_log_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      phase TEXT,
      role TEXT,
      event_type TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_log_events_run_id ON run_log_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_run_log_events_created ON run_log_events(created_at);
  `)
}
