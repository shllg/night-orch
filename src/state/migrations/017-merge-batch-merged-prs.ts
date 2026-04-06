import type Database from 'better-sqlite3'

/**
 * Persist the set of PRs actually merged into a staging branch.
 *
 * Previously the runner finalized with `batch.pr_numbers` — the original
 * intent — even though `buildStagingBranch` ejects conflicting PRs. That
 * caused ejected PRs to be closed as if merged. We now record the actual
 * merged subset at staging time and use it during finalization; ejected PRs
 * remain open and unqueued. NULL is treated as "unknown" (pre-migration
 * batches) and callers fall back to `pr_numbers`.
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'merge_batches', 'merged_pr_numbers')) {
    db.exec('ALTER TABLE merge_batches ADD COLUMN merged_pr_numbers TEXT')
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
