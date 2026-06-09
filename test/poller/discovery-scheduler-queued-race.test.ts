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

function makeIssue(number: number, labels: string[] = []): ForgeIssue {
  return {
    number,
    nodeId: `issue-${number}`,
    repo: 'org/repo',
    title: `Issue ${number}`,
    body: '',
    labels,
    assignees: [],
    state: 'open',
    createdAt: '2026-06-09T00:00:00Z',
    updatedAt: '2026-06-09T00:00:00Z',
    url: `https://example.com/org/repo/issues/${number}`,
  }
}

/**
 * Forge whose label listing is EMPTY — simulates GitHub not yet having
 * propagated the `ready` label transition that `retry`/queue just wrote —
 * but whose direct `getIssue` still returns the issue.
 */
function makeLabelLaggyForge(issuesByNumber: Record<number, ForgeIssue>): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockImplementation(async (_repo: string, issueNumber: number) => {
      const issue = issuesByNumber[issueNumber]
      if (!issue) throw new Error(`no such issue ${issueNumber}`)
      return issue
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
  } as unknown as ForgeAdapter
}

describe('discoverIssuesForRepo dispatches queued DB runs despite forge label lag', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-discovery-queued-race-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('targeted poll dispatches a queued run even when forge label listing is empty', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const issue = makeIssue(7)
    const forge = makeLabelLaggyForge({ 7: issue })
    const leaseManager = new LeaseManager(db)
    const runManager = new RunManager(db)
    const issueManager = new IssueManager(db)

    // A queued DB run exists (e.g. just created by `retry --immediate`).
    runManager.create({
      repo: repoConfig.repo,
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
      targetIssue: { repo: repoConfig.repo, issueNumber: issue.number },
    })

    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.issue.number).toBe(issue.number)
    expect(discovered[0]!.issueRepo).toBe(repoConfig.repo)
    expect(forge.getIssue).toHaveBeenCalledWith(repoConfig.repo, issue.number)
  })

  it('non-targeted poll (queue+signal) picks up queued repo runs when forge listing is empty', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const issue = makeIssue(11)
    const forge = makeLabelLaggyForge({ 11: issue })
    const leaseManager = new LeaseManager(db)
    const runManager = new RunManager(db)
    const issueManager = new IssueManager(db)

    runManager.create({
      repo: repoConfig.repo,
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
      // no targetIssue — the external-trigger/full-poll path
    })

    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.issue.number).toBe(issue.number)
    expect(forge.getIssue).toHaveBeenCalledWith(repoConfig.repo, issue.number)
  })

  it('does not duplicate an issue already returned by forge label discovery', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const issue = makeIssue(3, [repoConfig.selectors?.includeLabelsAny?.[0] ?? 'no:ready'])
    // Label HAS propagated: forge discovery returns the issue.
    const forge = {
      listEligibleIssues: vi.fn().mockResolvedValue([issue]),
      getIssue: vi.fn().mockResolvedValue(issue),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as ForgeAdapter
    const leaseManager = new LeaseManager(db)
    const runManager = new RunManager(db)
    const issueManager = new IssueManager(db)

    runManager.create({
      repo: repoConfig.repo,
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
      targetIssue: { repo: repoConfig.repo, issueNumber: issue.number },
    })

    expect(discovered).toHaveLength(1)
    // Already in the forge-discovered set → no redundant direct fetch.
    expect(forge.getIssue).not.toHaveBeenCalled()
  })

  it('skips a queued run whose issue is already leased (avoid double-dispatch)', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const issue = makeIssue(9)
    const forge = makeLabelLaggyForge({ 9: issue })
    const leaseManager = new LeaseManager(db)
    const runManager = new RunManager(db)
    const issueManager = new IssueManager(db)

    runManager.create({
      repo: repoConfig.repo,
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    // Another worker already holds the lease → it is being processed.
    expect(leaseManager.acquire(repoConfig.repo, issue.number, 'other-worker', 1800)).toBe(true)

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
      targetIssue: { repo: repoConfig.repo, issueNumber: issue.number },
    })

    expect(discovered).toHaveLength(0)
    expect(forge.getIssue).not.toHaveBeenCalled()
  })

  it('skips a queued run whose issue cannot be fetched and does not crash discovery', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const good = makeIssue(20)
    const forge = {
      listEligibleIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn().mockImplementation(async (_repo: string, n: number) => {
        if (n === 20) return good
        throw new Error('forge 500')
      }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as ForgeAdapter
    const leaseManager = new LeaseManager(db)
    const runManager = new RunManager(db)
    const issueManager = new IssueManager(db)

    for (const n of [21, 20]) {
      runManager.create({
        repo: repoConfig.repo,
        issueNumber: n,
        issueNodeId: `issue-${n}`,
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
      })
    }

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
    })

    // #21's fetch failed (skipped); #20 still dispatched.
    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.issue.number).toBe(20)
  })

  it('skips a queued run whose issue has since been closed', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const closed: ForgeIssue = { ...makeIssue(30), state: 'closed' }
    const forge = makeLabelLaggyForge({ 30: closed })
    const leaseManager = new LeaseManager(db)
    const runManager = new RunManager(db)
    const issueManager = new IssueManager(db)

    runManager.create({
      repo: repoConfig.repo,
      issueNumber: closed.number,
      issueNodeId: closed.nodeId,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
      targetIssue: { repo: repoConfig.repo, issueNumber: closed.number },
    })

    // Forge label discovery only lists OPEN issues; the direct-fetch path must
    // not resurrect a closed issue just because a queued row lingers.
    expect(discovered).toHaveLength(0)
  })

  it('targeted poll does not dispatch a queued row that has been terminated', async () => {
    const config = makeTestConfig()
    const repoConfig = config.repos[0]!
    const issue = makeIssue(40)
    const forge = makeLabelLaggyForge({ 40: issue })
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
    // Abnormal-but-defended: a queued row stamped terminated must not dispatch
    // on the targeted (retry --immediate) path either.
    db.prepare('UPDATE runs SET terminated_at = ? WHERE id = ?').run(new Date().toISOString(), run.id)

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
      targetIssue: { repo: repoConfig.repo, issueNumber: issue.number },
    })

    expect(discovered).toHaveLength(0)
    expect(forge.getIssue).not.toHaveBeenCalled()
  })
})
