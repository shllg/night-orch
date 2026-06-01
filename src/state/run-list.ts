import type Database from 'better-sqlite3'

export interface RunListRow {
  id: string
  run_id: string | null
  repo: string
  issue_number: number
  issue_title: string | null
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read_tokens: number | null
  last_error: string | null
  pr_number: number | null
  pr_title: string | null
  created_at: string
  updated_at: string
}

export interface LoadRunsOptions {
  limit?: number
  offset?: number
  repo?: string
  status?: string
  /**
   * When false, rows whose `terminated_at` is set are excluded from the
   * result — i.e. only the one live head per `(repo, issue_number)` is
   * returned. This is what the web UI's "Active" tab and the MCP list
   * runs tool's default view want: superseded Continue/Retry predecessors
   * stay in the history panel instead of masquerading as duplicate
   * active rows.
   *
   * Defaults to `true` so the TUI's issue-grouped view (which renders
   * the full attempt chain under each issue) keeps its existing
   * behaviour.
   */
  includeTerminated?: boolean
}

export function loadRuns(
  db: Database.Database,
  limitOrOptions?: number | LoadRunsOptions,
): RunListRow[] {
  const options = typeof limitOrOptions === 'number'
    ? { limit: limitOrOptions }
    : (limitOrOptions ?? {})
  const includeTerminated = options.includeTerminated ?? true

  const conditions: string[] = []
  const params: unknown[] = []

  if (options.repo) {
    conditions.push('repo = ?')
    params.push(options.repo)
  }
  if (options.status) {
    conditions.push('status = ?')
    params.push(options.status)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // When `includeTerminated` is false, terminated attempts must be
  // excluded *before* the `ranked_runs` window function picks the top
  // row. Otherwise a chain like
  //   live queued <- terminated error (from /orch continue) <- terminated running
  // ranks the most-recently-created terminated row as run_rank=1, and the
  // active view shows the whole zombie chain.
  const runsSourceClause = includeTerminated
    ? 'FROM runs r'
    : 'FROM runs r WHERE r.terminated_at IS NULL'

  const query = `WITH ranked_runs AS (
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
         ${runsSourceClause}
       ),
       unresolved_issues AS (
         SELECT rr.repo, rr.issue_number
         FROM ranked_runs rr
         WHERE rr.run_rank = 1
           AND rr.status != 'completed'
         UNION
         SELECT i.repo, i.issue_number
         FROM issues i
         WHERE i.status != 'completed'
       ),
	       run_rows AS (
	         SELECT
	           r.id,
	           r.id AS run_id,
	           r.repo,
           r.issue_number,
           COALESCE(
             NULLIF(TRIM(r.issue_title), ''),
             (
               SELECT NULLIF(TRIM(r2.issue_title), '')
               FROM runs r2
               WHERE r2.repo = r.repo
                 AND r2.issue_number = r.issue_number
                 AND r2.issue_title IS NOT NULL
                 AND TRIM(r2.issue_title) != ''
               ORDER BY
                 COALESCE(julianday(r2.created_at), 0) DESC,
                 COALESCE(julianday(r2.updated_at), 0) DESC,
                 r2.rowid DESC,
                 r2.id DESC
               LIMIT 1
             )
           ) AS issue_title,
           r.status,
           r.current_phase,
           r.iteration_count,
           r.estimated_cost_usd,
           r.prompt_tokens,
           r.completion_tokens,
           r.cache_read_tokens,
           r.last_error,
           r.pr_number,
           COALESCE(
             NULLIF(TRIM(r.pr_title), ''),
             (
               SELECT NULLIF(TRIM(rp.pr_title), '')
               FROM runs rp
               WHERE rp.repo = r.repo
                 AND r.pr_number IS NOT NULL
                 AND rp.pr_number = r.pr_number
                 AND rp.pr_title IS NOT NULL
                 AND TRIM(rp.pr_title) != ''
               ORDER BY
                 COALESCE(julianday(rp.created_at), 0) DESC,
                 COALESCE(julianday(rp.updated_at), 0) DESC,
                 rp.rowid DESC,
                 rp.id DESC
               LIMIT 1
             )
           ) AS pr_title,
           r.created_at,
           r.updated_at
         FROM runs r
         INNER JOIN unresolved_issues u
           ON u.repo = r.repo
          AND u.issue_number = r.issue_number
         ${includeTerminated ? '' : 'WHERE r.terminated_at IS NULL'}
       ),
	       issue_override_rows AS (
	         SELECT
	           'issue:' || i.repo || '#' || i.issue_number AS id,
	           NULL AS run_id,
	           i.repo,
           i.issue_number,
           COALESCE(
             NULLIF(TRIM(i.issue_title), ''),
             (
               SELECT NULLIF(TRIM(r2.issue_title), '')
               FROM runs r2
               WHERE r2.repo = i.repo
                 AND r2.issue_number = i.issue_number
                 AND r2.issue_title IS NOT NULL
                 AND TRIM(r2.issue_title) != ''
               ORDER BY
                 COALESCE(julianday(r2.created_at), 0) DESC,
                 COALESCE(julianday(r2.updated_at), 0) DESC,
                 r2.rowid DESC,
                 r2.id DESC
               LIMIT 1
             )
           ) AS issue_title,
           i.status,
           i.current_phase,
           i.iteration_count,
           i.estimated_cost_usd,
           0 AS prompt_tokens,
           0 AS completion_tokens,
           0 AS cache_read_tokens,
           i.last_error,
           i.pr_number,
           COALESCE(
             NULLIF(TRIM(i.pr_title), ''),
             (
               SELECT NULLIF(TRIM(rp.pr_title), '')
               FROM runs rp
               WHERE rp.repo = i.repo
                 AND i.pr_number IS NOT NULL
                 AND rp.pr_number = i.pr_number
                 AND rp.pr_title IS NOT NULL
                 AND TRIM(rp.pr_title) != ''
               ORDER BY
                 COALESCE(julianday(rp.created_at), 0) DESC,
                 COALESCE(julianday(rp.updated_at), 0) DESC,
                 rp.rowid DESC,
                 rp.id DESC
               LIMIT 1
             )
           ) AS pr_title,
           i.created_at,
           i.updated_at
         FROM issues i
         WHERE i.status != 'completed'
           AND NOT EXISTS (
             SELECT 1
             FROM ranked_runs rr
             WHERE rr.repo = i.repo
               AND rr.issue_number = i.issue_number
               AND rr.run_rank = 1
               AND rr.status != 'completed'
           )
       ),
       visible_rows AS (
         SELECT * FROM run_rows
         UNION ALL
         SELECT * FROM issue_override_rows
       )
	       SELECT
	         id,
	         run_id,
	         repo,
         issue_number,
         issue_title,
         status,
         current_phase,
         iteration_count,
         estimated_cost_usd,
         prompt_tokens,
         completion_tokens,
         cache_read_tokens,
         last_error,
         pr_number,
         pr_title,
         created_at,
         updated_at
       FROM visible_rows
       ${whereClause}
       ORDER BY
         CASE status
           WHEN 'running' THEN 0
           WHEN 'queued' THEN 1
           WHEN 'review_ready' THEN 2
           WHEN 'blocked' THEN 3
           WHEN 'error' THEN 4
         ELSE 5
        END,
        COALESCE(julianday(created_at), 0) DESC,
        COALESCE(julianday(updated_at), 0) DESC,
        id DESC`

  const hasLimit = typeof options.limit === 'number'
  const hasOffset = typeof options.offset === 'number' && options.offset > 0

  let limitedQuery = query
  if (hasLimit) {
    limitedQuery = `${query}\n       LIMIT ?`
    params.push(options.limit!)
    if (hasOffset) {
      limitedQuery = `${limitedQuery}\n       OFFSET ?`
      params.push(options.offset!)
    }
  }

  const stmt = db.prepare<unknown[], RunListRow>(limitedQuery)
  return stmt.all(...params)
}
