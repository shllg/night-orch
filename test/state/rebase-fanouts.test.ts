import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from '../../src/state/db.js'
import { RebaseFanoutManager } from '../../src/state/rebase-fanouts.js'

describe('RebaseFanoutManager', () => {
  let db: Database.Database
  let mgr: RebaseFanoutManager

  beforeEach(() => {
    db = initDatabase(':memory:')
    mgr = new RebaseFanoutManager(db)
  })

  it('reports whether a source PR has already fanned out', () => {
    expect(mgr.has('owner/repo', 42)).toBe(false)
    mgr.mark('owner/repo', 42, 3)
    expect(mgr.has('owner/repo', 42)).toBe(true)
  })

  it('mark is idempotent and preserves the first siblings_queued count', () => {
    mgr.mark('owner/repo', 42, 7)
    expect(() => mgr.mark('owner/repo', 42, 5)).not.toThrow()

    const row = db
      .prepare('SELECT siblings_queued FROM rebase_fanouts WHERE repo = ? AND source_pr_number = ?')
      .get('owner/repo', 42) as { siblings_queued: number }
    expect(row.siblings_queued).toBe(7)
  })

  it('prunes rows older than a cutoff and supports dry-run counting', () => {
    const old = new Date(Date.now() - 100 * 86400 * 1000).toISOString()
    const recent = new Date().toISOString()
    db.prepare(
      `INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued)
       VALUES (?, ?, ?, ?)`,
    ).run('owner/repo', 1, old, 0)
    db.prepare(
      `INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued)
       VALUES (?, ?, ?, ?)`,
    ).run('owner/repo', 2, recent, 0)

    expect(mgr.pruneOlderThan(90, { dryRun: true })).toBe(1)
    expect(mgr.has('owner/repo', 1)).toBe(true)

    expect(mgr.pruneOlderThan(90)).toBe(1)
    expect(mgr.has('owner/repo', 1)).toBe(false)
    expect(mgr.has('owner/repo', 2)).toBe(true)
  })
})
