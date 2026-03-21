import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MentionTracker } from '../../src/mentions/tracker.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

describe('MentionTracker', () => {
  let tmpDir: string
  let db: Database.Database
  let tracker: MentionTracker

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-tracker-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    tracker = new MentionTracker(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('first post for PR+commit+key → not posted', () => {
    expect(tracker.wasPosted('org/repo', 10, 'codex', 'abc123')).toBe(false)
  })

  it('after record → was posted returns true', () => {
    tracker.recordPosted('org/repo', 10, 'codex', 'abc123')
    expect(tracker.wasPosted('org/repo', 10, 'codex', 'abc123')).toBe(true)
  })

  it('different commit sha → not posted (allows re-mention on new push)', () => {
    tracker.recordPosted('org/repo', 10, 'codex', 'abc123')
    expect(tracker.wasPosted('org/repo', 10, 'codex', 'def456')).toBe(false)
  })

  it('different mention key → not posted', () => {
    tracker.recordPosted('org/repo', 10, 'codex', 'abc123')
    expect(tracker.wasPosted('org/repo', 10, 'claude', 'abc123')).toBe(false)
  })

  it('different PR → not posted', () => {
    tracker.recordPosted('org/repo', 10, 'codex', 'abc123')
    expect(tracker.wasPosted('org/repo', 11, 'codex', 'abc123')).toBe(false)
  })

  it('different repo → not posted', () => {
    tracker.recordPosted('org/repo-a', 10, 'codex', 'abc123')
    expect(tracker.wasPosted('org/repo-b', 10, 'codex', 'abc123')).toBe(false)
  })

  it('recordPosted is idempotent', () => {
    tracker.recordPosted('org/repo', 10, 'codex', 'abc123')
    tracker.recordPosted('org/repo', 10, 'codex', 'abc123') // no error
    expect(tracker.wasPosted('org/repo', 10, 'codex', 'abc123')).toBe(true)
  })
})
