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
      // Simulate a chain manually via direct INSERTs. Earlier attempts use
      // status='completed' so the existing one-active-top-level-per-issue
      // index (migration 019) tolerates multiple rows per (repo, issue);
      // R0c will teach that index about the attempts model explicitly.
      const insert = db.prepare(
        `INSERT INTO runs
         (id, repo, issue_number, status, planner, coder, reviewer,
          previous_attempt_id, sequence_number, intent, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude', 'claude', 'claude', ?, ?, ?, ?, ?)`,
      )
      insert.run('a1', 'foo/bar', 7, 'completed', null, 1, 'initial', '2026-04-10T10:00:00.000Z', '2026-04-10T10:00:00.000Z')
      insert.run('a2', 'foo/bar', 7, 'completed', 'a1', 2, 'retry', '2026-04-10T10:10:00.000Z', '2026-04-10T10:10:00.000Z')
      insert.run('a3', 'foo/bar', 7, 'queued', 'a2', 3, 'continue', '2026-04-10T10:20:00.000Z', '2026-04-10T10:20:00.000Z')

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

  describe('getHeadAttempt', () => {
    it('returns null when no attempts exist', () => {
      expect(getHeadAttempt(db, 'foo/bar', 100)).toBeNull()
    })

    it('returns the attempt with the highest sequence_number', () => {
      const insert = db.prepare(
        `INSERT INTO runs
         (id, repo, issue_number, status, planner, coder, reviewer,
          previous_attempt_id, sequence_number, intent, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude', 'claude', 'claude', ?, ?, ?, ?, ?)`,
      )
      insert.run('h1', 'foo/bar', 9, 'completed', null, 1, 'initial', '2026-04-10T10:00:00.000Z', '2026-04-10T10:00:00.000Z')
      insert.run('h2', 'foo/bar', 9, 'queued', 'h1', 2, 'retry', '2026-04-10T10:10:00.000Z', '2026-04-10T10:10:00.000Z')

      const head = getHeadAttempt(db, 'foo/bar', 9)
      expect(head?.id).toBe('h2')
      expect(head?.sequenceNumber).toBe(2)
    })
  })
})
