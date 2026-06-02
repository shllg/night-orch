import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rebase_fanout_siblings (
      repo TEXT NOT NULL,
      source_pr_number INTEGER NOT NULL,
      sibling_pr_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'skipped', 'failed')),
      reason TEXT,
      message TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (repo, source_pr_number, sibling_pr_number)
    );

    CREATE INDEX IF NOT EXISTS idx_rebase_fanout_siblings_source
    ON rebase_fanout_siblings(repo, source_pr_number);
  `)

  if (!hasColumn(db, 'rebase_fanouts', 'failures_count')) {
    db.exec('ALTER TABLE rebase_fanouts ADD COLUMN failures_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'rebase_fanouts', 'source_merge_sha')) {
    db.exec('ALTER TABLE rebase_fanouts ADD COLUMN source_merge_sha TEXT')
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
