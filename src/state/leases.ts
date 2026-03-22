import type Database from 'better-sqlite3'

export class LeaseManager {
  constructor(private db: Database.Database) {}

  /**
   * Try to acquire a lease. Returns true if acquired, false if already held.
   * Uses INSERT OR IGNORE + check for atomicity.
   */
  acquire(repo: string, issueNumber: number, owner: string, durationSeconds: number): boolean {
    // First, clean this specific lease if expired
    this.db
      .prepare('DELETE FROM leases WHERE repo = ? AND issue_number = ? AND leased_until < datetime(?)')
      .run(repo, issueNumber, new Date().toISOString())

    // Try to insert
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO leases (repo, issue_number, lease_owner, leased_until)
         VALUES (?, ?, ?, datetime(?, '+' || ? || ' seconds'))`,
      )
      .run(repo, issueNumber, owner, new Date().toISOString(), durationSeconds)

    return result.changes > 0
  }

  /** Release a lease. Idempotent. */
  release(repo: string, issueNumber: number): void {
    this.db
      .prepare('DELETE FROM leases WHERE repo = ? AND issue_number = ?')
      .run(repo, issueNumber)
  }

  /** Check if a lease is active (not expired). */
  isLeased(repo: string, issueNumber: number): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM leases WHERE repo = ? AND issue_number = ? AND leased_until >= datetime(?)',
      )
      .get(repo, issueNumber, new Date().toISOString())
    return row !== undefined
  }

  /** Clean up all expired leases. Returns count removed. */
  cleanExpired(): number {
    const result = this.db
      .prepare('DELETE FROM leases WHERE leased_until < datetime(?)')
      .run(new Date().toISOString())
    return result.changes
  }

  /** Release all leases (or those owned by a specific owner). Returns count removed. */
  releaseAll(owner?: string): number {
    if (owner) {
      const result = this.db
        .prepare('DELETE FROM leases WHERE lease_owner = ?')
        .run(owner)
      return result.changes
    }
    const result = this.db
      .prepare('DELETE FROM leases')
      .run()
    return result.changes
  }
}
