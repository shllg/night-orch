import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      from_role TEXT,
      to_role TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_md TEXT NOT NULL,
      content_json TEXT,
      token_usage TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_handoffs_run
    ON agent_handoffs(run_id, id);

    CREATE INDEX IF NOT EXISTS idx_handoffs_kind
    ON agent_handoffs(run_id, kind);
  `)
}
