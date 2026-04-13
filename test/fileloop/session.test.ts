import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../../src/state/db.js'
import { FileLoopSessionStore } from '../../src/fileloop/session.js'
import { FileLoopFileStateStore } from '../../src/fileloop/file-state.js'
import { hasActiveIssueRuns } from '../../src/fileloop/yield.js'
import { RunManager } from '../../src/state/runs.js'

describe('file-loop state stores', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-fileloop-state-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates and updates sessions', () => {
    const store = new FileLoopSessionStore(db)
    const created = store.create({
      repo: 'org/repo',
      branch: 'orch/file-loop/repo/20260413',
      worktreePath: '/tmp/worktree',
      endsAt: '2026-04-13T10:00:00.000Z',
    })

    expect(created.status).toBe('armed')

    store.update(created.id, {
      status: 'running',
      iterations: 4,
      filesTouched: 2,
      totalCostUsd: 1.25,
      lastFileIterAt: '2026-04-13T09:30:00.000Z',
    })

    const updated = store.getById(created.id)
    expect(updated).not.toBeNull()
    expect(updated?.status).toBe('running')
    expect(updated?.iterations).toBe(4)
    expect(updated?.filesTouched).toBe(2)
    expect(updated?.totalCostUsd).toBe(1.25)
  })

  it('tracks active session by repo', () => {
    const store = new FileLoopSessionStore(db)
    const session = store.create({
      repo: 'org/repo',
      branch: 'orch/file-loop/repo/20260413',
      worktreePath: '/tmp/worktree',
      endsAt: '2026-04-13T10:00:00.000Z',
      status: 'running',
    })

    expect(store.getActive('org/repo')?.id).toBe(session.id)

    store.markDone(session.id, 'timer')
    expect(store.getActive('org/repo')).toBeNull()
  })

  it('upserts file state with touch counts', () => {
    const store = new FileLoopFileStateStore(db)

    store.upsert({
      repo: 'org/repo',
      filePath: 'src/app.ts',
      lastStatus: 'edited',
      lastSummaryShort: 'Tightened null handling',
      lastDifficultyFlag: 'trivial',
      incrementTouchCount: true,
    })
    store.upsert({
      repo: 'org/repo',
      filePath: 'src/app.ts',
      lastStatus: 'noop',
      lastSummaryShort: 'No change needed',
      lastDifficultyFlag: 'trivial',
      incrementTouchCount: true,
    })

    const state = store.get('org/repo', 'src/app.ts')
    expect(state?.touchCount).toBe(2)
    expect(state?.lastStatus).toBe('noop')
  })

  it('detects active issue runs without synthetic file-loop rows', () => {
    const runs = new RunManager(db)
    runs.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'Test issue',
      issueNodeId: 'node-1',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    expect(hasActiveIssueRuns('org/repo', db)).toBe(true)
  })
})
