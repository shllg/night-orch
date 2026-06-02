import type Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import type { Config, RepoConfig } from '../../src/config/schema.js'
import { initDatabase } from '../../src/state/db.js'
import { RebaseFanoutManager } from '../../src/state/rebase-fanouts.js'
import { RunManager, type RunStatus } from '../../src/state/runs.js'
import { fanoutRebaseAfterMerge, selectFanoutCandidates, warnIncompleteRebaseFanouts } from '../../src/ops/fanout-rebase.js'
import { makeTestConfig, makeTestRepoConfig } from '../helpers/factories.js'
import type { ForgeAdapter } from '../../src/forge/types.js'

describe('selectFanoutCandidates', () => {
  it('keeps tracked sibling PRs and excludes source, terminal, active, missing-PR, and open-rebase rows', () => {
    const candidates = selectFanoutCandidates([
      candidate({ issueNumber: 1, prNumber: 101, status: 'review_ready' }),
      candidate({ issueNumber: 2, prNumber: 102, status: 'blocked' }),
      candidate({ issueNumber: 3, prNumber: 103, status: 'error' }),
      candidate({ issueNumber: 4, prNumber: 104, status: 'queued' }),
      candidate({ issueNumber: 5, prNumber: 105, status: 'running' }),
      candidate({ issueNumber: 6, prNumber: 106, status: 'completed' }),
      candidate({ issueNumber: 7, prNumber: null, status: 'review_ready' }),
      candidate({ issueNumber: 8, prNumber: 108, status: 'review_ready', hasOpenRebaseAttempt: true }),
      candidate({ issueNumber: 9, prNumber: 99, status: 'review_ready' }),
    ], { sourcePrNumber: 99 }, { maxFanout: 10 })

    expect(candidates.map((c) => c.issueNumber)).toEqual([1, 2, 3])
  })

  it('caps candidates by maxFanout after filtering', () => {
    const candidates = selectFanoutCandidates([
      candidate({ issueNumber: 1, prNumber: 101, status: 'review_ready' }),
      candidate({ issueNumber: 2, prNumber: 102, status: 'review_ready' }),
      candidate({ issueNumber: 3, prNumber: 103, status: 'review_ready' }),
    ], { sourcePrNumber: 99 }, { maxFanout: 2 })

    expect(candidates.map((c) => c.issueNumber)).toEqual([1, 2])
  })

  it('orders candidates by issueNumber ascending so maxFanout truncation is deterministic', () => {
    const candidates = selectFanoutCandidates([
      candidate({ issueNumber: 50, prNumber: 150, status: 'review_ready' }),
      candidate({ issueNumber: 10, prNumber: 110, status: 'review_ready' }),
      candidate({ issueNumber: 30, prNumber: 130, status: 'review_ready' }),
      candidate({ issueNumber: 20, prNumber: 120, status: 'review_ready' }),
      candidate({ issueNumber: 40, prNumber: 140, status: 'review_ready' }),
    ], { sourcePrNumber: 99 }, { maxFanout: 3 })

    expect(candidates.map((c) => c.issueNumber)).toEqual([10, 20, 30])
  })
})

