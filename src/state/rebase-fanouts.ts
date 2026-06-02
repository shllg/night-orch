import type Database from 'better-sqlite3'

export class RebaseFanoutManager {
  constructor(private db: Database.Database) {}

  has(repo: string, sourcePrNumber: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM rebase_fanouts WHERE repo = ? AND source_pr_number = ?')
      .get(repo, sourcePrNumber)
    return row !== undefined
  }

  mark(repo: string, sourcePrNumber: number, siblingsQueued: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued)
         VALUES (?, ?, ?, ?)`,
      )
      .run(repo, sourcePrNumber, new Date().toISOString(), siblingsQueued)
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
