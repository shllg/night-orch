import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, created_at)').run()
}

