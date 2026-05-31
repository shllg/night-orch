import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { findMergeEligiblePRs } from '../../src/merge-queue/eligibility.js'
import type { ForgeAdapter, ForgePRReview } from '../../src/forge/types.js'
import type { RepoConfig } from '../../src/config/schema.js'
import { initDatabase } from '../../src/state/db.js'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

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
    listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getPRCheckStatus: vi.fn().mockResolvedValue({ overall: 'success', checks: [] }),
    ...overrides,
  } as unknown as ForgeAdapter
}

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: 'no:blocked',
      needsHuman: 'no:needs-human',
      reviewReady: 'no:review-ready',
      error: 'no:error',
      retry: 'no:retry',
      mergeQueued: 'no:merge-queued',
      merging: 'no:merging',
      mergeFailed: 'no:merge-failed',
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
    labelConfig: {},
    mergeQueue: {
      enabled: true,
      batchSize: 5,
      mergeMethod: 'merge',
      retryFlakyOnce: true,
      requireApproval: true,
      stagingBranchPrefix: 'orch/staging',
    },
    ...overrides,
  } as RepoConfig
}

describe('findMergeEligiblePRs', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'merge-elig-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty when no review_ready runs exist', async () => {
    const candidates = await findMergeEligiblePRs(db, makeForge(), makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('ignores runs that are not review_ready', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'running', 100)",
    ).run()

    const candidates = await findMergeEligiblePRs(db, makeForge(), makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('ignores review_ready runs without a PR number', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES ('r1', 'org/repo', 1, 'review_ready')",
    ).run()

    const candidates = await findMergeEligiblePRs(db, makeForge(), makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('finds review_ready PRs with passing CI and approval', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'human', state: 'approved', body: '', submittedAt: '' },
      ]),
      getPR: vi.fn().mockResolvedValue({
        number: 100,
        title: 'PR 100',
        body: '',
        state: 'open',
        headBranch: 'orch/100-fix',
        headSha: 'sha-100',
        baseBranch: 'main',
        url: 'https://example.test/pr/100',
      }),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.prNumber).toBe(100)
    expect(candidates[0]!.headSha).toBe('sha-100')
    expect(candidates[0]!.issueNumber).toBe(1)
    expect(candidates[0]!.runId).toBe('r1')
  })

  it('skips PRs with failing CI', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      getPRCheckStatus: vi.fn().mockResolvedValue({ overall: 'failure', checks: [] }),
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'human', state: 'approved', body: '', submittedAt: '' },
      ]),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('skips PRs with pending CI', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      getPRCheckStatus: vi.fn().mockResolvedValue({ overall: 'pending', checks: [] }),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('skips PRs without approval when requireApproval is true', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'human', state: 'commented', body: 'looks ok', submittedAt: '' },
      ]),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('skips PRs with changes_requested even if another reviewer approved', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    // Only approved review counts — changes_requested alone is not enough
    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'reviewer-a', state: 'changes_requested', body: '', submittedAt: '' },
      ]),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('skips PR when latest review from a reviewer is changes_requested after an earlier approved', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'alice', state: 'approved', body: '', submittedAt: '2026-01-01T00:00:00Z' },
        { id: 2, user: 'alice', state: 'changes_requested', body: 'second look', submittedAt: '2026-01-02T00:00:00Z' },
      ]),
      getPR: vi.fn().mockResolvedValue({
        number: 100, title: 'PR 100', body: '', state: 'open', headBranch: 'orch/100-fix',
        headSha: 'sha-100', baseBranch: 'main', url: 'https://example.test/pr/100',
      }),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('includes PR when latest review is approved after an earlier changes_requested', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'alice', state: 'changes_requested', body: '', submittedAt: '2026-01-01T00:00:00Z' },
        { id: 2, user: 'alice', state: 'approved', body: 'fixed', submittedAt: '2026-01-02T00:00:00Z' },
      ]),
      getPR: vi.fn().mockResolvedValue({
        number: 100, title: 'PR 100', body: '', state: 'open', headBranch: 'orch/100-fix',
        headSha: 'sha-100', baseBranch: 'main', url: 'https://example.test/pr/100',
      }),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(1)
  })

  it('skips PR when state is not open', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'human', state: 'approved', body: '', submittedAt: '' },
      ]),
      getPR: vi.fn().mockResolvedValue({
        number: 100, title: 'PR 100', body: '', state: 'closed', headBranch: 'orch/100-fix',
        headSha: 'sha-100', baseBranch: 'main', url: 'https://example.test/pr/100',
      }),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(0)
  })

  it('includes PR when approval is not required', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([]),
    })

    const repoConfig = makeRepoConfig({
      mergeQueue: {
        enabled: true,
        batchSize: 5,
        mergeMethod: 'merge',
        retryFlakyOnce: true,
        requireApproval: false,
        stagingBranchPrefix: 'orch/staging',
      },
    })

    const candidates = await findMergeEligiblePRs(db, forge, repoConfig)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.prNumber).toBe(100)
  })

  it('skips CI check when getPRCheckStatus is not implemented', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    const forge = makeForge({
      getPRCheckStatus: undefined,
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'human', state: 'approved', body: '', submittedAt: '' },
      ]),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(1)
  })

  it('continues to next PR when one throws during eligibility check', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r2', 'org/repo', 2, 'review_ready', 101)",
    ).run()

    let callCount = 0
    const forge = makeForge({
      getPRCheckStatus: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) throw new Error('forge API timeout')
        return Promise.resolve({ overall: 'success', checks: [] })
      }),
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'human', state: 'approved', body: '', submittedAt: '' },
      ]),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.prNumber).toBe(101)
  })

  it('only returns PRs for the specified repo', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/other-repo', 1, 'review_ready', 200)",
    ).run()
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r2', 'org/repo', 2, 'review_ready', 201)",
    ).run()

    const forge = makeForge({
      listPRReviews: vi.fn<() => Promise<ForgePRReview[]>>().mockResolvedValue([
        { id: 1, user: 'human', state: 'approved', body: '', submittedAt: '' },
      ]),
    })

    const candidates = await findMergeEligiblePRs(db, forge, makeRepoConfig())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.prNumber).toBe(201)
  })
})
