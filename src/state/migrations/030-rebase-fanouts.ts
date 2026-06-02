import type Database from 'better-sqlite3'

/**
 * Idempotency marker for merge fan-out. Written once per source PR after
 * the fan-out loop completes. Pruned by retention after the replay window.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rebase_fanouts (
      repo TEXT NOT NULL,
      source_pr_number INTEGER NOT NULL,
      fanned_out_at TEXT NOT NULL,
      siblings_queued INTEGER NOT NULL,
      PRIMARY KEY (repo, source_pr_number)
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rebase_fanouts_age
    ON rebase_fanouts(fanned_out_at)
  `)
}
