import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import type { ForgeAdapter, ForgeIssue } from '../../src/forge/types.js'
import { discoverIssuesForRepo } from '../../src/poller/discovery-scheduler.js'
import { makeTestConfig } from '../helpers/factories.js'
import { initDatabase } from '../../src/state/db.js'
import { LeaseManager } from '../../src/state/leases.js'
import { RunManager } from '../../src/state/runs.js'
import { IssueManager } from '../../src/state/issues.js'

function makeIssue(labels: string[]): ForgeIssue {
  return {
    number: 1,
    nodeId: 'issue-1',
    repo: 'org/repo',
    title: 'Replay me',
    body: '',
    labels,
    assignees: [],
    state: 'open',
    createdAt: '2026-04-13T00:00:00Z',
    updatedAt: '2026-04-13T00:00:00Z',
    url: 'https://example.com/org/repo/issues/1',
  }
}

function makeForge(issue: ForgeIssue): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn().mockResolvedValue([issue]),
    addLabels: vi.fn().mockImplementation(async (_repo: string, _issueNumber: number, labels: string[]) => {
      for (const label of labels) {
        if (!issue.labels.includes(label)) issue.labels.push(label)
      }
    }),
    removeLabels: vi.fn().mockImplementation(async (_repo: string, _issueNumber: number, labels: string[]) => {
      issue.labels = issue.labels.filter((label) => !labels.includes(label))
    }),
  } as unknown as ForgeAdapter
}

describe('discoverIssuesForRepo stale review_ready filtering', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-discovery-scheduler-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('filters stale review_ready runs with no queued control and reconciles labels before dispatch', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const issue = makeIssue(['no:ready'])
    const forge = makeForge(issue)
    const leaseManager = new LeaseManager(db)
    const runManager = new RunManager(db)
    const issueManager = new IssueManager(db)

    const run = runManager.create({
      repo: repoConfig.repo,
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'review_ready',
      endedAt: '2026-04-13T00:00:00Z',
      prNumber: 164,
    })

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
    })

    expect(discovered).toEqual([])
    expect(forge.addLabels).toHaveBeenCalledWith(repoConfig.repo, issue.number, ['no:review-ready'])
    expect(forge.removeLabels).toHaveBeenCalledWith(repoConfig.repo, issue.number, ['no:ready'])
    expect(issue.labels.sort()).toEqual(['no:review-ready'])
  })
})
