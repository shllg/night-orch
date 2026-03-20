import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getOrPinSlug, buildWorktreePath } from '../../src/git/slug.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

describe('getOrPinSlug', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-slug-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('derives slug from title on first call', () => {
    const slug = getOrPinSlug(db, 'org/repo', 1, 'Fix Login Timeout')
    expect(slug).toBe('fix-login-timeout')
  })

  it('returns pinned slug on subsequent calls (ignoring new title)', () => {
    const slug1 = getOrPinSlug(db, 'org/repo', 1, 'Fix Login Timeout')
    const slug2 = getOrPinSlug(db, 'org/repo', 1, 'Completely Different Title')
    expect(slug2).toBe(slug1)
  })

  it('different issues get different slugs', () => {
    const slug1 = getOrPinSlug(db, 'org/repo', 1, 'Fix Login')
    const slug2 = getOrPinSlug(db, 'org/repo', 2, 'Fix Logout')
    expect(slug1).not.toBe(slug2)
  })

  it('empty title gets "untitled"', () => {
    const slug = getOrPinSlug(db, 'org/repo', 1, '')
    expect(slug).toBe('untitled')
  })
})

describe('buildWorktreePath', () => {
  it('creates deterministic path', () => {
    const path = buildWorktreePath('/home/user/worktrees', 'myorg/myrepo', 123)
    expect(path).toBe('/home/user/worktrees/myorg__myrepo/123')
  })

  it('handles org names with special chars', () => {
    const path = buildWorktreePath('/wt', 'my-org/my-repo', 42)
    expect(path).toBe('/wt/my-org__my-repo/42')
  })
})
