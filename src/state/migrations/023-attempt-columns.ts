import type Database from 'better-sqlite3'

/**
 * Introduce the immutable-attempts model on the existing `runs` table.
 *
 * Semantic shift: a `runs` row is now an immutable *attempt*. The logical
 * "run" becomes the chain of attempts sharing `(repo, issue_number)`, linked
 * through the existing `parent_run_id` column (added in migration 006) which
 * is now the attempt-chain pointer. retry/continue/rebase INSERT new rows
 * linked to the prior attempt instead of mutating history.
 *
 * Columns added:
 *  - sequence_number: monotonic within a (repo, issue_number) chain, starts at 1
 *  - intent:          'initial' | 'retry' | 'continue' | 'rebase' | 'rediscover'
 *  - terminated_at:   set once a row reaches a terminal state; thereafter the
 *                     application-layer AttemptController rejects any mutation
 *                     to this row. Enforced in `src/state/attempts.ts` (R0b).
 *
 * No data backfill is needed for `sequence_number` / `intent` — existing rows
 * get the column defaults (`1` and `'initial'`), which is semantically correct
 * for rows that pre-date the attempts model.
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'runs', 'sequence_number')) {
    db.exec(`ALTER TABLE runs ADD COLUMN sequence_number INTEGER NOT NULL DEFAULT 1`)
  }
  if (!hasColumn(db, 'runs', 'intent')) {
    db.exec(`ALTER TABLE runs ADD COLUMN intent TEXT NOT NULL DEFAULT 'initial'`)
  }
  if (!hasColumn(db, 'runs', 'terminated_at')) {
    db.exec(`ALTER TABLE runs ADD COLUMN terminated_at TEXT`)
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id)`)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_runs_repo_issue_seq ON runs(repo, issue_number, sequence_number)`,
  )
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
