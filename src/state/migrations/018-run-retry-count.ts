import type Database from 'better-sqlite3'

/**
 * Persist an auto-retry counter on each run row.
 *
 * Previously the poller counted rows in `runs` with status='error' within a
 * time window to enforce `maxAutoRetries`. But replay retries reuse a single
 * run row (transitioning error → queued → running → error on the same id),
 * so that count never exceeded 1 and retries could loop indefinitely. We
 * now increment `retry_count` on the same row each time we auto-retry and
 * enforce the limit against that column.
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'runs', 'retry_count')) {
    db.exec('ALTER TABLE runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0')
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
