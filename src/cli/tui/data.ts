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
  updated_at: string
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

export function loadRuns(db: Database.Database, limit = 24): RunListRow[] {
  return db
    .prepare(
      `SELECT
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
             ORDER BY datetime(r2.updated_at) DESC
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
             ORDER BY datetime(rp.updated_at) DESC
             LIMIT 1
           )
         ) AS pr_title,
         r.updated_at
       FROM runs r
       ORDER BY
         CASE r.status
           WHEN 'running' THEN 0
           WHEN 'queued' THEN 1
           WHEN 'review_ready' THEN 2
           WHEN 'blocked' THEN 3
           WHEN 'error' THEN 4
           ELSE 5
         END,
         datetime(r.updated_at) DESC
       LIMIT ?`,
    )
    .all(limit) as RunListRow[]
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
