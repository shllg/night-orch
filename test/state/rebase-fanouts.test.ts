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

  it('records per-sibling outcomes idempotently by source and sibling PR', () => {
    mgr.recordSibling('owner/repo', 42, 100, { status: 'queued' })
    mgr.recordSibling('owner/repo', 42, 100, { status: 'queued' })

    expect(mgr.listSiblings('owner/repo', 42)).toEqual([
      expect.objectContaining({
        repo: 'owner/repo',
        source_pr_number: 42,
        sibling_pr_number: 100,
        status: 'queued',
      }),
    ])
  })

  it('records fan-out failure count and source merge SHA in the source marker', () => {
    mgr.mark('owner/repo', 42, 3, { failuresCount: 1, sourceMergeSha: 'sha-abc' })

    expect(mgr.get('owner/repo', 42)).toMatchObject({
      siblings_queued: 3,
      failures_count: 1,
      source_merge_sha: 'sha-abc',
    })
  })

  it('deduplicates concurrent work for the same source PR in the current process', async () => {
    let calls = 0
    const work = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return calls
    }

    const [first, second] = await Promise.all([
      mgr.runOnce('owner/repo', 42, work),
      mgr.runOnce('owner/repo', 42, work),
    ])

    expect(first).toBe(second)
    expect(calls).toBe(1)
  })

  it('finds fan-outs with recorded failures for startup visibility', () => {
    mgr.mark('owner/repo', 1, 2)
    mgr.mark('owner/repo', 2, 3, { failuresCount: 1, sourceMergeSha: 'sha-2' })
    mgr.mark('other/repo', 3, 4, { failuresCount: 2, sourceMergeSha: 'sha-3' })

    expect(mgr.findIncomplete()).toEqual([
      expect.objectContaining({
        repo: 'owner/repo',
        source_pr_number: 2,
        failures_count: 1,
        source_merge_sha: 'sha-2',
      }),
      expect.objectContaining({
        repo: 'other/repo',
        source_pr_number: 3,
        failures_count: 2,
        source_merge_sha: 'sha-3',
      }),
    ])
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
