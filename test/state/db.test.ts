import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

describe('initDatabase', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-test-'))
  })

  afterEach(() => {
    if (db) db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates database with WAL mode', () => {
    db = initDatabase(join(tmpDir, 'test.db'))
    const mode = db.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
  })

  it('creates all expected tables', () => {
    db = initDatabase(join(tmpDir, 'test.db'))
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(tables).toContain('runs')
    expect(tables).toContain('leases')
    expect(tables).toContain('issue_links')
    expect(tables).toContain('events')
    expect(tables).toContain('agent_events')
    expect(tables).toContain('daily_costs')
    expect(tables).toContain('daily_run_usage')
    expect(tables).toContain('schema_migrations')
  })

  it('is idempotent — safe to run twice', () => {
    const dbPath = join(tmpDir, 'test.db')
    db = initDatabase(dbPath)
    db.close()

    // Run again — should not throw
    db = initDatabase(dbPath)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
    expect(tables.length).toBeGreaterThan(0)
  })

  it('sets busy_timeout', () => {
    db = initDatabase(join(tmpDir, 'test.db'))
    const timeout = db.pragma('busy_timeout', { simple: true })
    expect(timeout).toBe(5000)
  })

  it('records migration in schema_migrations', () => {
    db = initDatabase(join(tmpDir, 'test.db'))
    const migrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
    expect(migrations.length).toBeGreaterThanOrEqual(1)
    expect((migrations[0] as { version: number }).version).toBe(1)
  })

  it('creates expected indexes', () => {
    db = initDatabase(join(tmpDir, 'test.db'))
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(indexes).toContain('idx_runs_repo_issue')
    expect(indexes).toContain('idx_runs_status')
    expect(indexes).toContain('idx_events_run_id')
    expect(indexes).toContain('idx_events_created')
    expect(indexes).toContain('idx_agent_events_run')
  })

  it('adds run title columns via migrations', () => {
    db = initDatabase(join(tmpDir, 'test.db'))
    const columns = db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((row) => (row as { name: string }).name)

    expect(columns).toContain('issue_title')
    expect(columns).toContain('pr_title')
  })
})
