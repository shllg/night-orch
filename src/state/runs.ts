import type Database from 'better-sqlite3'
import { generateRunId } from '../utils/ids.js'
import { nowUtcIso } from '../utils/time.js'
import { IssueManager } from './issues.js'

export type RunStatus = 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed'

export interface RunRecord {
  id: string
  repo: string
  issueNumber: number
  issueTitle: string | null
  issueNodeId: string | null
  status: RunStatus
  planner: string
  coder: string
  reviewer: string
  iterationCount: number
  currentPhase: string | null
  phaseData: Record<string, unknown> | null
  startedAt: string | null
  endedAt: string | null
  lastError: string | null
  prNumber: number | null
  prTitle: string | null
  branchName: string | null
  branchSlug: string | null
  worktreePath: string | null
  estimatedCostUsd: number
  blockReason: string | null
  parentRunId: string | null
}

export interface CreateRunParams {
  repo: string
  issueNumber: number
  issueTitle?: string | null
  issueNodeId: string | null
  planner: string
  coder: string
  reviewer: string
  parentRunId?: string | null
}

export class RunManager {
  private issueManager: IssueManager

  constructor(private db: Database.Database) {
    this.issueManager = new IssueManager(db)
  }

  create(params: CreateRunParams): RunRecord {
    const id = generateRunId()
    const now = nowUtcIso()

    const createTx = this.db.transaction(() => {
      const activeExisting = this.db
        .prepare(
          `SELECT id, status
           FROM runs
           WHERE repo = ?
             AND issue_number = ?
             AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
           LIMIT 1`,
        )
        .get(params.repo, params.issueNumber) as { id: string; status: string } | undefined

      if (activeExisting) {
        throw new Error(
          `Cannot create a new run for ${params.repo}#${params.issueNumber}: active run ${activeExisting.id} is ${activeExisting.status}`,
        )
      }

      this.db
        .prepare(
          `INSERT INTO runs (id, repo, issue_number, issue_title, issue_node_id, status, planner, coder, reviewer, parent_run_id, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.repo,
          params.issueNumber,
          params.issueTitle ?? null,
          params.issueNodeId,
          params.planner,
          params.coder,
          params.reviewer,
          params.parentRunId ?? null,
          now,
          now,
          now,
        )

      this.issueManager.syncFromRunId(id)
    })

    createTx()

    return this.getById(id)!
  }

  update(id: string, fields: Partial<RunRecord>): void {
    const allowed = [
      'status',
      'issueTitle',
      'iterationCount',
      'currentPhase',
      'phaseData',
      'endedAt',
      'lastError',
      'prNumber',
      'prTitle',
      'branchName',
      'branchSlug',
      'worktreePath',
      'estimatedCostUsd',
      'blockReason',
      'parentRunId',
    ] as const

    const columnMap: Record<string, string> = {
      issueNumber: 'issue_number',
      issueTitle: 'issue_title',
      issueNodeId: 'issue_node_id',
      iterationCount: 'iteration_count',
      currentPhase: 'current_phase',
      phaseData: 'phase_data',
      startedAt: 'started_at',
      endedAt: 'ended_at',
      lastError: 'last_error',
      prNumber: 'pr_number',
      prTitle: 'pr_title',
      branchName: 'branch_name',
      branchSlug: 'branch_slug',
      worktreePath: 'worktree_path',
      estimatedCostUsd: 'estimated_cost_usd',
      blockReason: 'block_reason',
      parentRunId: 'parent_run_id',
    }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const key of allowed) {
      if (key in fields) {
        const col = columnMap[key] ?? key
        let val: unknown = fields[key]
        if (key === 'phaseData' && val !== null) {
          val = JSON.stringify(val)
        }
        setClauses.push(`${col} = ?`)
        values.push(val)
      }
    }

    if (setClauses.length === 0) return

    setClauses.push('updated_at = ?')
    values.push(nowUtcIso())
    values.push(id)

    const updateTx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...values)
      this.issueManager.syncFromRunId(id)
    })

    updateTx()
  }

  getById(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getByRepoAndIssue(repo: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM runs
         WHERE repo = ?
           AND issue_number = ?
         ORDER BY
           COALESCE(julianday(created_at), 0) DESC,
           COALESCE(julianday(updated_at), 0) DESC,
           rowid DESC,
           id DESC
         LIMIT 1`,
      )
      .get(repo, issueNumber) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getLatestQueuedByIssue(repo: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND issue_number = ? AND status = 'queued' ORDER BY created_at DESC LIMIT 1")
      .get(repo, issueNumber) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  /**
   * Count consecutive recent errors for an issue (within the last hour).
   * Used to decide whether to auto-retry or give up.
   */
  countRecentErrors(repo: string, issueNumber: number, windowMinutes = 60): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM runs
         WHERE repo = ? AND issue_number = ? AND status = 'error'
         AND datetime(ended_at) > datetime('now', '-' || ? || ' minutes')`,
      )
      .get(repo, issueNumber, windowMinutes) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }

  /**
   * Get the most recent non-queued, non-running run for an issue,
   * excluding the current run. Used to check if prior work is tainted.
   */
  getLatestFinishedByIssue(repo: string, issueNumber: number, excludeRunId: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE repo = ? AND issue_number = ? AND id != ?
         AND status NOT IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, issueNumber, excludeRunId) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getActive(): RunRecord[] {
    const rows = this.db
      .prepare(
        `WITH ranked_runs AS (
           SELECT
             r.*,
             ROW_NUMBER() OVER (
               PARTITION BY r.repo, r.issue_number
               ORDER BY
                 COALESCE(julianday(r.created_at), 0) DESC,
                 COALESCE(julianday(r.updated_at), 0) DESC,
                 r.rowid DESC,
                 r.id DESC
             ) AS run_rank
           FROM runs r
         )
         SELECT *
         FROM ranked_runs
         WHERE run_rank = 1
           AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
         ORDER BY COALESCE(julianday(created_at), 0)`,
      )
      .all() as RawRunRow[]
    return rows.map((r) => this.mapRow(r))
  }

  getSubRuns(parentRunId: string): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at')
      .all(parentRunId) as RawRunRow[]
    return rows.map((r) => this.mapRow(r))
  }

  private mapRow(row: RawRunRow): RunRecord {
    return {
      id: row.id,
      repo: row.repo,
      issueNumber: row.issue_number,
      issueTitle: row.issue_title ?? null,
      issueNodeId: row.issue_node_id ?? null,
      status: row.status as RunStatus,
      planner: row.planner ?? '',
      coder: row.coder ?? '',
      reviewer: row.reviewer ?? '',
      iterationCount: row.iteration_count ?? 0,
      currentPhase: row.current_phase,
      phaseData: row.phase_data ? JSON.parse(row.phase_data) as Record<string, unknown> : null,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastError: row.last_error,
      prNumber: row.pr_number,
      prTitle: row.pr_title ?? null,
      branchName: row.branch_name,
      branchSlug: row.branch_slug,
      worktreePath: row.worktree_path,
      estimatedCostUsd: row.estimated_cost_usd ?? 0,
      blockReason: row.block_reason ?? null,
      parentRunId: row.parent_run_id ?? null,
    }
  }
}

interface RawRunRow {
  id: string
  repo: string
  issue_number: number
  issue_title: string | null
  issue_node_id: string | null
  status: string
  planner: string | null
  coder: string | null
  reviewer: string | null
  iteration_count: number | null
  current_phase: string | null
  phase_data: string | null
  started_at: string | null
  ended_at: string | null
  last_error: string | null
  pr_number: number | null
  pr_title: string | null
  branch_name: string | null
  branch_slug: string | null
  worktree_path: string | null
  estimated_cost_usd: number | null
  block_reason: string | null
  parent_run_id: string | null
}
