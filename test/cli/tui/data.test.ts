import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../../src/state/db.js'
import { loadRuns } from '../../../src/cli/tui/data.js'

describe('loadRuns', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-tui-data-'))
    db = initDatabase(join(tmpDir, 'tui.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('falls back to latest known issue/pr titles for the same issue and PR', () => {
    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
        pr_number, pr_title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    insertRun.run(
      'run-old',
      'org/repo',
      42,
      'Fix retries in queue handling',
      'completed',
      'publish',
      2,
      1.2,
      501,
      '[night-orch] #42 Fix retries in queue handling',
      '2026-03-30T10:00:00.000Z',
      '2026-03-30T10:00:00.000Z',
    )

    insertRun.run(
      'run-new',
      'org/repo',
      42,
      null,
      'running',
      'code',
      1,
      0.6,
      501,
      null,
      '2026-03-31T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
    )

    insertRun.run(
      'run-other',
      'org/repo',
      77,
      null,
      'queued',
      'plan',
      0,
      0,
      null,
      null,
      '2026-03-31T11:00:00.000Z',
      '2026-03-31T11:00:00.000Z',
    )

    const rows = loadRuns(db, 10)
    const newest = rows.find((row) => row.id === 'run-new')
    const other = rows.find((row) => row.id === 'run-other')

    expect(newest?.issue_title).toBe('Fix retries in queue handling')
    expect(newest?.pr_title).toBe('[night-orch] #42 Fix retries in queue handling')
    expect(other?.issue_title).toBeNull()
    expect(other?.pr_title).toBeNull()
  })
})
