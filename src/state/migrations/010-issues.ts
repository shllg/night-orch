import type Database from 'better-sqlite3'

/**
 * Introduce canonical issue state while preserving run history:
 * - `issues` stores aggregate status and latest issue-level fields
 * - `runs` remains immutable attempt history
 * - one active run per issue is enforced at DB level
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_node_id TEXT,
      issue_title TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      planner TEXT,
      coder TEXT,
      reviewer TEXT,
      current_phase TEXT,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      last_error TEXT,
      block_reason TEXT,
      pr_number INTEGER,
      pr_title TEXT,
      branch_name TEXT,
      branch_slug TEXT,
      worktree_path TEXT,
      current_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      last_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo, issue_number)
    );

    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_issues_repo_status ON issues(repo, status);
    CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues(updated_at);
  `)

  // Resolve legacy invalid state before adding one-active-run-per-issue invariant.
  db.exec(`
    WITH ranked_active AS (
      SELECT
        id,
        repo,
        issue_number,
        ROW_NUMBER() OVER (
          PARTITION BY repo, issue_number
          ORDER BY
            COALESCE(julianday(created_at), 0) DESC,
            COALESCE(julianday(updated_at), 0) DESC,
            rowid DESC,
            id DESC
        ) AS active_rank
      FROM runs
      WHERE status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
    )
    UPDATE runs
    SET
      status = 'completed',
      ended_at = COALESCE(ended_at, datetime('now')),
      last_error = COALESCE(last_error, 'Superseded by newer active run during issues migration')
    WHERE id IN (
      SELECT id
      FROM ranked_active
      WHERE active_rank > 1
    );
  `)

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active_per_issue
    ON runs(repo, issue_number)
    WHERE status IN ('queued', 'running', 'blocked', 'review_ready', 'error');
  `)

  // Backfill / refresh issue aggregates from latest run per issue.
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