describe('fanoutRebaseAfterMerge', () => {
  it('no-ops when autoRebaseOnMerge is disabled', async () => {
    const db = initDatabase(':memory:')
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const getPR = vi.fn()
    const forge = makeForge({ getPR })

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: false } }),
      forge,
      config: makeTestConfig(),
      sourcePrNumber: 42,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
    })

    expect(result.skippedDisabled).toBe(true)
    expect(queueRebase).not.toHaveBeenCalled()
    expect(getPR).not.toHaveBeenCalled()
  })

  it('returns skippedDisabled when repoConfig.autoRebaseOnMerge is undefined', async () => {
    const db = initDatabase(':memory:')
    const queueRebase = vi.fn()
    const getPR = vi.fn()
    const forge = makeForge({ getPR })
    const repoConfig = {
      repo: 'org/repo',
      forge: 'github',
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: {
        ready: ['no:ready'],
        running: 'no:running',
        blocked: ['no:blocked'],
        reviewReady: 'no:review-ready',
        error: 'no:error',
        retry: 'no:retry',
      },
      defaults: {
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
        prMentions: [],
      },
      verify: [],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: {},
    } as unknown as RepoConfig

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig,
      forge,
      config: { repos: [repoConfig] } as unknown as Config,
      sourcePrNumber: 42,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
    })

    expect(result).toEqual({
      queued: 0,
      skipped: 0,
      failures: 0,
      alreadyFannedOut: false,
      skippedDisabled: true,
    })
    expect(queueRebase).not.toHaveBeenCalled()
    expect(getPR).not.toHaveBeenCalled()
  })

  it('no-ops when the source PR was already fanned out', async () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db)
    fanouts.mark('org/repo', 42, 0)
    const queueRebase = vi.fn()

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge: makeForge(),
      config: makeTestConfig(),
      sourcePrNumber: 42,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })

    expect(result.alreadyFannedOut).toBe(true)
    expect(queueRebase).not.toHaveBeenCalled()
  })

  it('queues only open PRs that match the source base branch and records successful fan-out', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    seedSibling(db, 2, 102)
    seedSibling(db, 3, 103)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const getPR = vi.fn(async (_repo: string, prNumber: number) => {
        if (prNumber === 101) return { state: 'open', baseBranch: 'main' }
        if (prNumber === 102) return { state: 'open', baseBranch: 'develop' }
        return { state: 'closed', baseBranch: 'main' }
      })
    const forge = makeForge({ getPR })

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })

    expect(result).toMatchObject({ queued: 1, skipped: 0, failures: 0 })
    expect(queueRebase).toHaveBeenCalledTimes(1)
    expect(queueRebase).toHaveBeenCalledWith(expect.objectContaining({
      issueNumber: 1,
      trigger: { kind: 'fanout', sourcePr: 99 },
      strategyOverride: 'rebase',
    }))
    expect(fanouts.has('org/repo', 99)).toBe(true)
  })

  it('counts benign queue skips as skipped and still records fan-out', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: false, reason: 'Run is already queued' })
    const forge = makeForge({ getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'main' }) })

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })

    expect(result).toMatchObject({ queued: 0, skipped: 1, failures: 0 })
    expect(fanouts.has('org/repo', 99)).toBe(true)
  })

  it('records every sibling outcome and marks partial fan-out failures', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    seedSibling(db, 2, 102)
    seedSibling(db, 3, 103)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn(async ({ issueNumber }: { issueNumber: number }) => {
      if (issueNumber === 1) return { queued: true, reason: 'ok' }
      if (issueNumber === 2) return { queued: false, reason: 'Run is already queued' }
      throw new Error('forge unavailable')
    })
    const forge = makeForge({ getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'main' }) })

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
      sourceMergeSha: 'merge-sha-99',
    })

    expect(result).toMatchObject({ queued: 1, skipped: 1, failures: 1 })
    expect(fanouts.get('org/repo', 99)).toMatchObject({
      siblings_queued: 1,
      failures_count: 1,
      source_merge_sha: 'merge-sha-99',
    })
    expect(fanouts.listSiblings('org/repo', 99)).toEqual([
      expect.objectContaining({ sibling_pr_number: 101, status: 'queued', reason: null }),
      expect.objectContaining({
        sibling_pr_number: 102,
        status: 'skipped',
        reason: 'Run is already queued',
      }),
      expect.objectContaining({
        sibling_pr_number: 103,
        status: 'failed',
        message: 'forge unavailable',
      }),
    ])
  })

  it('uses maxChainLength override or twice the global attempt cap', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const forge = makeForge({ getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'main' }) })

    await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true, maxChainLength: 12 } }),
      forge,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })
    expect(queueRebase).toHaveBeenCalledWith(expect.objectContaining({ maxAttemptChainLength: 12 }))

    queueRebase.mockClear()
    await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge,
      config: makeTestConfig(),
      sourcePrNumber: 100,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })
    expect(queueRebase).toHaveBeenCalledWith(expect.objectContaining({ maxAttemptChainLength: 6 }))
  })

  it('forwards autoRebaseOnMerge.strategy as strategyOverride to queueRebase', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const forge = makeForge({ getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'main' }) })

    await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true, strategy: 'merge' } }),
      forge,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })

    expect(queueRebase).toHaveBeenCalledWith(expect.objectContaining({ strategyOverride: 'merge' }))
  })
})

describe('warnIncompleteRebaseFanouts', () => {
  it('logs a bounded startup warning for fan-outs with failed siblings', () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db)
    fanouts.mark('org/repo', 99, 1, { failuresCount: 1, sourceMergeSha: 'merge-sha' })
    const log = { warn: vi.fn() }

    const count = warnIncompleteRebaseFanouts(db, log)

    expect(count).toBe(1)
    expect(log.warn).toHaveBeenCalledWith(
      {
        count: 1,
        samples: [
          {
            repo: 'org/repo',
            sourcePrNumber: 99,
            failuresCount: 1,
            sourceMergeSha: 'merge-sha',
          },
        ],
      },
      'Incomplete rebase fan-outs detected',
    )
  })
})

function candidate(overrides: {
  issueNumber: number
  prNumber: number | null
  status: RunStatus
  hasOpenRebaseAttempt?: boolean
}) {
  return {
    id: `run-${overrides.issueNumber}`,
    repo: 'org/repo',
    operationIntent: 'auto' as const,
    hasOpenRebaseAttempt: false,
    ...overrides,
  }
}

function seedSibling(db: Database.Database, issueNumber: number, prNumber: number): void {
  const runs = new RunManager(db)
  const run = runs.create({
    repo: 'org/repo',
    issueNumber,
    issueNodeId: `node-${issueNumber}`,
    planner: 'claude',
    coder: 'codex',
    reviewer: 'codex',
  })
  runs.updateWorktree(run.id, { branchName: `orch/${issueNumber}` })
  runs.updatePullRequest(run.id, { prNumber })
  runs.updateLifecycle(run.id, { status: 'review_ready' })
}

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn(),
    updateComment: vi.fn(),
    listPRReviews: vi.fn(),
    listPRReviewComments: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getPR: vi.fn(),
    ...overrides,
  }
}
