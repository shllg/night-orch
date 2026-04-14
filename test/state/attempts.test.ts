import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import {
  AttemptNotFoundError,
  AttemptTerminatedError,
  assertMutable,
  createFollowupAttempt,
  finalizeAttempt,
  getAttemptChain,
  getHeadAttempt,
} from '../../src/state/attempts.js'

describe('attempts immutability invariant', () => {
  let tmpDir: string
  let db: Database.Database
  let runs: RunManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-attempts-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    runs = new RunManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('assertMutable', () => {
    it('throws AttemptNotFoundError for unknown attempts', () => {
      expect(() => assertMutable(db, 'nonexistent')).toThrow(AttemptNotFoundError)
    })

    it('passes for a fresh (non-terminated) attempt', () => {
      const row = runs.create({
        repo: 'foo/bar',
        issueNumber: 1,
        issueNodeId: null,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
      expect(() => assertMutable(db, row.id)).not.toThrow()
    })

    it('throws AttemptTerminatedError once finalizeAttempt has run', () => {
      const row = runs.create({
        repo: 'foo/bar',
        issueNumber: 2,
        issueNodeId: null,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
      finalizeAttempt(db, { attemptId: row.id })
      expect(() => assertMutable(db, row.id)).toThrow(AttemptTerminatedError)
    })
  })

  describe('finalizeAttempt', () => {
    it('sets terminated_at with the provided timestamp', () => {
      const row = runs.create({
        repo: 'foo/bar',
        issueNumber: 3,
        issueNodeId: null,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
      finalizeAttempt(db, { attemptId: row.id, at: '2026-04-10T12:00:00.000Z' })
      const stored = db
        .prepare('SELECT terminated_at FROM runs WHERE id = ?')
        .get(row.id) as { terminated_at: string | null }
      expect(stored.terminated_at).toBe('2026-04-10T12:00:00.000Z')
    })

    it('defaults terminated_at to the current time when `at` is omitted', () => {
      const row = runs.create({
        repo: 'foo/bar',
        issueNumber: 4,
        issueNodeId: null,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
      const before = new Date().toISOString()
      finalizeAttempt(db, { attemptId: row.id })
      const stored = db
        .prepare('SELECT terminated_at FROM runs WHERE id = ?')
        .get(row.id) as { terminated_at: string | null }
      expect(stored.terminated_at).not.toBeNull()
      expect(stored.terminated_at! >= before).toBe(true)
    })

    it('throws AttemptTerminatedError on a second finalize of the same attempt', () => {
      const row = runs.create({
        repo: 'foo/bar',
        issueNumber: 5,
        issueNodeId: null,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
      finalizeAttempt(db, { attemptId: row.id })
      expect(() => finalizeAttempt(db, { attemptId: row.id })).toThrow(AttemptTerminatedError)
    })

    it('throws AttemptNotFoundError for unknown ids', () => {
      expect(() => finalizeAttempt(db, { attemptId: 'missing' })).toThrow(AttemptNotFoundError)
    })
  })

  describe('getAttemptChain', () => {
    it('returns an empty array when no attempts exist', () => {
      expect(getAttemptChain(db, 'foo/bar', 99)).toEqual([])
    })

    it('returns attempts ordered by sequence_number ascending', () => {
      // Historical attempts must be terminated (terminated_at set) so the
      // one-live-head unique index (migration 024) permits their coexistence
      // with the current live head.
      const insert = db.prepare(
        `INSERT INTO runs
         (id, repo, issue_number, status, planner, coder, reviewer,
          previous_attempt_id, sequence_number, intent, terminated_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude', 'claude', 'claude', ?, ?, ?, ?, ?, ?)`,
      )
      insert.run('a1', 'foo/bar', 7, 'blocked', null, 1, 'initial', '2026-04-10T10:05:00.000Z', '2026-04-10T10:00:00.000Z', '2026-04-10T10:05:00.000Z')
      insert.run('a2', 'foo/bar', 7, 'blocked', 'a1', 2, 'retry', '2026-04-10T10:15:00.000Z', '2026-04-10T10:10:00.000Z', '2026-04-10T10:15:00.000Z')
      insert.run('a3', 'foo/bar', 7, 'queued', 'a2', 3, 'continue', null, '2026-04-10T10:20:00.000Z', '2026-04-10T10:20:00.000Z')

      const chain = getAttemptChain(db, 'foo/bar', 7)
      expect(chain.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
      expect(chain.map((a) => a.sequenceNumber)).toEqual([1, 2, 3])
      expect(chain.map((a) => a.intent)).toEqual(['initial', 'retry', 'continue'])
      expect(chain[0]!.previousAttemptId).toBeNull()
      expect(chain[1]!.previousAttemptId).toBe('a1')
      expect(chain[2]!.previousAttemptId).toBe('a2')
    })

    it('excludes sub-runs (rows with a non-null parent_run_id)', () => {
      const insertTop = db.prepare(
        `INSERT INTO runs (id, repo, issue_number, status, planner, coder, reviewer)
         VALUES (?, ?, ?, 'queued', 'claude', 'claude', 'claude')`,
      )
      insertTop.run('top', 'foo/bar', 8)

      const insertSub = db.prepare(
        `INSERT INTO runs (id, repo, issue_number, status, planner, coder, reviewer, parent_run_id)
         VALUES (?, ?, ?, 'queued', 'claude', 'claude', 'claude', ?)`,
      )
      insertSub.run('sub-1', 'foo/bar', 8, 'top')
      insertSub.run('sub-2', 'foo/bar', 8, 'top')

      const chain = getAttemptChain(db, 'foo/bar', 8)
      expect(chain.map((a) => a.id)).toEqual(['top'])
    })
  })

  describe('createFollowupAttempt', () => {
    function seedAttempt(issue: number, opts: Partial<{ branch: string; pr: number; cost: number }> = {}) {
      const row = runs.create({
        repo: 'foo/bar',
        issueNumber: issue,
        issueNodeId: `node-${issue}`,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
      runs.update(row.id, {
        status: 'blocked',
        branchName: opts.branch ?? 'feat/x',
        branchSlug: opts.branch ?? 'feat-x',
        worktreePath: `/tmp/wt/${row.id}`,
        prNumber: opts.pr ?? 42,
        prTitle: '#X PR title',
        estimatedCostUsd: opts.cost ?? 1.5,
        promptTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 0,
        iterationCount: 3,
        blockReason: 'cost_limit',
      })
      return row
    }

    it('finalizes the previous attempt and inserts a successor with sequence+1', () => {
      const first = seedAttempt(101)
      const result = createFollowupAttempt(db, {
        previousAttemptId: first.id,
        intent: 'retry',
        phaseData: { issueRepo: 'foo/bar', reactionType: 'retry' },
        controlPayload: { source: 'test' },
      })

      expect(result.sequenceNumber).toBe(2)

      const prev = runs.getById(first.id)!
      expect(prev.status).toBe('blocked') // status preserved as historical
      // terminated_at is not exposed on RunRecord directly; check column:
      const prevTerminated = db
        .prepare('SELECT terminated_at FROM runs WHERE id = ?')
        .get(first.id) as { terminated_at: string | null }
      expect(prevTerminated.terminated_at).not.toBeNull()

      const newRow = runs.getById(result.attemptId)!
      expect(newRow.status).toBe('queued')
      expect(newRow.repo).toBe('foo/bar')
      expect(newRow.issueNumber).toBe(101)
      expect(newRow.planner).toBe('claude')
      expect(newRow.iterationCount).toBe(0)
      expect(newRow.estimatedCostUsd).toBe(0)
      expect(newRow.promptTokens).toBe(0)
      expect(newRow.completionTokens).toBe(0)
      expect(newRow.cacheReadTokens).toBe(0)
      expect(newRow.blockReason).toBeNull()
      expect(newRow.operationIntent).toBe('retry')
      expect(newRow.manualState).toBe('none')
      expect(newRow.lastError).toBeNull()
      expect(newRow.currentPhase).toBeNull()
      expect(newRow.retryCount).toBe(0)

      const chain = getAttemptChain(db, 'foo/bar', 101)
      expect(chain.map((a) => a.id)).toEqual([first.id, result.attemptId])
      expect(chain[1]!.previousAttemptId).toBe(first.id)
      expect(chain[1]!.intent).toBe('retry')
      expect(chain[1]!.sequenceNumber).toBe(2)
    })

    it('retry clears branch/worktree/PR fields', () => {
      const first = seedAttempt(102, { branch: 'feat/y', pr: 99 })
      const result = createFollowupAttempt(db, {
        previousAttemptId: first.id,
        intent: 'retry',
        phaseData: null,
        controlPayload: null,
      })
      const newRow = runs.getById(result.attemptId)!
      expect(newRow.branchName).toBeNull()
      expect(newRow.branchSlug).toBeNull()
      expect(newRow.worktreePath).toBeNull()
      expect(newRow.prNumber).toBeNull()
      expect(newRow.prTitle).toBeNull()
    })

    it('continue preserves branch/worktree/PR fields', () => {
      const first = seedAttempt(103, { branch: 'feat/z', pr: 77 })
      const result = createFollowupAttempt(db, {
        previousAttemptId: first.id,
        intent: 'continue',
        phaseData: null,
        controlPayload: null,
      })
      const newRow = runs.getById(result.attemptId)!
      expect(newRow.branchName).toBe('feat/z')
      expect(newRow.branchSlug).toBe('feat/z')
      expect(newRow.worktreePath).toBe(`/tmp/wt/${first.id}`)
      expect(newRow.prNumber).toBe(77)
      expect(newRow.operationIntent).toBe('continue')
    })

    it('rebase preserves branch and uses rebase intent', () => {
      const first = seedAttempt(104)
      const result = createFollowupAttempt(db, {
        previousAttemptId: first.id,
        intent: 'rebase',
        phaseData: null,
        controlPayload: null,
      })
      const newRow = runs.getById(result.attemptId)!
      expect(newRow.branchName).toBe('feat/x')
      expect(newRow.operationIntent).toBe('rebase')
    })

    it('refresh preserves branch and uses refresh intent', () => {
      const first = seedAttempt(108)
      const result = createFollowupAttempt(db, {
        previousAttemptId: first.id,
        intent: 'refresh',
        phaseData: null,
        controlPayload: null,
      })
      const newRow = runs.getById(result.attemptId)!
      expect(newRow.branchName).toBe('feat/x')
      expect(newRow.operationIntent).toBe('refresh')
    })

    it('stores phaseData and controlPayload as JSON on the new row', () => {
      const first = seedAttempt(105)
      const result = createFollowupAttempt(db, {
        previousAttemptId: first.id,
        intent: 'retry',
        phaseData: { issueRepo: 'foo/bar', marker: 'p' },
        controlPayload: { source: 'comment', marker: 'c' },
      })
      const newRow = runs.getById(result.attemptId)!
      expect(newRow.phaseData).toEqual({ issueRepo: 'foo/bar', marker: 'p' })
      expect(newRow.controlPayload).toEqual({ source: 'comment', marker: 'c' })
    })

    it('throws AttemptNotFoundError when previous attempt is unknown', () => {
      expect(() =>
        createFollowupAttempt(db, {
          previousAttemptId: 'ghost',
          intent: 'retry',
          phaseData: null,
          controlPayload: null,
        }),
      ).toThrow(AttemptNotFoundError)
    })

    it('throws AttemptTerminatedError when previous attempt is already frozen', () => {
      const first = seedAttempt(106)
      finalizeAttempt(db, { attemptId: first.id })
      expect(() =>
        createFollowupAttempt(db, {
          previousAttemptId: first.id,
          intent: 'retry',
          phaseData: null,
          controlPayload: null,
        }),
      ).toThrow(AttemptTerminatedError)
    })

    it('chaining retry -> retry builds a sequence of attempts', () => {
      const first = seedAttempt(107)
      const second = createFollowupAttempt(db, {
        previousAttemptId: first.id,
        intent: 'retry',
        phaseData: null,
        controlPayload: null,
      })
      // Mark the second as blocked so we can retry it again.
      runs.update(second.attemptId, { status: 'blocked' })
      const third = createFollowupAttempt(db, {
        previousAttemptId: second.attemptId,
        intent: 'retry',
        phaseData: null,
        controlPayload: null,
      })
      expect(third.sequenceNumber).toBe(3)
      const chain = getAttemptChain(db, 'foo/bar', 107)
      expect(chain.map((a) => a.sequenceNumber)).toEqual([1, 2, 3])
      expect(chain[2]!.previousAttemptId).toBe(second.attemptId)
      expect(chain[1]!.previousAttemptId).toBe(first.id)
    })
  })

  describe('getHeadAttempt', () => {
    it('returns null when no attempts exist', () => {
      expect(getHeadAttempt(db, 'foo/bar', 100)).toBeNull()
    })

    it('returns the attempt with the highest sequence_number', () => {
      const insert = db.prepare(
        `INSERT INTO runs
         (id, repo, issue_number, status, planner, coder, reviewer,
          previous_attempt_id, sequence_number, intent, terminated_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude', 'claude', 'claude', ?, ?, ?, ?, ?, ?)`,
      )
      insert.run('h1', 'foo/bar', 9, 'blocked', null, 1, 'initial', '2026-04-10T10:05:00.000Z', '2026-04-10T10:00:00.000Z', '2026-04-10T10:05:00.000Z')
      insert.run('h2', 'foo/bar', 9, 'queued', 'h1', 2, 'retry', null, '2026-04-10T10:10:00.000Z', '2026-04-10T10:10:00.000Z')

      const head = getHeadAttempt(db, 'foo/bar', 9)
      expect(head?.id).toBe('h2')
      expect(head?.sequenceNumber).toBe(2)
    })
  })
})
