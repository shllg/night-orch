import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RunManager } from '../../src/state/runs.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

describe('RunManager', () => {
  let tmpDir: string
  let db: Database.Database
  let runManager: RunManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-run-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    runManager = new RunManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a run with valid ID', () => {
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 42,
      issueTitle: 'Fix race condition',
      issueNodeId: 'MDU6SXNzdWU0Mg==',
      planner: 'claude',
      coder: 'codex',
      reviewer: 'claude',
    })
    expect(run.id).toMatch(/^run-/)
    expect(run.repo).toBe('org/repo')
    expect(run.issueNumber).toBe(42)
    expect(run.issueTitle).toBe('Fix race condition')
    expect(run.status).toBe('queued')
    expect(run.planner).toBe('claude')
    expect(run.coder).toBe('codex')
  })

  it('updates specific fields', () => {
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: 'node1',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    runManager.update(run.id, {
      status: 'running',
      branchName: 'orch/1-fix-bug',
      branchSlug: 'fix-bug',
      prTitle: 'Fix race condition in startup',
    })

    const updated = runManager.getById(run.id)
    expect(updated?.status).toBe('running')
    expect(updated?.branchName).toBe('orch/1-fix-bug')
    expect(updated?.branchSlug).toBe('fix-bug')
    expect(updated?.prTitle).toBe('Fix race condition in startup')
  })

  it('stores and retrieves phaseData as JSON', () => {
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: 'node1',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    runManager.update(run.id, {
      phaseData: { plan: { summary: 'Do the thing' }, codeHash: 'abc123' },
    })

    const updated = runManager.getById(run.id)
    expect(updated?.phaseData).toEqual({ plan: { summary: 'Do the thing' }, codeHash: 'abc123' })
  })

  it('getByRepoAndIssue finds correct record', () => {
    runManager.create({
      repo: 'org/repo',
      issueNumber: 42,
      issueNodeId: 'node42',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const found = runManager.getByRepoAndIssue('org/repo', 42)
    expect(found).not.toBeNull()
    expect(found?.issueNumber).toBe(42)
  })

  it('rejects creating a new run while another active run exists', () => {
    const activeStatuses = ['queued', 'running', 'blocked', 'review_ready', 'error'] as const

    activeStatuses.forEach((status, index) => {
      const issueNumber = 700 + index
      const run = runManager.create({
        repo: 'org/repo',
        issueNumber,
        issueNodeId: `node-${issueNumber}`,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
      if (status !== 'queued') {
        runManager.update(run.id, { status })
      }

      expect(() => runManager.create({
        repo: 'org/repo',
        issueNumber,
        issueNodeId: `node-${issueNumber}`,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })).toThrow(/active run/)
    })
  })

  it('getByRepoAndIssue prefers latest run when issues aggregate pointer is stale', () => {
    const first = runManager.create({
      repo: 'org/repo',
      issueNumber: 77,
      issueNodeId: 'node77',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(first.id, { status: 'completed' })

    const latest = runManager.create({
      repo: 'org/repo',
      issueNumber: 77,
      issueNodeId: 'node77',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    db.prepare(
      `UPDATE issues
       SET status = 'completed',
           current_run_id = ?,
           last_run_id = ?,
           updated_at = datetime('now')
       WHERE repo = ? AND issue_number = ?`,
    ).run(first.id, first.id, 'org/repo', 77)

    const found = runManager.getByRepoAndIssue('org/repo', 77)
    expect(found?.id).toBe(latest.id)
  })

  it('getByRepoAndIssue returns null for missing', () => {
    const found = runManager.getByRepoAndIssue('org/repo', 999)
    expect(found).toBeNull()
  })

  it('getActive returns non-completed records', () => {
    const r1 = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: 'n1',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    const r2 = runManager.create({
      repo: 'org/repo',
      issueNumber: 2,
      issueNodeId: 'n2',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    const r3 = runManager.create({
      repo: 'org/repo',
      issueNumber: 3,
      issueNodeId: 'n3',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(r1.id, { status: 'running' })
    runManager.update(r2.id, { status: 'blocked' })
    runManager.update(r3.id, { status: 'completed' })

    const active = runManager.getActive()
    expect(active).toHaveLength(2)
    expect(active.map((run) => run.issueNumber).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('getActive falls back to latest runs when issues aggregate state is stale', () => {
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 88,
      issueNodeId: 'n88',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, { status: 'blocked' })

    db.prepare(
      `UPDATE issues
       SET status = 'completed',
           current_run_id = NULL,
           updated_at = datetime('now')
       WHERE repo = ? AND issue_number = ?`,
    ).run('org/repo', 88)

    const active = runManager.getActive()
    expect(active.some((row) => row.id === run.id)).toBe(true)
  })

  it('getByRepoAndIssue chooses newest attempt by created_at when older run has newer updated_at', () => {
    const oldRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 91,
      issueNodeId: 'n91',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(oldRun.id, { status: 'completed' })

    const newRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 91,
      issueNodeId: 'n91',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(newRun.id, { status: 'blocked' })

    db.prepare('UPDATE runs SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', oldRun.id)
    db.prepare('UPDATE runs SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', newRun.id)

    const found = runManager.getByRepoAndIssue('org/repo', 91)
    expect(found?.id).toBe(newRun.id)
  })

  it('getActive keeps issue visible when older run was touched after newest blocked attempt', () => {
    const oldRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 92,
      issueNodeId: 'n92',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(oldRun.id, { status: 'completed' })

    const newRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 92,
      issueNodeId: 'n92',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(newRun.id, { status: 'blocked' })

    db.prepare('UPDATE runs SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', oldRun.id)
    db.prepare('UPDATE runs SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', newRun.id)

    const active = runManager.getActive()
    expect(active.some((row) => row.id === newRun.id)).toBe(true)
  })

  describe('sub-run uniqueness', () => {
    it('allows multiple sub-runs to coexist with a parent on the same repo/issue', () => {
      const parent = runManager.create({
        repo: 'org/repo', issueNumber: 400, issueNodeId: 'n400',
        planner: 'claude', coder: 'claude', reviewer: 'claude',
      })
      expect(parent.parentRunId).toBeNull()

      // Both sub-runs share the parent's repo/issue but carry parent_run_id.
      // The pre-fix uniqueness query would reject these.
      const sub1 = runManager.create({
        repo: 'org/repo', issueNumber: 400, issueNodeId: 'n400',
        planner: 'claude', coder: 'claude', reviewer: 'claude',
        parentRunId: parent.id,
      })
      const sub2 = runManager.create({
        repo: 'org/repo', issueNumber: 400, issueNodeId: 'n400',
        planner: 'claude', coder: 'claude', reviewer: 'claude',
        parentRunId: parent.id,
      })

      expect(sub1.parentRunId).toBe(parent.id)
      expect(sub2.parentRunId).toBe(parent.id)
      expect(sub1.id).not.toBe(sub2.id)
      expect(runManager.getSubRuns(parent.id).map((r) => r.id).sort()).toEqual(
        [sub1.id, sub2.id].sort(),
      )
    })

    it('still rejects a second top-level run for the same repo/issue while one is active', () => {
      runManager.create({
        repo: 'org/repo', issueNumber: 401, issueNodeId: 'n401',
        planner: 'claude', coder: 'claude', reviewer: 'claude',
      })
      expect(() =>
        runManager.create({
          repo: 'org/repo', issueNumber: 401, issueNodeId: 'n401',
          planner: 'claude', coder: 'claude', reviewer: 'claude',
        }),
      ).toThrow(/active run/)
    })
  })

  describe('retry count tracking', () => {
    it('exposes retryCount on new runs as 0', () => {
      const run = runManager.create({
        repo: 'org/repo', issueNumber: 300, issueNodeId: 'n300',
        planner: 'claude', coder: 'claude', reviewer: 'claude',
      })
      expect(run.retryCount).toBe(0)
    })

    it('incrementRetryCount returns new value and persists it across reads', () => {
      const run = runManager.create({
        repo: 'org/repo', issueNumber: 301, issueNodeId: 'n301',
        planner: 'claude', coder: 'claude', reviewer: 'claude',
      })
      expect(runManager.incrementRetryCount(run.id)).toBe(1)
      expect(runManager.incrementRetryCount(run.id)).toBe(2)
      expect(runManager.getById(run.id)?.retryCount).toBe(2)
    })

    it('countRecentErrors uses the active run retry_count even when the single row is reused across replay retries', () => {
      // Simulate the auto-retry flow on a single reused run row:
      // the row cycles queued → running → error → queued without a new row.
      const run = runManager.create({
        repo: 'org/repo', issueNumber: 302, issueNodeId: 'n302',
        planner: 'claude', coder: 'claude', reviewer: 'claude',
      })
      runManager.update(run.id, { status: 'error', endedAt: new Date().toISOString() })
      expect(runManager.countRecentErrors('org/repo', 302)).toBe(0)

      runManager.incrementRetryCount(run.id)
      expect(runManager.countRecentErrors('org/repo', 302)).toBe(1)

      runManager.incrementRetryCount(run.id)
      expect(runManager.countRecentErrors('org/repo', 302)).toBe(2)

      runManager.incrementRetryCount(run.id)
      expect(runManager.countRecentErrors('org/repo', 302)).toBe(3)
    })
  })
})
