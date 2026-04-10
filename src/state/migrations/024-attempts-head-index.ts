import type Database from 'better-sqlite3'

/**
 * Replace the status-based active-run index with a `terminated_at`-based one
 * that enforces "exactly one live top-level attempt per (repo, issue_number)".
 *
 * Migration 019 defined `idx_runs_one_active_top_level_per_issue` filtered on
 * `status IN ('queued','running','blocked','review_ready','error')` plus
 * `parent_run_id IS NULL`. That filter reflected the old mutable-row model
 * where a single `runs` row was reused across retry/continue/rebase.
 *
 * R0c switches to immutable attempts: retry/continue/rebase INSERT new rows
 * and finalize the previous one by setting `terminated_at`. The correct
 * invariant becomes "only one non-terminated top-level row per issue" —
 * status is orthogonal (a terminated attempt can legitimately have
 * status='blocked' as its historical end state).
 *
 * Backfill: rows with status='completed' from the legacy model are
 * marked terminated using `ended_at` (or `updated_at`/`created_at` as
 * fallbacks) so the new unique index accepts them alongside later attempts.
 */
export function up(db: Database.Database): void {
  db.exec(`
    UPDATE runs
    SET terminated_at = COALESCE(ended_at, updated_at, created_at)
    WHERE status = 'completed' AND terminated_at IS NULL
  `)

  db.exec(`DROP INDEX IF EXISTS idx_runs_one_active_top_level_per_issue`)

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_live_top_level_per_issue
    ON runs(repo, issue_number)
    WHERE terminated_at IS NULL AND parent_run_id IS NULL
  `)
}
