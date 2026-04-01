import type Database from 'better-sqlite3'

export type IssueStatus = 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed'

export interface IssueRecord {
  repo: string
  issueNumber: number
  issueNodeId: string | null
  issueTitle: string | null
  status: IssueStatus
  planner: string | null
  coder: string | null
  reviewer: string | null
  currentPhase: string | null
  iterationCount: number
  estimatedCostUsd: number
  lastError: string | null
  blockReason: string | null
  prNumber: number | null
  prTitle: string | null
  branchName: string | null
  branchSlug: string | null
  worktreePath: string | null
  currentRunId: string | null
  lastRunId: string | null
  runCount: number
  createdAt: string
  updatedAt: string
}

export interface IssueRunPointerRow {
  repo: string
  issue_number: number
}

export interface DiscoveredIssueRow {
  repo: string
  issueNumber: number
  issueNodeId: string | null
  issueTitle: string | null
}

const ACTIVE_STATUSES = new Set<IssueStatus>(['queued', 'running', 'blocked', 'review_ready', 'error'])

interface RawLatestRunRow {
  id: string
  repo: string
  issue_number: number
  issue_node_id: string | null
  issue_title: string | null
  status: string
  planner: string | null
  coder: string | null
  reviewer: string | null
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
  block_reason: string | null
  pr_number: number | null
  pr_title: string | null
  branch_name: string | null
  branch_slug: string | null
  worktree_path: string | null
  updated_at: string
  first_created_at: string
  run_count: number
}

interface RawIssueRow {
  repo: string
  issue_number: number
  issue_node_id: string | null
  issue_title: string | null
  status: string
  planner: string | null
  coder: string | null
  reviewer: string | null
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
  block_reason: string | null
  pr_number: number | null
  pr_title: string | null
  branch_name: string | null
  branch_slug: string | null
  worktree_path: string | null
  current_run_id: string | null
  last_run_id: string | null
  run_count: number | null
  created_at: string
  updated_at: string
}

export class IssueManager {
  constructor(private db: Database.Database) {}

  get(repo: string, issueNumber: number): IssueRecord | null {
    const row = this.db
      .prepare('SELECT * FROM issues WHERE repo = ? AND issue_number = ?')
      .get(repo, issueNumber) as RawIssueRow | undefined
    return row ? mapIssueRow(row) : null
  }

  listActiveByRepo(repo: string): IssueRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM issues
         WHERE repo = ?
           AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
         ORDER BY issue_number`,
      )
      .all(repo) as RawIssueRow[]
    return rows.map(mapIssueRow)
  }

  syncFromRunId(runId: string): void {
    const run = this.db
      .prepare('SELECT repo, issue_number FROM runs WHERE id = ?')
      .get(runId) as IssueRunPointerRow | undefined
    if (!run) return
    this.syncFromIssue(run.repo, run.issue_number)
  }

  upsertDiscovered(rows: readonly DiscoveredIssueRow[]): void {
    if (rows.length === 0) return

    const stmt = this.db.prepare(
      `INSERT INTO issues (
         repo,
         issue_number,
         issue_node_id,
         issue_title,
         status,
         iteration_count,
         estimated_cost_usd,
         run_count,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, datetime('now'), datetime('now'))
       ON CONFLICT(repo, issue_number) DO UPDATE SET
         issue_node_id = COALESCE(excluded.issue_node_id, issues.issue_node_id),
         issue_title = COALESCE(excluded.issue_title, issues.issue_title),
         status = CASE
           WHEN issues.current_run_id IS NULL THEN 'queued'
           ELSE issues.status
         END,
         updated_at = datetime('now')`,
    )

    const tx = this.db.transaction((items: readonly DiscoveredIssueRow[]) => {
      for (const row of items) {
        stmt.run(
          row.repo,
          row.issueNumber,
          row.issueNodeId,
          row.issueTitle,
        )
      }
    })

    tx(rows)
  }

  syncFromIssue(repo: string, issueNumber: number): void {
    const latest = this.db
      .prepare(
        `SELECT
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
           r.iteration_count,
           r.estimated_cost_usd,
           r.last_error,
           r.block_reason,
           r.pr_number,
           r.pr_title,
           r.branch_name,
           r.branch_slug,
           r.worktree_path,
           r.updated_at,
           (
             SELECT MIN(r2.created_at)
             FROM runs r2
             WHERE r2.repo = r.repo
               AND r2.issue_number = r.issue_number
           ) AS first_created_at,
           (
             SELECT COUNT(*)
             FROM runs r3
             WHERE r3.repo = r.repo
               AND r3.issue_number = r.issue_number
           ) AS run_count
         FROM runs r
         WHERE r.repo = ?
           AND r.issue_number = ?
         ORDER BY
           COALESCE(julianday(r.created_at), 0) DESC,
           COALESCE(julianday(r.updated_at), 0) DESC,
           r.rowid DESC,
           r.id DESC
         LIMIT 1`,
      )
      .get(repo, issueNumber) as RawLatestRunRow | undefined

    if (!latest) return

    const currentRunId = ACTIVE_STATUSES.has(latest.status as IssueStatus) ? latest.id : null

    this.db
      .prepare(
        `INSERT INTO issues (
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
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           updated_at = excluded.updated_at`,
      )
      .run(
        latest.repo,
        latest.issue_number,
        latest.issue_node_id,
        latest.issue_title,
        latest.status,
        latest.planner,
        latest.coder,
        latest.reviewer,
        latest.current_phase,
        latest.iteration_count ?? 0,
        latest.estimated_cost_usd ?? 0,
        latest.last_error,
        latest.block_reason,
        latest.pr_number,
        latest.pr_title,
        latest.branch_name,
        latest.branch_slug,
        latest.worktree_path,
        currentRunId,
        latest.id,
        latest.run_count,
        latest.first_created_at,
        latest.updated_at,
      )
  }
}

function mapIssueRow(row: RawIssueRow): IssueRecord {
  return {
    repo: row.repo,
    issueNumber: row.issue_number,
    issueNodeId: row.issue_node_id,
    issueTitle: row.issue_title,
    status: row.status as IssueStatus,
    planner: row.planner,
    coder: row.coder,
    reviewer: row.reviewer,
    currentPhase: row.current_phase,
    iterationCount: row.iteration_count ?? 0,
    estimatedCostUsd: row.estimated_cost_usd ?? 0,
    lastError: row.last_error,
    blockReason: row.block_reason,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    branchName: row.branch_name,
    branchSlug: row.branch_slug,
    worktreePath: row.worktree_path,
    currentRunId: row.current_run_id,
    lastRunId: row.last_run_id,
    runCount: row.run_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
