import type Database from 'better-sqlite3'
import { loadRuns } from '../../state/run-list.js'
import type { LoadRunsOptions, RunListRow } from '../../state/run-list.js'
import { listHandoffs, type AgentHandoff } from '../../state/handoffs.js'
import { parseUtcTimestampMs } from '../../utils/time.js'

export interface IssueListRow {
  key: string
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

export type HandoffRow = AgentHandoff

export { loadRuns, type LoadRunsOptions, type RunListRow }

export function buildIssueList(runs: RunListRow[]): IssueListRow[] {
  const byIssue = new Map<string, IssueListRow>()

  for (const run of runs) {
    const syntheticIssueRow = run.run_id === null
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
        prompt_tokens: run.prompt_tokens,
        completion_tokens: run.completion_tokens,
        cache_read_tokens: run.cache_read_tokens,
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
      existing.prompt_tokens = run.prompt_tokens
      existing.completion_tokens = run.completion_tokens
      existing.cache_read_tokens = run.cache_read_tokens
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
  const parsed = parseUtcTimestampMs(value)
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

export function loadHandoffs(db: Database.Database, runId: string): HandoffRow[] {
  return listHandoffs(db, runId)
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
