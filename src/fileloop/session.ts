import type Database from 'better-sqlite3'
import { nowUtcIso } from '../utils/time.js'
import type {
  FileLoopSession,
  FileLoopSessionStatus,
  FileLoopStoppedReason,
} from './types.js'

interface RawFileLoopSessionRow {
  id: number
  repo: string
  branch: string
  worktree_path: string
  started_at: string
  ends_at: string
  status: string
  last_file_iter_at: string | null
  iterations: number | null
  files_touched: number | null
  total_cost_usd: number | null
  pr_number: number | null
  stopped_reason: string | null
  updated_at: string
}

export interface CreateFileLoopSessionParams {
  repo: string
  branch: string
  worktreePath: string
  startedAt?: string
  endsAt: string
  status?: FileLoopSessionStatus
}

export interface FileLoopSessionUpdate {
  branch?: string
  worktreePath?: string
  endsAt?: string
  status?: FileLoopSessionStatus
  lastFileIterAt?: string | null
  iterations?: number
  filesTouched?: number
  totalCostUsd?: number
  prNumber?: number | null
  stoppedReason?: FileLoopStoppedReason
}

export class FileLoopSessionStore {
  constructor(private readonly db: Database.Database) {}

  create(params: CreateFileLoopSessionParams): FileLoopSession {
    const startedAt = params.startedAt ?? nowUtcIso()
    const updatedAt = startedAt
    const status = params.status ?? 'armed'

    const result = this.db
      .prepare(
        `INSERT INTO file_loop_sessions (
          repo, branch, worktree_path, started_at, ends_at, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.repo,
        params.branch,
        params.worktreePath,
        startedAt,
        params.endsAt,
        status,
        updatedAt,
      )

    return this.getById(Number(result.lastInsertRowid))!
  }

  getById(id: number): FileLoopSession | null {
    const row = this.db
      .prepare('SELECT * FROM file_loop_sessions WHERE id = ?')
      .get(id) as RawFileLoopSessionRow | undefined
    return row ? mapSessionRow(row) : null
  }

  getActive(repo: string): FileLoopSession | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM file_loop_sessions
         WHERE repo = ?
           AND status IN ('armed', 'running', 'paused', 'finalizing')
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(repo) as RawFileLoopSessionRow | undefined
    return row ? mapSessionRow(row) : null
  }

  listRecent(repo?: string, limit = 20): FileLoopSession[] {
    const rows = repo
      ? this.db
        .prepare(
          `SELECT *
           FROM file_loop_sessions
           WHERE repo = ?
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(repo, limit) as RawFileLoopSessionRow[]
      : this.db
        .prepare(
          `SELECT *
           FROM file_loop_sessions
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(limit) as RawFileLoopSessionRow[]
    return rows.map(mapSessionRow)
  }

  update(id: number, fields: FileLoopSessionUpdate): void {
    const setClauses: string[] = []
    const values: unknown[] = []
    const columnMap: Record<keyof FileLoopSessionUpdate, string> = {
      branch: 'branch',
      worktreePath: 'worktree_path',
      endsAt: 'ends_at',
      status: 'status',
      lastFileIterAt: 'last_file_iter_at',
      iterations: 'iterations',
      filesTouched: 'files_touched',
      totalCostUsd: 'total_cost_usd',
      prNumber: 'pr_number',
      stoppedReason: 'stopped_reason',
    }

    for (const [key, value] of Object.entries(fields) as Array<[keyof FileLoopSessionUpdate, unknown]>) {
      if (value === undefined) continue
      setClauses.push(`${columnMap[key]} = ?`)
      values.push(value)
    }

    if (setClauses.length === 0) return

    setClauses.push('updated_at = ?')
    values.push(nowUtcIso())
    values.push(id)

    this.db
      .prepare(`UPDATE file_loop_sessions SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  pause(id: number): void {
    this.update(id, { status: 'paused' })
  }

  resume(id: number): void {
    this.update(id, { status: 'running' })
  }

  requestFinalize(id: number, reason: Exclude<FileLoopStoppedReason, null>): void {
    this.update(id, { status: 'finalizing', stoppedReason: reason })
  }

  markDone(id: number, reason: FileLoopStoppedReason, prNumber?: number | null): void {
    this.update(id, { status: 'done', stoppedReason: reason, prNumber })
  }

  markFailed(id: number, reason: Exclude<FileLoopStoppedReason, null> = 'error'): void {
    this.update(id, { status: 'failed', stoppedReason: reason })
  }
}

function mapSessionRow(row: RawFileLoopSessionRow): FileLoopSession {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    worktreePath: row.worktree_path,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    status: coerceSessionStatus(row.status),
    lastFileIterAt: row.last_file_iter_at,
    iterations: row.iterations ?? 0,
    filesTouched: row.files_touched ?? 0,
    totalCostUsd: row.total_cost_usd ?? 0,
    prNumber: row.pr_number,
    stoppedReason: coerceStoppedReason(row.stopped_reason),
    updatedAt: row.updated_at,
  }
}

function coerceSessionStatus(value: string): FileLoopSessionStatus {
  switch (value) {
    case 'armed':
    case 'running':
    case 'paused':
    case 'finalizing':
    case 'done':
    case 'failed':
    case 'cancelled':
      return value
    default:
      return 'failed'
  }
}

function coerceStoppedReason(value: string | null): FileLoopStoppedReason {
  switch (value) {
    case 'timer':
    case 'manual':
    case 'budget':
    case 'error':
    case 'exhausted':
      return value
    default:
      return null
  }
}
