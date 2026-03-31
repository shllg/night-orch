import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE merge_batches (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      staging_branch TEXT,
      staging_sha TEXT,
      pr_numbers TEXT NOT NULL,
      approved_shas TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0,
      parent_batch_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run()
  db.prepare('CREATE INDEX idx_merge_batches_repo_status ON merge_batches(repo, status)').run()
}
