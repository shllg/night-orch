import type Database from 'better-sqlite3'
import { generateRunId } from '../utils/ids.js'

export type RunStatus = 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed'

export interface RunRecord {
  id: string
  repo: string
  issueNumber: number
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
  branchName: string | null
  branchSlug: string | null
  worktreePath: string | null
  estimatedCostUsd: number
}

export interface CreateRunParams {
  repo: string
  issueNumber: number
  issueNodeId: string | null
  planner: string
  coder: string
  reviewer: string
}

export class RunManager {
  constructor(private db: Database.Database) {}

  create(params: CreateRunParams): RunRecord {
    const id = generateRunId()
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, planner, coder, reviewer, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.repo,
        params.issueNumber,
        params.issueNodeId,
        params.planner,
        params.coder,
        params.reviewer,
        now,
        now,
        now,
      )

    return this.getById(id)!
  }

  update(id: string, fields: Partial<RunRecord>): void {
    const allowed = [
      'status',
      'iterationCount',
      'currentPhase',
      'phaseData',
      'endedAt',
      'lastError',
      'prNumber',
      'branchName',
      'branchSlug',
      'worktreePath',
      'estimatedCostUsd',
    ] as const

    const columnMap: Record<string, string> = {
      issueNumber: 'issue_number',
      issueNodeId: 'issue_node_id',
      iterationCount: 'iteration_count',
      currentPhase: 'current_phase',
      phaseData: 'phase_data',
      startedAt: 'started_at',
      endedAt: 'ended_at',
      lastError: 'last_error',
      prNumber: 'pr_number',
      branchName: 'branch_name',
      branchSlug: 'branch_slug',
      worktreePath: 'worktree_path',
      estimatedCostUsd: 'estimated_cost_usd',
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

    setClauses.push("updated_at = datetime('now')")
    values.push(id)

    this.db
      .prepare(`UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  getById(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getByRepoAndIssue(repo: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC LIMIT 1')
      .get(repo, issueNumber) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getLatestQueuedByIssue(repo: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND issue_number = ? AND status = 'queued' ORDER BY created_at DESC LIMIT 1")
      .get(repo, issueNumber) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getActive(): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at")
      .all() as RawRunRow[]
    return rows.map((r) => this.mapRow(r))
  }

  private mapRow(row: RawRunRow): RunRecord {
    return {
      id: row.id,
      repo: row.repo,
      issueNumber: row.issue_number,
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
      branchName: row.branch_name,
      branchSlug: row.branch_slug,
      worktreePath: row.worktree_path,
      estimatedCostUsd: row.estimated_cost_usd ?? 0,
    }
  }
}

interface RawRunRow {
  id: string
  repo: string
  issue_number: number
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
  branch_name: string | null
  branch_slug: string | null
  worktree_path: string | null
  estimated_cost_usd: number | null
}
