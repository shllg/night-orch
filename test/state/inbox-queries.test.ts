import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { loadInboxIssueRows } from '../../src/state/inbox-queries.js'

describe('inbox queries', () => {
  let db: Database.Database

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  describe('loadInboxIssueRows', () => {
    it('returns inbox issue rows with current run control state', () => {
      db.prepare(
        `INSERT INTO runs (
           id,
           repo,
           issue_number,
           status,
           manual_state,
           operation_intent
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('run-1', 'org/repo', 12, 'blocked', 'awaiting_rebase_resolution', 'retry')

      db.prepare(
        `INSERT INTO issues (
           repo,
           issue_number,
           issue_title,
           status,
           block_reason,
           current_run_id,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'org/repo',
        12,
        'Fix inbox',
        'blocked',
        'merge_conflict',
        'run-1',
        '2026-01-02T00:00:00.000Z',
      )

      expect(loadInboxIssueRows(db, 'org/repo')).toEqual([
        expect.objectContaining({
          repo: 'org/repo',
          issue_number: 12,
          issue_title: 'Fix inbox',
          status: 'blocked',
          block_reason: 'merge_conflict',
          run_id: 'run-1',
          manual_state: 'awaiting_rebase_resolution',
          operation_intent: 'retry',
        }),
      ])
    })
  })
})
