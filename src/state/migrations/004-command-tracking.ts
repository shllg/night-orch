import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS command_tracking (
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      command TEXT NOT NULL,
      processed_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (repo, issue_number, comment_id)
    )
  `).run()
}
