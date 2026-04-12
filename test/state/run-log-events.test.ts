import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import {
  insertRunLogEvent,
  loadIssueLogEvents,
  recordUserAction,
} from '../../src/state/run-log-events.js'

describe('run-log-events', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-run-log-events-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records user actions with source=user', () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 7,
      issueNodeId: 'node-7',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    recordUserAction(db, {
      runId: run.id,
      kind: 'continue',
      actor: 'web',
      details: { strategy: 'merge' },
      timestamp: '2026-04-12T10:00:00Z',
    })

    const rows = loadIssueLogEvents(db, 'org/repo', 7, 0, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      runId: run.id,
      source: 'user',
      type: 'user_action',
      role: 'web',
      data: {
        kind: 'continue',
        actor: 'web',
        strategy: 'merge',
      },
    })
  })

  it('loads issue-scoped events across multiple runs in id order', () => {
    const runManager = new RunManager(db)
    const firstRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 9,
      issueNodeId: 'node-9',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    insertRunLogEvent(db, {
      runId: firstRun.id,
      source: 'agent',
      phase: 'code',
      role: 'coder',
      type: 'text',
      data: { text: 'first attempt' },
      timestamp: '2026-04-12T10:00:00Z',
    })
    runManager.update(firstRun.id, {
      status: 'completed',
      endedAt: '2026-04-12T10:01:00Z',
    })

    const secondRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 9,
      issueNodeId: 'node-9',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    recordUserAction(db, {
      runId: secondRun.id,
      kind: 'retry',
      actor: 'cli',
      timestamp: '2026-04-12T10:02:00Z',
    })

    const rows = loadIssueLogEvents(db, 'org/repo', 9, 0, 10)
    expect(rows.map((row) => row.runId)).toEqual([firstRun.id, secondRun.id])
    expect(rows.map((row) => row.source)).toEqual(['agent', 'user'])
  })
})
