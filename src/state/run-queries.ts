import type Database from 'better-sqlite3'
import type { RunListRow } from './run-list.js'

export interface RunTimingRow {
  id: string
  started_at: string | null
  ended_at: string | null
}

export type HistoryRunRow = Pick<
  RunListRow,
  | 'id'
  | 'repo'
  | 'issue_number'
  | 'status'
  | 'issue_title'
  | 'pr_number'
  | 'current_phase'
  | 'iteration_count'
  | 'estimated_cost_usd'
  | 'prompt_tokens'
  | 'completion_tokens'
  | 'cache_read_tokens'
  | 'last_error'
> & RunTimingRow

export type RecentCompletedRow = Pick<RunListRow, 'id' | 'repo' | 'issue_number' | 'status'> & {
  ended_at: string | null
}

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

export interface DailyCostRow {
  date: string
  total_cost_usd: number
  run_count: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_cache_read_tokens: number
}

export interface QueryRunHistoryPageOptions {
  repo?: string
  statuses?: string[]
  limit: number
  offset: number
}

export interface RunPage<T> {
  rows: T[]
  hasMore: boolean
}

export function queryRunHistoryPage(
  db: Database.Database,
  options: QueryRunHistoryPageOptions,
): RunPage<HistoryRunRow> {
  const params: unknown[] = []
  const conditions: string[] = []

  if (options.repo) {
    conditions.push('r.repo = ?')
    params.push(options.repo)
  }

  if (options.statuses && options.statuses.length > 0) {
    const placeholders = options.statuses.map(() => '?').join(', ')
    conditions.push(`r.status IN (${placeholders})`)
    params.push(...options.statuses)
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : ''

  params.push(options.limit + 1, options.offset)

  const rows = db
    .prepare<unknown[], HistoryRunRow>(
      `SELECT
         r.id,
         r.repo,
         r.issue_number,
         r.status,
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
         r.pr_number,
         r.current_phase,
         r.iteration_count,
         r.estimated_cost_usd,
         r.prompt_tokens,
         r.completion_tokens,
         r.cache_read_tokens,
         r.last_error,
         r.started_at,
         r.ended_at
       FROM runs r
       ${whereClause}
       ORDER BY
         COALESCE(julianday(r.created_at), 0) DESC,
         COALESCE(julianday(r.updated_at), 0) DESC,
         r.rowid DESC,
         r.id DESC
       LIMIT ?
       OFFSET ?`,
    )
    .all(...params)

  const hasMore = rows.length > options.limit
  return {
    rows: hasMore ? rows.slice(0, options.limit) : rows,
    hasMore,
  }
}

export function loadRunTimingsByRunId(
  db: Database.Database,
  runIds: string[],
): Map<string, RunTimingRow> {
  const uniqueRunIds = [...new Set(runIds)]
  if (uniqueRunIds.length === 0) {
    return new Map()
  }

  const placeholders = uniqueRunIds.map(() => '?').join(', ')
  const rows = db
    .prepare<unknown[], RunTimingRow>(`SELECT id, started_at, ended_at FROM runs WHERE id IN (${placeholders})`)
    .all(...uniqueRunIds)

  return new Map(rows.map((row) => [row.id, row]))
}

export function loadRecentCompletedRuns(db: Database.Database, repo?: string): RecentCompletedRow[] {
  const recentSql = repo
    ? "SELECT * FROM runs WHERE status = 'completed' AND repo = ? ORDER BY updated_at DESC LIMIT 10"
    : "SELECT * FROM runs WHERE status = 'completed' ORDER BY updated_at DESC LIMIT 10"

  return repo
    ? db.prepare<[string], RecentCompletedRow>(recentSql).all(repo)
    : db.prepare<[], RecentCompletedRow>(recentSql).all()
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

export function loadDailyCostRows(db: Database.Database, days: number): DailyCostRow[] {
  return db
    .prepare<[number], DailyCostRow>(
      `SELECT
         date,
         total_cost_usd,
         run_count,
         total_prompt_tokens,
         total_completion_tokens,
         total_cache_read_tokens
       FROM daily_costs
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(days)
}
