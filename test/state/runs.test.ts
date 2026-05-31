import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RunManager, hydrateState, serializeState } from '../../src/state/runs.js'
import { initDatabase } from '../../src/state/db.js'
import { blocked, type RunState } from '../../src/loop/state.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { makeRunInput } from '../helpers/factories.js'
import type { CreateRunParams } from '../../src/state/runs.js'

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

  function makeRun(overrides: Partial<CreateRunParams> = {}) {
    return runManager.create(makeRunInput(overrides))
  }

  it('creates a run with valid ID', () => {
    const run = makeRun({
      issueNumber: 42,
      issueTitle: 'Fix race condition',
      issueNodeId: 'MDU6SXNzdWU0Mg==',
      coder: 'codex',
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
    const run = makeRun()

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
    const run = makeRun()

    runManager.update(run.id, {
      phaseData: { plan: { summary: 'Do the thing' }, codeHash: 'abc123' },
    })

    const updated = runManager.getById(run.id)
    expect(updated?.phaseData).toEqual({ plan: { summary: 'Do the thing' }, codeHash: 'abc123' })
  })

  it('getByRepoAndIssue finds correct record', () => {
    makeRun({
      issueNumber: 42,
      issueNodeId: 'node42',
    })

    const found = runManager.getByRepoAndIssue('org/repo', 42)
    expect(found).not.toBeNull()
    expect(found?.issueNumber).toBe(42)
  })

  it('rejects creating a new run while another active run exists', () => {
    const activeStatuses = ['queued', 'running', 'blocked', 'review_ready', 'error'] as const

    activeStatuses.forEach((status, index) => {
      const issueNumber = 700 + index
      const run = makeRun({
        issueNumber,
        issueNodeId: `node-${issueNumber}`,
      })
      if (status !== 'queued') {
        runManager.update(run.id, { status })
      }

      expect(() => makeRun({
        issueNumber,
        issueNodeId: `node-${issueNumber}`,
      })).toThrow(/active run/)
    })
  })

  it('getByRepoAndIssue prefers latest run when issues aggregate pointer is stale', () => {
    const first = makeRun({
      issueNumber: 77,
      issueNodeId: 'node77',
    })
    runManager.update(first.id, { status: 'completed' })

    const latest = makeRun({
      issueNumber: 77,
      issueNodeId: 'node77',
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
    const r1 = makeRun({
      issueNumber: 1,
      issueNodeId: 'n1',
    })
    const r2 = makeRun({
      issueNumber: 2,
      issueNodeId: 'n2',
    })
    const r3 = makeRun({
      issueNumber: 3,
      issueNodeId: 'n3',
    })
    runManager.update(r1.id, { status: 'running' })
    runManager.update(r2.id, { status: 'blocked' })
    runManager.update(r3.id, { status: 'completed' })

    const active = runManager.getActive()
    expect(active).toHaveLength(2)
    expect(active.map((run) => run.issueNumber).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('getActive falls back to latest runs when issues aggregate state is stale', () => {
    const run = makeRun({
      issueNumber: 88,
      issueNodeId: 'n88',
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
    const oldRun = makeRun({
      issueNumber: 91,
      issueNodeId: 'n91',
    })
    runManager.update(oldRun.id, { status: 'completed' })

    const newRun = makeRun({
      issueNumber: 91,
      issueNodeId: 'n91',
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
    const oldRun = makeRun({
      issueNumber: 92,
      issueNodeId: 'n92',
    })
    runManager.update(oldRun.id, { status: 'completed' })

    const newRun = makeRun({
      issueNumber: 92,
      issueNodeId: 'n92',
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
      const parent = makeRun({ issueNumber: 400, issueNodeId: 'n400' })
      expect(parent.parentRunId).toBeNull()

      // Both sub-runs share the parent's repo/issue but carry parent_run_id.
      // The pre-fix uniqueness query would reject these.
      const sub1 = makeRun({
        issueNumber: 400,
        issueNodeId: 'n400',
        parentRunId: parent.id,
      })
      const sub2 = makeRun({
        issueNumber: 400,
        issueNodeId: 'n400',
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
      makeRun({ issueNumber: 401, issueNodeId: 'n401' })
      expect(() =>
        makeRun({ issueNumber: 401, issueNodeId: 'n401' }),
      ).toThrow(/active run/)
    })
  })

  describe('retry count tracking', () => {
    it('exposes retryCount on new runs as 0', () => {
      const run = makeRun({ issueNumber: 300, issueNodeId: 'n300' })
      expect(run.retryCount).toBe(0)
    })

    it('incrementRetryCount returns new value and persists it across reads', () => {
      const run = makeRun({ issueNumber: 301, issueNodeId: 'n301' })
      expect(runManager.incrementRetryCount(run.id)).toBe(1)
      expect(runManager.incrementRetryCount(run.id)).toBe(2)
      expect(runManager.getById(run.id)?.retryCount).toBe(2)
    })

    it('countRecentErrors uses the active run retry_count even when the single row is reused across replay retries', () => {
      // Simulate the auto-retry flow on a single reused run row:
      // the row cycles queued → running → error → queued without a new row.
      const run = makeRun({ issueNumber: 302, issueNodeId: 'n302' })
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

describe('serializeState / hydrateState', () => {
  describe('serializeState', () => {
    it('projects running to status=running', () => {
      expect(serializeState({ kind: 'running', phase: 'plan' })).toEqual({
        status: 'running',
        blockReason: null,
      })
    })

    it('projects publishing to status=running (no separate column today)', () => {
      expect(serializeState({ kind: 'publishing', prUrl: 'https://x' })).toEqual({
        status: 'running',
        blockReason: null,
      })
    })

    it('projects published to status=completed', () => {
      expect(
        serializeState({ kind: 'published', prUrl: 'https://x', mergedAt: '2026-04-10T00:00:00Z' }),
      ).toEqual({ status: 'completed', blockReason: null })
    })

    it('projects error to status=error', () => {
      expect(serializeState({ kind: 'error', message: 'boom', cause: 'fatal' })).toEqual({
        status: 'error',
        blockReason: null,
      })
    })

    it('projects blocked to status=blocked with the legacy block_reason string', () => {
      expect(
        serializeState(
          blocked({ type: 'costLimit', limit: 'per-run', actualUsd: 12, limitUsd: 10 }),
        ),
      ).toEqual({ status: 'blocked', blockReason: 'cost_limit' })

      expect(serializeState(blocked({ type: 'reviewerBlocked', summary: 'no' }))).toEqual({
        status: 'blocked',
        blockReason: 'reviewer_blocked',
      })

      expect(
        serializeState(
          blocked({ type: 'workerTimeout', adapter: 'claude', step: 'coder', timeoutMs: 30000 }),
        ),
      ).toEqual({ status: 'blocked', blockReason: 'auth_failure' })
    })
  })

  describe('hydrateState', () => {
    it('lifts queued/running/review_ready/completed/error rows', () => {
      expect(hydrateState({ status: 'queued', blockReason: null })).toEqual({
        kind: 'running',
        phase: 'running',
      })
      expect(hydrateState({ status: 'running', blockReason: null })).toEqual({
        kind: 'running',
        phase: 'running',
      })
      expect(hydrateState({ status: 'review_ready', blockReason: null })).toEqual({
        kind: 'publishing',
      })
      expect(hydrateState({ status: 'completed', blockReason: null })).toEqual({
        kind: 'published',
        prUrl: '',
      })
      expect(hydrateState({ status: 'error', blockReason: null })).toEqual({
        kind: 'error',
        message: '',
        cause: 'fatal',
      })
    })

    it('lifts each legacy block_reason into a typed BlockedReason', () => {
      const cases: Array<[string, string]> = [
        ['cost_limit', 'costLimit'],
        ['iteration_limit', 'iterationLimit'],
        ['agent_pass_limit', 'agentPassLimit'],
        ['reviewer_blocked', 'reviewerBlocked'],
        ['ambiguous_review', 'ambiguousReview'],
        ['verify_config', 'verifyConfig'],
        ['merge_conflict', 'mergeConflict'],
        ['auth_failure', 'authFailure'],
        ['empty_diff', 'emptyDiff'],
      ]
      for (const [legacy, typed] of cases) {
        const state = hydrateState({ status: 'blocked', blockReason: legacy })
        expect(state?.kind).toBe('blocked')
        if (state?.kind === 'blocked') {
          expect(state.reason.type).toBe(typed)
        }
      }
    })

    it('returns an ambiguousReview placeholder for unknown block reasons', () => {
      const state = hydrateState({ status: 'blocked', blockReason: 'something_new' })
      expect(state?.kind).toBe('blocked')
      if (state?.kind === 'blocked') {
        expect(state.reason.type).toBe('ambiguousReview')
      }
    })

    it('returns null for unknown statuses', () => {
      expect(hydrateState({ status: 'unknown', blockReason: null })).toBeNull()
    })
  })

  describe('round-trip', () => {
    // serializeState followed by hydrateState should preserve the kind
    // and (for blocked) the reason type. Field-level info loss inside
    // each reason is documented and expected — only the type is pinned.
    it('preserves kind/reason.type for every legacy-mappable state', () => {
      const samples: RunState[] = [
        { kind: 'running', phase: 'code' },
        { kind: 'error', message: '', cause: 'fatal' },
        blocked({ type: 'costLimit', limit: 'per-run', actualUsd: 1, limitUsd: 0.5 }),
        blocked({ type: 'iterationLimit', iterations: 4, max: 4 }),
        blocked({ type: 'agentPassLimit', passes: 10, max: 10 }),
        blocked({ type: 'reviewerBlocked', summary: 'no' }),
        blocked({ type: 'ambiguousReview', excerpt: 'mangled' }),
        blocked({ type: 'verifyConfig', detail: 'no commands' }),
        blocked({ type: 'mergeConflict', files: ['a.ts'], summary: 'conflict' }),
        blocked({ type: 'authFailure', adapter: 'claude' }),
        blocked({ type: 'emptyDiff', retries: 2 }),
      ]
      for (const original of samples) {
        const round = hydrateState(serializeState(original))
        expect(round?.kind).toBe(original.kind)
        if (original.kind === 'blocked' && round?.kind === 'blocked') {
          expect(round.reason.type).toBe(original.reason.type)
        }
      }
    })
  })
})
