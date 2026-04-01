import type Database from 'better-sqlite3'

/**
 * Repair issue aggregates by deriving from the latest run attempt per issue.
 * Use `created_at` as the primary ordering key so maintenance updates on older
 * runs (e.g. migration cleanup) cannot shadow newer attempts.
 */
export function up(db: Database.Database): void {
  db.exec(`
    WITH ranked_runs AS (
      SELECT
        r.id,
        r.repo,
        r.issue_number,
        r.issue_node_id,
        r.issue_title,
        r.status,
        r.planner,
        r.coder,
        r.reviewer,
        r.current_phase,
        COALESCE(r.iteration_count, 0) AS iteration_count,
        COALESCE(r.estimated_cost_usd, 0) AS estimated_cost_usd,
        r.last_error,
        r.block_reason,
        r.pr_number,
        r.pr_title,
        r.branch_name,
        r.branch_slug,
        r.worktree_path,
        r.created_at,
        r.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY r.repo, r.issue_number
          ORDER BY
            COALESCE(julianday(r.created_at), 0) DESC,
            COALESCE(julianday(r.updated_at), 0) DESC,
            r.rowid DESC,
            r.id DESC
        ) AS run_rank,
        COUNT(*) OVER (PARTITION BY r.repo, r.issue_number) AS run_count,
        MIN(r.created_at) OVER (PARTITION BY r.repo, r.issue_number) AS first_created_at
      FROM runs r
    ),
    latest_runs AS (
      SELECT *
      FROM ranked_runs
      WHERE run_rank = 1
    )
    INSERT INTO issues (
      repo,
      issue_number,
      issue_node_id,
      issue_title,
      status,
      planner,
      coder,
      reviewer,
      current_phase,
      iteration_count,
      estimated_cost_usd,
      last_error,
      block_reason,
      pr_number,
      pr_title,
      branch_name,
      branch_slug,
      worktree_path,
      current_run_id,
      last_run_id,
      run_count,
      created_at,
      updated_at
    )
    SELECT
      latest.repo,
      latest.issue_number,
      latest.issue_node_id,
      latest.issue_title,
      latest.status,
      latest.planner,
      latest.coder,
      latest.reviewer,
      latest.current_phase,
      latest.iteration_count,
      latest.estimated_cost_usd,
      latest.last_error,
      latest.block_reason,
      latest.pr_number,
      latest.pr_title,
      latest.branch_name,
      latest.branch_slug,
      latest.worktree_path,
      CASE
        WHEN latest.status IN ('queued', 'running', 'blocked', 'review_ready', 'error') THEN latest.id
        ELSE NULL
      END AS current_run_id,
      latest.id AS last_run_id,
      latest.run_count,
      latest.first_created_at,
      latest.updated_at
    FROM latest_runs latest
    WHERE 1 = 1
    ON CONFLICT(repo, issue_number) DO UPDATE SET
      issue_node_id = excluded.issue_node_id,
      issue_title = COALESCE(excluded.issue_title, issues.issue_title),
      status = excluded.status,
      planner = excluded.planner,
      coder = excluded.coder,
      reviewer = excluded.reviewer,
      current_phase = excluded.current_phase,
      iteration_count = excluded.iteration_count,
      estimated_cost_usd = excluded.estimated_cost_usd,
      last_error = excluded.last_error,
      block_reason = excluded.block_reason,
      pr_number = excluded.pr_number,
      pr_title = COALESCE(excluded.pr_title, issues.pr_title),
      branch_name = excluded.branch_name,
      branch_slug = excluded.branch_slug,
      worktree_path = excluded.worktree_path,
      current_run_id = excluded.current_run_id,
      last_run_id = excluded.last_run_id,
      run_count = excluded.run_count,
      updated_at = excluded.updated_at;
  `)
}
