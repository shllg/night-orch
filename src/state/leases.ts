import type Database from 'better-sqlite3'
import { nowUtcIso } from '../utils/time.js'

export class LeaseManager {
  constructor(private db: Database.Database) {}

  /**
   * Try to acquire a lease. Returns true if acquired, false if already held.
   * Uses INSERT OR IGNORE + check for atomicity.
   */
  acquire(repo: string, issueNumber: number, owner: string, durationSeconds: number): boolean {
    const now = nowUtcIso()
    const acquireTx = this.db.transaction(
      (txRepo: string, txIssueNumber: number, txOwner: string, txNow: string, txDurationSeconds: number): boolean => {
        this.db
          .prepare('DELETE FROM leases WHERE repo = ? AND issue_number = ? AND leased_until < datetime(?)')
          .run(txRepo, txIssueNumber, txNow)

        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO leases (repo, issue_number, lease_owner, leased_until)
             VALUES (?, ?, ?, datetime(?, '+' || ? || ' seconds'))`,
          )
          .run(txRepo, txIssueNumber, txOwner, txNow, txDurationSeconds)

        return result.changes > 0
      },
    )
    return acquireTx(repo, issueNumber, owner, now, durationSeconds)
  }

  /** Release a lease. Idempotent. */
  release(repo: string, issueNumber: number): void {
    this.db
      .prepare('DELETE FROM leases WHERE repo = ? AND issue_number = ?')
      .run(repo, issueNumber)
  }

  /**
   * Extend the lease expiry for a held lease. Used by the loop engine to
   * bump the deadline on every phase checkpoint so a long-running issue
   * does not fall off under the stale-lease cleanup. Returns true if the
   * lease existed and belonged to the owner (and was updated), false
   * otherwise — the caller can decide whether to re-acquire or bail.
   */
  heartbeat(
    repo: string,
    issueNumber: number,
    owner: string,
    durationSeconds: number,
  ): boolean {
    const now = nowUtcIso()
    const result = this.db
      .prepare(
        `UPDATE leases
         SET leased_until = datetime(?, '+' || ? || ' seconds')
         WHERE repo = ? AND issue_number = ? AND lease_owner = ?`,
      )
      .run(now, durationSeconds, repo, issueNumber, owner)
    return result.changes > 0
  }

  /** Check if a lease is active (not expired). */
  isLeased(repo: string, issueNumber: number): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM leases WHERE repo = ? AND issue_number = ? AND leased_until >= datetime(?)',
      )
      .get(repo, issueNumber, nowUtcIso())
    return row !== undefined
  }

  /** Clean up all expired leases. Returns count removed. */
  cleanExpired(): number {
    const result = this.db
      .prepare('DELETE FROM leases WHERE leased_until < datetime(?)')
      .run(nowUtcIso())
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
