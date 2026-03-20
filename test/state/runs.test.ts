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
      issueNodeId: 'MDU6SXNzdWU0Mg==',
      planner: 'claude',
      coder: 'codex',
      reviewer: 'claude',
    })
    expect(run.id).toMatch(/^run-/)
    expect(run.repo).toBe('org/repo')
    expect(run.issueNumber).toBe(42)
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
    })

    const updated = runManager.getById(run.id)
    expect(updated?.status).toBe('running')
    expect(updated?.branchName).toBe('orch/1-fix-bug')
    expect(updated?.branchSlug).toBe('fix-bug')
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

  it('getByRepoAndIssue returns null for missing', () => {
    const found = runManager.getByRepoAndIssue('org/repo', 999)
    expect(found).toBeNull()
  })

  it('getActive returns only queued/running records', () => {
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
    runManager.update(r1.id, { status: 'running' })
    runManager.update(r2.id, { status: 'completed' })

    const active = runManager.getActive()
    expect(active).toHaveLength(1)
    expect(active[0]?.issueNumber).toBe(1)
  })
})
