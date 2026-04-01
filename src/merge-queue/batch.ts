import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { MergeBatchRecord, MergeBatchStatus } from './types.js'

/** Terminal statuses — a batch in one of these is no longer active. */
const TERMINAL_STATUSES: MergeBatchStatus[] = ['passed', 'failed']

export class MergeBatchManager {
  constructor(private db: Database.Database) {}

  create(params: {
    repo: string
    baseBranch: string
    baseSha: string
    prNumbers: number[]
    approvedShas: string[]
  }): MergeBatchRecord {
    const id = `batch-${nanoid(12)}`

    this.db
      .prepare(
        `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, pr_numbers, approved_shas)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        params.repo,
        params.baseBranch,
        params.baseSha,
        JSON.stringify(params.prNumbers),
        JSON.stringify(params.approvedShas),
      )

    return this.getById(id)!
  }

  getById(id: string): MergeBatchRecord | null {
    const row = this.db
      .prepare('SELECT * FROM merge_batches WHERE id = ?')
      .get(id) as RawBatchRow | undefined
    return row ? mapRow(row) : null
  }

  /** Returns the first non-terminal batch for a repo, or null if none exists. */
  getActiveBatch(repo: string): MergeBatchRecord | null {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ')
    const row = this.db
      .prepare(
        `SELECT * FROM merge_batches WHERE repo = ? AND status NOT IN (${placeholders}) ORDER BY created_at ASC LIMIT 1`,
      )
      .get(repo, ...TERMINAL_STATUSES) as RawBatchRow | undefined
    return row ? mapRow(row) : null
  }

  getByRepoAndStatus(repo: string, status: MergeBatchStatus): MergeBatchRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM merge_batches WHERE repo = ? AND status = ? ORDER BY created_at ASC')
      .all(repo, status) as RawBatchRow[]
    return rows.map(mapRow)
  }

  update(
    id: string,
    fields: Partial<
      Pick<MergeBatchRecord, 'status' | 'stagingBranch' | 'stagingSha' | 'retryCount' | 'parentBatchId'>
    >,
  ): void {
    const columnMap: Record<string, string> = {
      status: 'status',
      stagingBranch: 'staging_branch',
      stagingSha: 'staging_sha',
      retryCount: 'retry_count',
      parentBatchId: 'parent_batch_id',
    }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const [key, val] of Object.entries(fields)) {
      const col = columnMap[key]
      if (!col) {
        throw new Error(`Unknown merge batch field: ${key}`)
      }
      setClauses.push(`${col} = ?`)
      values.push(val)
    }

    if (setClauses.length === 0) return

    setClauses.push("updated_at = datetime('now')")
    values.push(id)

    this.db
      .prepare(`UPDATE merge_batches SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values)
  }
}

function mapRow(row: RawBatchRow): MergeBatchRecord {
  return {
    id: row.id,
    repo: row.repo,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    status: row.status as MergeBatchStatus,
    stagingBranch: row.staging_branch ?? null,
    stagingSha: row.staging_sha ?? null,
    prNumbers: parseJsonArray<number>(row.pr_numbers),
    approvedShas: parseJsonArray<string>(row.approved_shas),
    retryCount: row.retry_count ?? 0,
    parentBatchId: row.parent_batch_id ?? null,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  }
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

interface RawBatchRow {
  id: string
  repo: string
  base_branch: string
  base_sha: string
  status: string
  staging_branch: string | null
  staging_sha: string | null
  pr_numbers: string
  approved_shas: string
  retry_count: number | null
  parent_batch_id: string | null
  created_at: string | null
  updated_at: string | null
}
