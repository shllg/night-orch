import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../../src/state/db.js'
import { recordHandoff } from '../../../src/state/handoffs.js'
import { buildIssueList, loadHandoffs, loadRuns } from '../../../src/cli/tui/data.js'

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

  it('loads agent handoffs for a run in insertion order', () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES ('run-handoff-1', 'org/repo', 1, 'running')",
    ).run()
    recordHandoff(db, {
      runId: 'run-handoff-1',
      attemptId: 'run-handoff-1',
      stepId: 'plan',
      fromRole: 'planner',
      toRole: 'coder',
      kind: 'plan',
      summary: 'Plan: Fix',
      contentMd: '## Plan',
      contentJson: { objective: 'Fix' },
    })
    recordHandoff(db, {
      runId: 'run-handoff-1',
      attemptId: 'run-handoff-1',
      stepId: 'code',
      fromRole: 'coder',
      toRole: 'system',
      kind: 'code-summary',
      summary: 'Code: Done',
      contentMd: '## Code Summary',
      contentJson: { summary: 'Done' },
    })

    const rows = loadHandoffs(db, 'run-handoff-1')

    expect(rows.map((row) => row.stepId)).toEqual(['plan', 'code'])
    expect(rows[0]?.summary).toBe('Plan: Fix')
    expect(rows[0]?.contentJson).toEqual({ objective: 'Fix' })
  })

  it('falls back to latest known issue/pr titles for the same issue and PR', () => {
    const insertRun = db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
        pr_number, pr_title, terminated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        pr_number, pr_title, terminated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      '2026-03-30T09:30:00.000Z',
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
        pr_number, pr_title, terminated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      '2026-04-01T10:30:00.000Z',
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

  it('includes unresolved issues that have no run rows yet', () => {
    db.prepare(
      `INSERT INTO issues (
        repo, issue_number, issue_node_id, issue_title, status, iteration_count, estimated_cost_usd,
        run_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'org/repo',
      72,
      'node-72',
      'Queued from discovery',
      'queued',
      0,
      0,
      0,
      '2026-04-01T12:00:00.000Z',
      '2026-04-01T12:00:00.000Z',
    )

    const rows = loadRuns(db)
    const issueRow = rows.find((row) => row.repo === 'org/repo' && row.issue_number === 72)
    expect(issueRow).toBeDefined()
    expect(issueRow?.status).toBe('queued')
    expect(issueRow?.id.startsWith('issue:')).toBe(true)

    const issues = buildIssueList(rows)
    const issue = issues.find((row) => row.repo === 'org/repo' && row.issue_number === 72)
    expect(issue?.status).toBe('queued')
  })

  it('includes unresolved issue aggregates even when prior runs are completed', () => {
    db.prepare(
      `INSERT INTO runs (
        id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
        pr_number, pr_title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'issue-88-old-completed',
      'org/repo',
      88,
      'Issue 88',
      'completed',
      'publish',
      1,
      0.2,
      null,
      null,
      '2026-04-01T08:00:00.000Z',
      '2026-04-01T08:00:00.000Z',
    )

    db.prepare(
      `INSERT INTO issues (
        repo, issue_number, issue_node_id, issue_title, status, current_phase, iteration_count,
        estimated_cost_usd, current_run_id, last_run_id, run_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'org/repo',
      88,
      'node-88',
      'Issue 88',
      'queued',
      null,
      0,
      0,
      null,
      'issue-88-old-completed',
      1,
      '2026-04-01T08:00:00.000Z',
      '2026-04-01T12:00:00.000Z',
    )

    const rows = loadRuns(db)
    const issues = buildIssueList(rows)
    const issue = issues.find((row) => row.repo === 'org/repo' && row.issue_number === 88)

    expect(issue).toBeDefined()
    expect(issue?.status).toBe('queued')
    expect(issue?.runs.some((run) => run.id === 'issue-88-old-completed')).toBe(true)
  })

  it('supports SQL-level repo/status filtering with limit', () => {
    const insertIssue = db.prepare(
      `INSERT INTO issues (
        repo, issue_number, issue_node_id, issue_title, status,
        iteration_count, estimated_cost_usd, run_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    for (let i = 1; i <= 40; i++) {
      insertIssue.run(
        'org/repo',
        i,
        `node-${i}`,
        `Issue ${i}`,
        'queued',
        0,
        0,
        0,
        `2026-04-02T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
        `2026-04-02T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
      )
    }

    insertIssue.run(
      'other/repo',
      999,
      'node-999',
      'Other repo issue',
      'queued',
      0,
      0,
      0,
      '2026-04-02T10:59:00.000Z',
      '2026-04-02T10:59:00.000Z',
    )
    insertIssue.run(
      'org/repo',
      777,
      'node-777',
      'Blocked issue',
      'blocked',
      0,
      0,
      0,
      '2026-04-02T10:58:00.000Z',
      '2026-04-02T10:58:00.000Z',
    )

    const rows = loadRuns(db, { repo: 'org/repo', status: 'queued', limit: 7 })

    expect(rows).toHaveLength(7)
    expect(rows.every((row) => row.repo === 'org/repo')).toBe(true)
    expect(rows.every((row) => row.status === 'queued')).toBe(true)
  })

  describe('includeTerminated: false (Active view)', () => {
    const insertRun = (db: Database.Database, row: {
      id: string
      issue_number: number
      status: string
      terminated_at: string | null
      created_at: string
    }) => {
      db.prepare(
        `INSERT INTO runs (
          id, repo, issue_number, issue_title, status, current_phase, iteration_count, estimated_cost_usd,
          pr_number, pr_title, terminated_at, created_at, updated_at
        ) VALUES (?, 'org/repo', ?, 'Issue', ?, NULL, 0, 0, NULL, NULL, ?, ?, ?)`,
      ).run(row.id, row.issue_number, row.status, row.terminated_at, row.created_at, row.created_at)
    }

    it('excludes terminated attempts from the result', () => {
      // Chain on issue #156: two terminated predecessors + one live head.
      // The #156 regression we're guarding against is the web UI showing
      // all three as "duplicate queued tasks" in the Active tab.
      insertRun(db, { id: 'run-orig', issue_number: 156, status: 'error', terminated_at: '2026-04-11T12:00:00Z', created_at: '2026-04-11T11:00:00Z' })
      insertRun(db, { id: 'run-continue-1', issue_number: 156, status: 'queued', terminated_at: '2026-04-11T13:00:00Z', created_at: '2026-04-11T12:30:00Z' })
      insertRun(db, { id: 'run-continue-2', issue_number: 156, status: 'queued', terminated_at: null, created_at: '2026-04-11T13:00:00Z' })

      const rows = loadRuns(db, { includeTerminated: false })
      const ids = new Set(rows.map((r) => r.id))
      expect(ids.has('run-continue-2')).toBe(true)
      expect(ids.has('run-continue-1')).toBe(false)
      expect(ids.has('run-orig')).toBe(false)
      expect(rows.filter((r) => r.issue_number === 156)).toHaveLength(1)
    })

    it('default (includeTerminated: true) still returns the full history', () => {
      insertRun(db, { id: 'run-terminated', issue_number: 200, status: 'blocked', terminated_at: '2026-04-11T12:00:00Z', created_at: '2026-04-11T11:00:00Z' })
      insertRun(db, { id: 'run-live', issue_number: 200, status: 'queued', terminated_at: null, created_at: '2026-04-11T13:00:00Z' })

      const rows = loadRuns(db)
      const ids = new Set(rows.map((r) => r.id))
      expect(ids.has('run-live')).toBe(true)
      expect(ids.has('run-terminated')).toBe(true)
    })

    it('terminated-only issue (no live head) is excluded from the Active view', () => {
      // Edge case: the *only* attempt for an issue is terminated. The
      // Active view should not surface it at all — it belongs in history.
      insertRun(db, { id: 'run-lonely-terminated', issue_number: 300, status: 'error', terminated_at: '2026-04-11T12:00:00Z', created_at: '2026-04-11T11:00:00Z' })

      const rows = loadRuns(db, { includeTerminated: false })
      expect(rows.some((r) => r.issue_number === 300)).toBe(false)
    })

    it('issue with a live head in a non-active status (error) is still included', () => {
      // Regression guard: after the reconciler's markFinalizerOrphan runs,
      // the live head has status='error' with terminated_at=NULL. That row
      // MUST stay in the Active view so the user sees the broken run and
      // can click /orch continue.
      insertRun(db, { id: 'run-orphan-error', issue_number: 400, status: 'error', terminated_at: null, created_at: '2026-04-11T11:00:00Z' })

      const rows = loadRuns(db, { includeTerminated: false })
      expect(rows.some((r) => r.id === 'run-orphan-error')).toBe(true)
    })
  })
})
