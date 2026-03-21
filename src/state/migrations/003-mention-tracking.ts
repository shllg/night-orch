import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS mention_tracking (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      mention_key TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      posted_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (repo, pr_number, mention_key, commit_sha)
    )
  `).run()
}
