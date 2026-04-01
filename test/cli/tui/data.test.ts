import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../../src/state/db.js'
import { buildIssueList, loadRuns } from '../../../src/cli/tui/data.js'

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
    expect(rows.some((row) => row.id === 'run-old')).toBe(true)
    expect(other?.issue_title).toBeNull()
    expect(other?.pr_title).toBeNull()
  })

  it('loads runs for unresolved issues only, including prior history for those issues', () => {
    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
        pr_number, pr_title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    // Resolved issue (latest run completed): should be excluded entirely.
    insertRun.run(
      'issue-10-old-running',
      'org/repo',
      10,
      'Resolved issue',
      'running',
      'code',
      0,
      0,
      null,
      null,
      '2026-03-30T09:00:00.000Z',
      '2026-03-30T09:00:00.000Z',
    )
    insertRun.run(
      'issue-10-latest-completed',
      'org/repo',
      10,
      'Resolved issue',
      'completed',
      'publish',
      1,
      0,
      null,
      null,
      '2026-03-31T09:00:00.000Z',
      '2026-03-31T09:00:00.000Z',
    )

    // Unresolved issue (latest run blocked): include both latest and older history rows.
    insertRun.run(
      'issue-20-old-completed',
      'org/repo',
      20,
      'Still active issue',
      'completed',
      'publish',
      1,
      0,
      null,
      null,
      '2026-03-30T10:00:00.000Z',
      '2026-03-30T10:00:00.000Z',
    )
    insertRun.run(
      'issue-20-latest-blocked',
      'org/repo',
      20,
      null,
      'blocked',
      'verify',
      2,
      0,
      null,
      null,
      '2026-03-31T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
    )

    const rows = loadRuns(db)
    const rowIds = new Set(rows.map((row) => row.id))

    expect(rowIds.has('issue-10-old-running')).toBe(false)
    expect(rowIds.has('issue-10-latest-completed')).toBe(false)
    expect(rowIds.has('issue-20-old-completed')).toBe(true)
    expect(rowIds.has('issue-20-latest-blocked')).toBe(true)
  })

  it('returns all unresolved issues by default (no implicit 24-row cap)', () => {
    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
        pr_number, pr_title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    for (let issueNumber = 1; issueNumber <= 30; issueNumber++) {
      insertRun.run(
        `run-${issueNumber}`,
        'org/repo',
        issueNumber,
        `Issue ${issueNumber}`,
        'queued',
        'plan',
        0,
        0,
        null,
        null,
        `2026-03-31T12:${String(issueNumber).padStart(2, '0')}:00.000Z`,
        `2026-03-31T12:${String(issueNumber).padStart(2, '0')}:00.000Z`,
      )
    }

    const rows = loadRuns(db)
    expect(rows.length).toBe(30)
  })

  it('includes unresolved issues when issues aggregate row is stale', () => {
    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
        pr_number, pr_title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    insertRun.run(
      'issue-39-blocked',
      'org/repo',
      39,
      'TUI - extended stats',
      'blocked',
      'review',
      1,
      0.3,
      null,
      null,
      '2026-04-01T09:00:00.000Z',
      '2026-04-01T09:00:00.000Z',
    )

    // Simulate a stale aggregate row left behind from older direct runs updates.
    db.prepare(
      `INSERT INTO issues (repo, issue_number, status, current_run_id, last_run_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, datetime('now'), datetime('now'))`,
    ).run('org/repo', 39, 'completed', 'issue-39-blocked')

    const rows = loadRuns(db)
    expect(rows.some((row) => row.id === 'issue-39-blocked')).toBe(true)
  })

  it('treats latest attempt by created_at as canonical even if older run has newer updated_at', () => {
    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
        pr_number, pr_title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    insertRun.run(
      'issue-55-old-completed',
      'org/repo',
      55,
      'Issue 55',
      'completed',
      'publish',
      1,
      0.2,
      null,
      null,
      '2026-04-01T09:00:00.000Z',
      '2026-04-01T12:00:00.000Z',
    )

    insertRun.run(
      'issue-55-new-blocked',
      'org/repo',
      55,
      'Issue 55',
      'blocked',
      'review',
      2,
      0.4,
      null,
      null,
      '2026-04-01T11:00:00.000Z',
      '2026-04-01T11:00:00.000Z',
    )

    const rows = loadRuns(db)
    expect(rows.some((row) => row.id === 'issue-55-new-blocked')).toBe(true)
    expect(rows.some((row) => row.id === 'issue-55-old-completed')).toBe(true)

    const issues = buildIssueList(rows)
    const issue = issues.find((row) => row.repo === 'org/repo' && row.issue_number === 55)
    expect(issue?.status).toBe('blocked')
  })
})
