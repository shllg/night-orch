import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { RepoConfig } from '../../src/config/schema.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { queueContinue } from '../../src/ops/continue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeRepoConfig(): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: {
      ready: ['orch:ready'],
      running: 'orch:running',
      blocked: ['orch:blocked'],
      reviewReady: 'orch:review-ready',
      error: 'orch:error',
      retry: 'orch:retry',
      planning: 'orch:planning',
    },
    defaults: {
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
      doneMode: 'pr-ready',
      notifyPriority: 'normal',
      prMentions: [],
    },
    verify: [],
    selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
    agents: {},
    planning: { prdDirectory: 'docs/prd' },
  }
}

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 58,
      nodeId: 'node-58',
      title: 'Test',
      body: '',
      labels: ['orch:blocked'],
      assignees: [],
      state: 'open',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      url: 'https://example.invalid/issues/58',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
    updateComment: vi.fn(),
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    ...overrides,
  } as unknown as ForgeAdapter
}

describe('queueContinue', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-continue-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('queues blocked run with merged PR/review context', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 58,
      issueNodeId: 'node-58',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      prNumber: 901,
      endedAt: '2026-02-01T12:00:00Z',
      lastError: 'Reviewer blocked: unresolved feedback',
      phaseData: {
        issueRepo: 'org/repo',
      },
    })

    const forge = makeForge({
      getPR: vi.fn().mockResolvedValue({
        number: 901,
        title: 'Fix issue',
        body: '',
        state: 'open',
        mergeable: false,
        headBranch: 'orch/58-fix',
        headSha: 'abc123',
        baseBranch: 'main',
        url: 'https://example.invalid/pr/901',
      }),
      getPRCheckStatus: vi.fn().mockResolvedValue({
        overall: 'failure',
        checks: [{ name: 'test', conclusion: 'failure', detailsUrl: 'https://ci.invalid/1' }],
      }),
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          body: '/orch continue',
          user: 'maintainer',
          createdAt: '2026-02-01T12:01:00Z',
          updatedAt: '2026-02-01T12:01:00Z',
        },
        {
          id: 2,
          body: 'Please also fix the flaky timeout assertion.',
          user: 'maintainer',
          createdAt: '2026-02-01T12:03:00Z',
          updatedAt: '2026-02-01T12:03:00Z',
        },
      ]),
      listPRReviews: vi.fn().mockResolvedValue([
        { id: 10, user: 'maintainer', state: 'changes_requested', body: 'Address comments', submittedAt: '2026-02-01T12:02:00Z' },
      ]),
    })

    const result = await queueContinue(db, forge, makeRepoConfig(), 58, '')

    expect(result.queued).toBe(true)
    const updated = runManager.getByRepoAndIssue('org/repo', 58)
    expect(updated?.status).toBe('queued')
    expect(updated?.blockReason).toBeNull()
    expect(updated?.phaseData?.reactionType).toBe('continue')
    expect(updated?.phaseData?.reactionContext).toContain('PR has merge conflicts with base branch')
    expect(updated?.phaseData?.reactionContext).toContain('Please also fix the flaky timeout assertion.')
    expect(updated?.phaseData?.reactionContext).not.toContain('/orch continue')
  })

  it('queues error runs for a follow-up continue pass', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 59,
      issueNodeId: 'node-59',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'error',
      endedAt: '2026-02-01T12:00:00Z',
      lastError: 'Worker crashed while parsing output',
    })

    const forge = makeForge()
    const result = await queueContinue(db, forge, makeRepoConfig(), 59, '')

    expect(result.queued).toBe(true)
    expect(result.reason).toContain('Queued for continue pass')
    const updated = runManager.getByRepoAndIssue('org/repo', 59)
    expect(updated?.status).toBe('queued')
    expect(updated?.phaseData?.reactionType).toBe('continue')
    expect(updated?.phaseData?.reactionContext).toContain('## Previous Run State')
    expect(updated?.phaseData?.reactionContext).toContain('Worker crashed while parsing output')
  })

  it('rejects continue for unsupported statuses', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 62,
      issueNodeId: 'node-62',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'completed',
      endedAt: '2026-02-01T12:00:00Z',
    })

    const forge = makeForge()
    const result = await queueContinue(db, forge, makeRepoConfig(), 62, '')

    expect(result.queued).toBe(false)
    expect(result.reason).toContain('blocked/review_ready/error')
    const unchanged = runManager.getByRepoAndIssue('org/repo', 62)
    expect(unchanged?.status).toBe('completed')
  })

  it('queues fallback continue context when no PR signals exist', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 60,
      issueNodeId: 'node-60',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: '2026-02-01T12:00:00Z',
    })

    const forge = makeForge({
      getIssue: vi.fn().mockResolvedValue({
        number: 60,
        nodeId: 'node-60',
        title: 'Test',
        body: '',
        labels: ['orch:blocked'],
        assignees: [],
        state: 'open',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        url: 'https://example.invalid/issues/60',
      }),
      listIssueComments: vi.fn().mockResolvedValue([]),
    })

    const result = await queueContinue(db, forge, makeRepoConfig(), 60, '')

    expect(result.queued).toBe(true)
    const updated = runManager.getByRepoAndIssue('org/repo', 60)
    expect(updated?.status).toBe('queued')
    expect(updated?.phaseData?.reactionType).toBe('continue')
    expect(updated?.phaseData?.reactionContext).toContain('No new CI failures')
  })

  it('supports dry-run without mutating state or posting updates', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 61,
      issueNodeId: 'node-61',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: '2026-02-01T12:00:00Z',
      phaseData: {
        issueRepo: 'org/repo',
      },
    })

    const forge = makeForge()
    const result = await queueContinue(db, forge, makeRepoConfig(), 61, '', { dryRun: true })

    expect(result.queued).toBe(true)
    expect(result.reason).toContain('Would queue')

    const unchanged = runManager.getByRepoAndIssue('org/repo', 61)
    expect(unchanged?.status).toBe('blocked')
    expect(unchanged?.endedAt).toBe('2026-02-01T12:00:00Z')
    expect(unchanged?.phaseData).toEqual({ issueRepo: 'org/repo' })

    expect(forge.getIssue).not.toHaveBeenCalled()
    expect(forge.listIssueComments).not.toHaveBeenCalled()
    expect(forge.commentOnIssue).not.toHaveBeenCalled()
    expect(forge.addLabels).not.toHaveBeenCalled()
    expect(forge.removeLabels).not.toHaveBeenCalled()
  })
})
