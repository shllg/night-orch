import { describe, expect, it } from 'vitest'
import { initDatabase } from '../../src/state/db.js'

describe('migration 030 rebase_fanouts', () => {
  it('creates table with correct columns and composite primary key', () => {
    const db = initDatabase(':memory:')
    const cols = db.prepare("PRAGMA table_info('rebase_fanouts')").all() as Array<{
      name: string
      type: string
      pk: number
    }>
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))

    expect(byName.repo).toMatchObject({ type: 'TEXT', pk: 1 })
    expect(byName.source_pr_number).toMatchObject({ type: 'INTEGER', pk: 2 })
    expect(byName.fanned_out_at).toMatchObject({ type: 'TEXT' })
    expect(byName.siblings_queued).toMatchObject({ type: 'INTEGER' })

    db.close()
  })

  it('enforces uniqueness on repo and source_pr_number', () => {
    const db = initDatabase(':memory:')
    const stmt = db.prepare(
      `INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued)
       VALUES (?, ?, ?, ?)`,
    )

    stmt.run('owner/repo', 42, new Date().toISOString(), 3)
    expect(() => stmt.run('owner/repo', 42, new Date().toISOString(), 1)).toThrow(/UNIQUE|PRIMARY/i)

    db.close()
  })

  it('allows the same source_pr_number across different repos', () => {
    const db = initDatabase(':memory:')
    const stmt = db.prepare(
      `INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued)
       VALUES (?, ?, ?, ?)`,
    )

    stmt.run('owner/a', 42, new Date().toISOString(), 1)
    expect(() => stmt.run('owner/b', 42, new Date().toISOString(), 1)).not.toThrow()

    db.close()
  })
})
