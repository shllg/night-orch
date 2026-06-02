import type Database from 'better-sqlite3'

export type FanoutSiblingStatus = 'queued' | 'skipped' | 'failed'

export interface FanoutSiblingRow {
  repo: string
  source_pr_number: number
  sibling_pr_number: number
  status: FanoutSiblingStatus
  reason: string | null
  message: string | null
  recorded_at: string
}

export interface FanoutRow {
  repo: string
  source_pr_number: number
  fanned_out_at: string
  siblings_queued: number
  failures_count: number
  source_merge_sha: string | null
}

export class RebaseFanoutManager {
  private static readonly inflight = new Map<string, Promise<unknown>>()

  constructor(private db: Database.Database) {}

  has(repo: string, sourcePrNumber: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM rebase_fanouts WHERE repo = ? AND source_pr_number = ?')
      .get(repo, sourcePrNumber)
    return row !== undefined
  }

  get(repo: string, sourcePrNumber: number): FanoutRow | undefined {
    return this.db
      .prepare(
        `SELECT repo, source_pr_number, fanned_out_at, siblings_queued, failures_count, source_merge_sha
         FROM rebase_fanouts
         WHERE repo = ? AND source_pr_number = ?`,
      )
      .get(repo, sourcePrNumber) as FanoutRow | undefined
  }

  mark(
    repo: string,
    sourcePrNumber: number,
    siblingsQueued: number,
    options: { failuresCount?: number; sourceMergeSha?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO rebase_fanouts
           (repo, source_pr_number, fanned_out_at, siblings_queued, failures_count, source_merge_sha)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo,
        sourcePrNumber,
        new Date().toISOString(),
        siblingsQueued,
        options.failuresCount ?? 0,
        options.sourceMergeSha ?? null,
      )
  }

  runOnce<T>(repo: string, sourcePrNumber: number, work: () => Promise<T>): Promise<T> {
    const key = `${repo}#${sourcePrNumber}`
    const existing = RebaseFanoutManager.inflight.get(key)
    if (existing !== undefined) {
      return existing as Promise<T>
    }

    const promise = work().finally(() => {
      RebaseFanoutManager.inflight.delete(key)
    })
    RebaseFanoutManager.inflight.set(key, promise)
    return promise
  }

  recordSibling(
    repo: string,
    sourcePrNumber: number,
    siblingPrNumber: number,
    outcome: { status: FanoutSiblingStatus; reason?: string; message?: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO rebase_fanout_siblings
           (repo, source_pr_number, sibling_pr_number, status, reason, message, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, source_pr_number, sibling_pr_number) DO UPDATE SET
           status = excluded.status,
           reason = excluded.reason,
           message = excluded.message,
           recorded_at = excluded.recorded_at`,
      )
      .run(
        repo,
        sourcePrNumber,
        siblingPrNumber,
        outcome.status,
        outcome.reason ?? null,
        outcome.message ?? null,
        new Date().toISOString(),
      )
  }

  listSiblings(repo: string, sourcePrNumber: number): FanoutSiblingRow[] {
    return this.db
      .prepare(
        `SELECT repo, source_pr_number, sibling_pr_number, status, reason, message, recorded_at
         FROM rebase_fanout_siblings
         WHERE repo = ? AND source_pr_number = ?
         ORDER BY sibling_pr_number ASC`,
      )
      .all(repo, sourcePrNumber) as FanoutSiblingRow[]
  }

  findIncomplete(): FanoutRow[] {
    return this.db
      .prepare(
        `SELECT repo, source_pr_number, fanned_out_at, siblings_queued, failures_count, source_merge_sha
         FROM rebase_fanouts
         WHERE failures_count > 0
         ORDER BY fanned_out_at ASC`,
      )
      .all() as FanoutRow[]
  }

  pruneOlderThan(days: number, options: { dryRun?: boolean } = {}): number {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString()
    if (options.dryRun) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS count FROM rebase_fanouts WHERE fanned_out_at < ?')
        .get(cutoff) as { count: number }
      return row.count
    }

    const result = this.db
      .prepare('DELETE FROM rebase_fanouts WHERE fanned_out_at < ?')
      .run(cutoff)
    return result.changes
  }
}
