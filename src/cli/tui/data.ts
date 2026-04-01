import type Database from 'better-sqlite3'

export interface RunListRow {
  id: string
  repo: string
  issue_number: number
  issue_title: string | null
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
  pr_number: number | null
  pr_title: string | null
  created_at: string
  updated_at: string
}

export interface IssueListRow {
  key: string
  repo: string
  issue_number: number
  issue_title: string | null
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
  pr_number: number | null
  pr_title: string | null
  created_at: string
  updated_at: string
  runs: RunListRow[]
}

export interface AgentEventRow {
  id: number
  run_id: string
  role: string
  event_type: string
  data: string | null
  created_at: string
}

export interface MergeBatchRow {
  id: string
  repo: string
  status: string
  pr_numbers: string
}

export function loadRuns(db: Database.Database, limit?: number): RunListRow[] {
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
         FROM runs r
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
       ),
       issue_override_rows AS (
         SELECT
           'issue:' || i.repo || '#' || i.issue_number AS id,
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
         repo,
         issue_number,
         issue_title,
         status,
         current_phase,
         iteration_count,
         estimated_cost_usd,
         last_error,
         pr_number,
         pr_title,
         created_at,
         updated_at
       FROM visible_rows
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

  const limitedQuery = typeof limit === 'number' ? `${query}\n       LIMIT ?` : query
  const stmt = db.prepare(limitedQuery)
  return (typeof limit === 'number' ? stmt.all(limit) : stmt.all()) as RunListRow[]
}

export function buildIssueList(runs: RunListRow[]): IssueListRow[] {
  const byIssue = new Map<string, IssueListRow>()

  for (const run of runs) {
    const syntheticIssueRow = run.id.startsWith('issue:')
    const key = `${run.repo}#${run.issue_number}`
    const existing = byIssue.get(key)

    if (!existing) {
      byIssue.set(key, {
        key,
        repo: run.repo,
        issue_number: run.issue_number,
        issue_title: run.issue_title,
        status: run.status,
        current_phase: run.current_phase,
        iteration_count: run.iteration_count,
        estimated_cost_usd: run.estimated_cost_usd,
        last_error: run.last_error,
        pr_number: run.pr_number,
        pr_title: run.pr_title,
        created_at: run.created_at,
        updated_at: run.updated_at,
        runs: syntheticIssueRow ? [] : [run],
      })
      continue
    }

    if (!syntheticIssueRow) {
      existing.runs.push(run)
    }

    const existingCreated = parseTimestamp(existing.created_at)
    const candidateCreated = parseTimestamp(run.created_at)
    const existingUpdated = parseTimestamp(existing.updated_at)
    const candidateUpdated = parseTimestamp(run.updated_at)
    if (
      candidateCreated > existingCreated ||
      (candidateCreated === existingCreated && candidateUpdated > existingUpdated)
    ) {
      existing.issue_title = run.issue_title
      existing.status = run.status
      existing.current_phase = run.current_phase
      existing.iteration_count = run.iteration_count
      existing.estimated_cost_usd = run.estimated_cost_usd
      existing.last_error = run.last_error
      existing.pr_number = run.pr_number
      existing.pr_title = run.pr_title
      existing.created_at = run.created_at
      existing.updated_at = run.updated_at
    }
  }

  const statusOrder: Record<string, number> = {
    running: 0,
    queued: 1,
    review_ready: 2,
    blocked: 3,
    error: 4,
    completed: 5,
  }

  const issues = [...byIssue.values()]

  for (const issue of issues) {
    issue.runs.sort(compareRunRecency)
  }

  issues.sort((a, b) => {
    const statusDelta = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
    if (statusDelta !== 0) return statusDelta
    const createdDelta = parseTimestamp(b.created_at) - parseTimestamp(a.created_at)
    if (createdDelta !== 0) return createdDelta
    return parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at)
  })

  return issues.filter((issue) => issue.status !== 'completed')
}

function compareRunRecency(a: RunListRow, b: RunListRow): number {
  const createdDelta = parseTimestamp(b.created_at) - parseTimestamp(a.created_at)
  if (createdDelta !== 0) return createdDelta
  return parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at)
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

export function loadAgentEvents(db: Database.Database, runId: string, maxLines: number): AgentEventRow[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, role, event_type, data, created_at
       FROM agent_events
       WHERE run_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(runId, maxLines) as AgentEventRow[]
  return [...rows].reverse()
}

export function loadMergeBatches(db: Database.Database, limit = 5): MergeBatchRow[] {
  return db
    .prepare(
      `SELECT id, repo, status, pr_numbers
       FROM merge_batches
       WHERE status NOT IN ('passed', 'failed')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as MergeBatchRow[]
}
