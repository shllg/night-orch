import type Database from 'better-sqlite3'

export function hasActiveIssueRuns(repo: string, db: Database.Database): boolean {
  const row = db
    .prepare(
      `WITH ranked_runs AS (
         SELECT
           r.repo,
           r.issue_number,
           r.status,
           ROW_NUMBER() OVER (
             PARTITION BY r.repo, r.issue_number
             ORDER BY
               COALESCE(julianday(r.created_at), 0) DESC,
               COALESCE(julianday(r.updated_at), 0) DESC,
               r.rowid DESC,
               r.id DESC
           ) AS run_rank
         FROM runs r
         WHERE r.repo = ?
       )
       SELECT COUNT(*) AS count
       FROM ranked_runs
       WHERE run_rank = 1
         AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')`,
    )
    .get(repo) as { count: number }

  return row.count > 0
}
