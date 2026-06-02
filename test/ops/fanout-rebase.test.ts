import type Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { initDatabase } from '../../src/state/db.js'
import { RebaseFanoutManager } from '../../src/state/rebase-fanouts.js'
import { RunManager, type RunStatus } from '../../src/state/runs.js'
import { fanoutRebaseAfterMerge, selectFanoutCandidates } from '../../src/ops/fanout-rebase.js'
import { makeTestConfig, makeTestRepoConfig } from '../helpers/factories.js'

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
})

describe('fanoutRebaseAfterMerge', () => {
  it('no-ops when autoRebaseOnMerge is disabled', async () => {
    const db = initDatabase(':memory:')
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const forge = { getPR: vi.fn() }

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: false } }),
      forge: forge as never,
      config: makeTestConfig(),
      sourcePrNumber: 42,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
    })

    expect(result.skippedDisabled).toBe(true)
    expect(queueRebase).not.toHaveBeenCalled()
    expect(forge.getPR).not.toHaveBeenCalled()
  })

  it('no-ops when the source PR was already fanned out', async () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db)
    fanouts.mark('org/repo', 42, 0)
    const queueRebase = vi.fn()

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge: {} as never,
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
    const forge = {
      getPR: vi.fn(async (_repo: string, prNumber: number) => {
        if (prNumber === 101) return { state: 'open', baseBranch: 'main' }
        if (prNumber === 102) return { state: 'open', baseBranch: 'develop' }
        return { state: 'closed', baseBranch: 'main' }
      }),
    }

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge: forge as never,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })

    expect(result).toMatchObject({ queued: 1, skipped: 0, failures: 0 })
    expect(queueRebase).toHaveBeenCalledTimes(1)
    expect(queueRebase.mock.calls[0]?.[3]).toBe(1)
    expect(fanouts.has('org/repo', 99)).toBe(true)
  })

  it('counts benign queue skips as skipped and still records fan-out', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: false, reason: 'Run is already queued' })
    const forge = { getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'main' }) }

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge: forge as never,
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

  it('does not record fan-out when queueing fails so the next cycle can retry', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockRejectedValue(new Error('forge unavailable'))
    const forge = { getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'main' }) }

    const result = await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge: forge as never,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })

    expect(result.failures).toBe(1)
    expect(fanouts.has('org/repo', 99)).toBe(false)
  })

  it('uses maxChainLength override or twice the global attempt cap', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const forge = { getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'main' }) }

    await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true, maxChainLength: 12 } }),
      forge: forge as never,
      config: makeTestConfig(),
      sourcePrNumber: 99,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })
    expect(queueRebase.mock.calls[0]?.[5].maxAttemptChainLength).toBe(12)

    queueRebase.mockClear()
    await fanoutRebaseAfterMerge({
      db,
      repoConfig: makeTestRepoConfig({ autoRebaseOnMerge: { enabled: true } }),
      forge: forge as never,
      config: makeTestConfig(),
      sourcePrNumber: 100,
      baseBranch: 'main',
      botUser: 'bot',
      queueRebase,
      fanouts,
    })
    expect(queueRebase.mock.calls[0]?.[5].maxAttemptChainLength).toBe(6)
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
