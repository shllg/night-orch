import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { loadRecentCompletedRuns } from '../../src/state/run-queries.js'

describe('run queries', () => {
  let db: Database.Database

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  describe('loadRecentCompletedRuns', () => {
    it('returns only the recent-completed projection', () => {
      db.prepare(
        `INSERT INTO runs (
           id,
           repo,
           issue_number,
           status,
           issue_title,
           current_phase,
           ended_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'run-1',
        'org/repo',
        12,
        'completed',
        'Hidden title',
        'done',
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      )

      expect(loadRecentCompletedRuns(db)).toEqual([
        {
          id: 'run-1',
          repo: 'org/repo',
          issue_number: 12,
          status: 'completed',
          ended_at: '2026-01-02T00:00:00.000Z',
        },
      ])
    })
  })
})
