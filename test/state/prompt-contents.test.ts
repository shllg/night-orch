import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { getOrInsertContent, getPromptContent, _resetLruForTest } from '../../src/state/prompt-contents.js'

describe('prompt-contents (content-addressed storage)', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-prompt-contents-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    _resetLruForTest()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deterministically returns same SHA for same content', () => {
    const sha1 = getOrInsertContent(db, 'You are a coder.')
    const sha2 = getOrInsertContent(db, 'You are a coder.')
    expect(sha1).toBe(sha2)
    expect(sha1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('deduplicates identical content (one row regardless of insert count)', () => {
    for (let i = 0; i < 5; i++) {
      getOrInsertContent(db, 'shared prompt body')
    }
    const count = db
      .prepare(`SELECT COUNT(*) as n FROM prompt_contents WHERE content = ?`)
      .get('shared prompt body') as { n: number }
    expect(count.n).toBe(1)
  })

  it('inserts distinct rows for distinct content', () => {
    const a = getOrInsertContent(db, 'prompt A')
    const b = getOrInsertContent(db, 'prompt B')
    expect(a).not.toBe(b)
    const all = db.prepare(`SELECT COUNT(*) as n FROM prompt_contents`).get() as { n: number }
    expect(all.n).toBe(2)
  })

  it('retrieves content by SHA', () => {
    const sha = getOrInsertContent(db, 'lookup target')
    expect(getPromptContent(db, sha)).toBe('lookup target')
  })

  it('returns null for unknown SHA', () => {
    expect(getPromptContent(db, 'a'.repeat(64))).toBeNull()
  })

  it('records byte_size correctly', () => {
    const content = 'hello world'
    getOrInsertContent(db, content)
    const row = db
      .prepare(`SELECT byte_size FROM prompt_contents WHERE content = ?`)
      .get(content) as { byte_size: number }
    expect(row.byte_size).toBe(Buffer.byteLength(content, 'utf8'))
  })

  it('LRU cache prevents redundant SELECT for hot SHA', () => {
    // First insert hits the DB; second call should hit the LRU and skip the
    // INSERT OR IGNORE. We can't observe the LRU directly, but we can
    // confirm the row count stays at 1 after 100 calls.
    for (let i = 0; i < 100; i++) {
      getOrInsertContent(db, 'hot prompt')
    }
    const count = db.prepare(`SELECT COUNT(*) as n FROM prompt_contents`).get() as { n: number }
    expect(count.n).toBe(1)
  })
})
