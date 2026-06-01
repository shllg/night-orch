import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { loadInboxIssueRows } from '../../src/state/inbox-queries.js'
import { loadRecentCompletedRuns, queryRunHistoryPage } from '../../src/state/run-queries.js'

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

  describe('queryRunHistoryPage', () => {
    it('paginates history rows and reports hasMore from an extra row', () => {
      const insertRun = db.prepare(
        `INSERT INTO runs (
           id,
           repo,
           issue_number,
           status,
           issue_title,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      insertRun.run('run-1', 'org/repo', 1, 'completed', 'First', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
      insertRun.run('run-2', 'org/repo', 2, 'blocked', 'Second', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      insertRun.run('run-3', 'org/other', 3, 'completed', 'Third', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

      const firstPage = queryRunHistoryPage(db, { limit: 2, offset: 0 })
      expect(firstPage.hasMore).toBe(true)
      expect(firstPage.rows.map((row) => row.id)).toEqual(['run-1', 'run-2'])

      const repoPage = queryRunHistoryPage(db, { repo: 'org/repo', statuses: ['completed'], limit: 10, offset: 0 })
      expect(repoPage.hasMore).toBe(false)
      expect(repoPage.rows.map((row) => row.id)).toEqual(['run-1'])
    })
  })

  describe('loadInboxIssueRows', () => {
    it('loads inbox issues with nullable current run details', () => {
      db.prepare(
        `INSERT INTO runs (
           id,
           repo,
           issue_number,
           status,
           issue_title,
           manual_state,
           operation_intent,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'run-current',
        'org/repo',
        7,
        'blocked',
        'Blocked issue',
        'awaiting_rebase_resolution',
        'refresh',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      )
      db.prepare(
        `INSERT INTO issues (
           repo,
           issue_number,
           issue_title,
           status,
           current_run_id,
           last_run_id,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('org/repo', 7, 'Blocked issue', 'blocked', 'run-current', 'run-current', '2026-01-01T00:05:00.000Z')
      db.prepare(
        `INSERT INTO issues (
           repo,
           issue_number,
           issue_title,
           status,
           current_run_id,
           last_run_id,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('org/repo', 8, 'Manual issue', 'error', null, null, '2026-01-01T00:06:00.000Z')

      const rows = loadInboxIssueRows(db, 'org/repo')

      expect(rows.map((row) => row.issue_number).sort((a, b) => a - b)).toEqual([7, 8])
      expect(rows.find((row) => row.issue_number === 7)).toMatchObject({
        run_id: 'run-current',
        manual_state: 'awaiting_rebase_resolution',
        operation_intent: 'refresh',
      })
      expect(rows.find((row) => row.issue_number === 8)).toMatchObject({
        run_id: null,
        manual_state: null,
        operation_intent: null,
      })
    })
  })
})
