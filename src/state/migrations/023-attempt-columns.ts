import type Database from 'better-sqlite3'

/**
 * Introduce the immutable-attempts model on the existing `runs` table.
 *
 * Semantic shift: a `runs` row is now an immutable *attempt*. The logical
 * "run" becomes the chain of attempts sharing `(repo, issue_number)`, linked
 * through a new `previous_attempt_id` column. retry/continue/rebase INSERT
 * new rows linked to the prior attempt instead of mutating history.
 *
 * `parent_run_id` (from migration 006) keeps its existing semantics —
 * it identifies a sub-run of a decomposed top-level run. The two pointers
 * are orthogonal: a sub-run can itself be retried, in which case the new
 * attempt has the same parent_run_id and a non-null previous_attempt_id.
 *
 * Columns added:
 *  - previous_attempt_id: prior attempt in the chain, null for the first
 *                         attempt. Separate from parent_run_id (which points
 *                         at a top-level decomposition parent).
 *  - sequence_number:     monotonic within a chain, starts at 1
 *  - intent:              'initial' | 'retry' | 'continue' | 'rebase' | 'rediscover'
 *  - terminated_at:       set once a row reaches a terminal state; thereafter
 *                         the application-layer AttemptController rejects any
 *                         mutation to this row. Enforced in `src/state/attempts.ts`.
 *
 * No data backfill is needed for `sequence_number` / `intent` — existing rows
 * get the column defaults (`1` and `'initial'`), which is semantically correct
 * for rows that pre-date the attempts model.
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'runs', 'previous_attempt_id')) {
    db.exec(
      `ALTER TABLE runs ADD COLUMN previous_attempt_id TEXT REFERENCES runs(id)`,
    )
  }
  if (!hasColumn(db, 'runs', 'sequence_number')) {
    db.exec(`ALTER TABLE runs ADD COLUMN sequence_number INTEGER NOT NULL DEFAULT 1`)
  }
  if (!hasColumn(db, 'runs', 'intent')) {
    db.exec(`ALTER TABLE runs ADD COLUMN intent TEXT NOT NULL DEFAULT 'initial'`)
  }
  if (!hasColumn(db, 'runs', 'terminated_at')) {
    db.exec(`ALTER TABLE runs ADD COLUMN terminated_at TEXT`)
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_previous_attempt ON runs(previous_attempt_id)`)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_runs_repo_issue_seq ON runs(repo, issue_number, sequence_number)`,
  )
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
