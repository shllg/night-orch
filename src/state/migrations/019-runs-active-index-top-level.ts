import type Database from 'better-sqlite3'

/**
 * Relax the one-active-run-per-issue invariant to exclude sub-runs.
 *
 * Migration 010 enforced uniqueness across all active runs per (repo,
 * issue_number). But decomposition/parallel subtasks spawn sub-runs that
 * share the parent's repo/issue by design and are identified by a
 * non-null `parent_run_id`. The original index therefore made sub-runs
 * unable to be created.
 *
 * We drop the old index and create a replacement that only applies to
 * top-level runs (`parent_run_id IS NULL`). Sub-runs are still subject
 * to the application-level checks in `src/state/runs.ts`.
 */
export function up(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_runs_one_active_per_issue')
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active_top_level_per_issue
    ON runs(repo, issue_number)
    WHERE status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
      AND parent_run_id IS NULL
  `)
}
