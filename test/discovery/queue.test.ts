import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { prioritizeDiscoveredIssues } from '../../src/discovery/queue.js'
import type { DiscoveredIssue } from '../../src/discovery/discover.js'
import { makeTestRepoConfig } from '../helpers/factories.js'

const repoConfig = makeTestRepoConfig()

function makeDiscovered(issueNumber: number): DiscoveredIssue {
  return {
    issue: {
      number: issueNumber,
      nodeId: `node-${issueNumber}`,
      title: `Issue ${issueNumber}`,
      body: 'Body',
      labels: ['no:ready'],
      assignees: [],
      state: 'open',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      url: `https://github.com/org/repo/issues/${issueNumber}`,
    },
    issueRepo: 'org/repo',
    triage: { level: 'standard', reason: 'Standard issue' },
    repoConfig,
  }
}

describe('prioritizeDiscoveredIssues', () => {
  let tmpDir: string
  let db: Database.Database
  let runManager: RunManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-discovery-queue-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    runManager = new RunManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('prioritizes rebase/refresh controls before continue/retry and fresh work', () => {
    const rebaseRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: 'node-1',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(rebaseRun.id, { operationIntent: 'rebase' })

    const continueRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 2,
      issueNodeId: 'node-2',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(continueRun.id, { operationIntent: 'continue' })

    const autoRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 3,
      issueNodeId: 'node-3',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const ranked = prioritizeDiscoveredIssues(runManager, 'org/repo', [
      makeDiscovered(4),
      makeDiscovered(3),
      makeDiscovered(2),
      makeDiscovered(1),
    ])

    expect(autoRun.status).toBe('queued')
    expect(ranked.map((item) => item.issue.number)).toEqual([1, 2, 3, 4])
  })

  it('infers queued auto intents from phase data and merge-conflict block reasons', () => {
    const refreshRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 11,
      issueNodeId: 'node-11',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(refreshRun.id, {
      operationIntent: 'auto',
      phaseData: { reactionType: 'refresh' },
    })

    const retryRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 12,
      issueNodeId: 'node-12',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(retryRun.id, {
      operationIntent: 'auto',
      blockReason: 'merge_conflict',
    })

    const ranked = prioritizeDiscoveredIssues(runManager, 'org/repo', [
      makeDiscovered(12),
      makeDiscovered(11),
      makeDiscovered(13),
    ])

    expect(ranked.map((item) => item.issue.number)).toEqual([11, 12, 13])
  })

  it('only prioritizes inferred follow-up intents from queued runs', () => {
    const blockedRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 21,
      issueNodeId: 'node-21',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(blockedRun.id, {
      status: 'blocked',
      operationIntent: 'auto',
      blockReason: 'merge_conflict',
      phaseData: { reactionType: 'refresh' },
    })

    const queuedRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 22,
      issueNodeId: 'node-22',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(queuedRun.id, {
      operationIntent: 'auto',
      phaseData: { reactionType: 'refresh' },
    })

    const ranked = prioritizeDiscoveredIssues(runManager, 'org/repo', [
      makeDiscovered(21),
      makeDiscovered(22),
    ])

    expect(ranked.map((item) => item.issue.number)).toEqual([22, 21])
  })
})
