import type Database from 'better-sqlite3'

export interface InboxIssueRow {
  repo: string
  issue_number: number
  issue_title: string | null
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
  block_reason: string | null
  pr_number: number | null
  pr_title: string | null
  updated_at: string | null
  run_id: string | null
  manual_state: string | null
  operation_intent: string | null
}

export function loadInboxIssueRows(db: Database.Database, repo?: string): InboxIssueRow[] {
  const params: unknown[] = []
  const where = [`i.status IN ('blocked', 'review_ready', 'error')`]

  if (repo) {
    where.push('i.repo = ?')
    params.push(repo)
  }

  return db
    .prepare<unknown[], InboxIssueRow>(
      `SELECT
         i.repo,
         i.issue_number,
         i.issue_title,
         i.status,
         i.current_phase,
         i.iteration_count,
         i.estimated_cost_usd,
         i.last_error,
         i.block_reason,
         i.pr_number,
         i.pr_title,
         i.updated_at,
         r.id AS run_id,
         r.manual_state,
         r.operation_intent
       FROM issues i
       LEFT JOIN runs r ON r.id = i.current_run_id
       WHERE ${where.join(' AND ')}`,
    )
    .all(...params)
}
