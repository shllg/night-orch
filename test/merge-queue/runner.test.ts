import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { processMergeQueue } from '../../src/merge-queue/runner.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { RepoConfig } from '../../src/config/schema.js'
import { initDatabase } from '../../src/state/db.js'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: 'abc123', stderr: '' }),
}))

vi.mock('../../src/merge-queue/staging.js', () => ({
  buildStagingBranch: vi.fn().mockResolvedValue({
    stagingSha: 'staging-sha-123',
    merged: [1, 2],
    ejected: [],
    stagingBranch: 'orch/staging/123',
  }),
}))

vi.mock('../../src/merge-queue/finalize.js', () => ({
  finalizeMerge: vi.fn().mockResolvedValue(undefined),
}))

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(), getIssue: vi.fn(), addLabels: vi.fn(),
    removeLabels: vi.fn(), commentOnIssue: vi.fn(), validateAuth: vi.fn(),
    createPR: vi.fn(), updatePR: vi.fn(), findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(), listIssueComments: vi.fn(), updateComment: vi.fn(),
    listPRReviews: vi.fn().mockResolvedValue([{ id: 1, user: 'h', state: 'approved', body: '', submittedAt: '' }]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn(), closePR: vi.fn(),
    getPRCheckStatus: vi.fn().mockResolvedValue({ overall: 'success', checks: [] }),
    getRefCheckStatus: vi.fn().mockResolvedValue({ overall: 'success', checks: [] }),
    getPR: vi.fn().mockResolvedValue({ number: 1, headBranch: 'fix', headSha: 'sha-fix', baseBranch: 'main', title: '', body: '', state: 'open', url: '' }),
    ...overrides,
  } as unknown as ForgeAdapter
}

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo', forge: 'github', localPath: '/tmp/repo', baseBranch: 'main',
    branchPrefix: 'orch',
    labels: { ready: ['no:ready'], running: 'no:running', blocked: 'no:blocked', needsHuman: 'no:needs-human', reviewReady: 'no:review-ready', error: 'no:error', retry: 'no:retry', mergeQueued: 'no:merge-queued', merging: 'no:merging', mergeFailed: 'no:merge-failed' },
    defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
    verify: [], selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
    agents: {}, labelConfig: {},
    mergeQueue: { enabled: true, batchSize: 5, mergeMethod: 'merge', retryFlakyOnce: true, requireApproval: true, stagingBranchPrefix: 'orch/staging' },
    ...overrides,
  } as RepoConfig
}

describe('processMergeQueue', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'merge-runner-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does nothing when merge queue is disabled', async () => {
    const config = makeRepoConfig({ mergeQueue: { enabled: false, batchSize: 5, mergeMethod: 'merge', retryFlakyOnce: true, requireApproval: true, stagingBranchPrefix: 'orch/staging' } } as Partial<RepoConfig>)
    await processMergeQueue(db, makeForge(), config)
    // No errors, no batch created
  })

  it('forms new batch when eligible PRs exist', async () => {
    db.prepare("INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)").run()

    await processMergeQueue(db, makeForge(), makeRepoConfig())

    const batch = db.prepare("SELECT * FROM merge_batches WHERE repo = 'org/repo'").get() as Record<string, unknown> | undefined
    expect(batch).toBeDefined()
    expect(batch!['status']).toBe('testing')
  })

  it('skips when no eligible PRs', async () => {
    await processMergeQueue(db, makeForge(), makeRepoConfig())

    const batch = db.prepare("SELECT * FROM merge_batches WHERE repo = 'org/repo'").get()
    expect(batch).toBeUndefined()
  })

  it('does not mark batch passed when finalizeMerge throws', async () => {
    const { finalizeMerge } = await import('../../src/merge-queue/finalize.js')
    vi.mocked(finalizeMerge).mockRejectedValueOnce(new Error('push rejected'))

    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number, last_error) VALUES ('r1', 'org/repo', 1, 'review_ready', 100, 'stale publish error')",
    ).run()
    db.prepare(
      `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, staging_branch, staging_sha, pr_numbers, approved_shas, merged_pr_numbers, retry_count)
       VALUES ('b-finalize-fail', 'org/repo', 'main', 'abc', 'testing', 'orch/staging/x', 'ssha', '[100]', '["sha-100"]', '[100]', 0)`,
    ).run()

    await processMergeQueue(db, makeForge(), makeRepoConfig())

    // Batch should be failed (not passed); run should NOT be marked completed
    const row = db.prepare("SELECT status FROM merge_batches WHERE id = 'b-finalize-fail'").get() as { status: string }
    expect(row.status).toBe('failed')
    const runRow = db.prepare("SELECT status FROM runs WHERE id = 'r1'").get() as { status: string }
    expect(runRow.status).toBe('review_ready')
  })

  it('closes only merged PRs on finalize, not ejected ones', async () => {
    const { finalizeMerge } = await import('../../src/merge-queue/finalize.js')
    const finalizeSpy = vi.mocked(finalizeMerge).mockResolvedValue(undefined)

    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r2', 'org/repo', 2, 'review_ready', 101)",
    ).run()
    // batch has prNumbers=[100,101] but merged_pr_numbers=[100] (101 ejected)
    db.prepare(
      `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, staging_branch, staging_sha, pr_numbers, approved_shas, merged_pr_numbers, retry_count)
       VALUES ('b-eject', 'org/repo', 'main', 'abc', 'testing', 'orch/staging/x', 'ssha', '[100,101]', '["sha-100","sha-101"]', '[100]', 0)`,
    ).run()

    await processMergeQueue(db, makeForge(), makeRepoConfig())

    expect(finalizeSpy).toHaveBeenCalledTimes(1)
    // Finalize must be called with merged subset, not full prNumbers
    expect(finalizeSpy.mock.calls[0]![4]).toEqual([100])

    // Only the merged run should transition to completed; the ejected one stays review_ready
    const r1 = db.prepare("SELECT status, last_error FROM runs WHERE id = 'r1'").get() as { status: string; last_error: string | null }
    expect(r1.status).toBe('completed')
    expect(r1.last_error).toBeNull()
    const r2 = db.prepare("SELECT status FROM runs WHERE id = 'r2'").get() as { status: string }
    expect(r2.status).toBe('review_ready')
  })

  it('transitions merged runs out of review_ready on success', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()
    db.prepare(
      `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, staging_branch, staging_sha, pr_numbers, approved_shas, merged_pr_numbers, retry_count)
       VALUES ('b-ok', 'org/repo', 'main', 'abc', 'testing', 'orch/staging/x', 'ssha', '[100]', '["sha-100"]', '[100]', 0)`,
    ).run()

    await processMergeQueue(db, makeForge(), makeRepoConfig())

    const r1 = db.prepare("SELECT status FROM runs WHERE id = 'r1'").get() as { status: string }
    expect(r1.status).toBe('completed')
    const batchRow = db.prepare("SELECT status FROM merge_batches WHERE id = 'b-ok'").get() as { status: string }
    expect(batchRow.status).toBe('passed')
  })

  it('recovers stuck-building batch by marking failed', async () => {
    const staleIso = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    db.prepare(
      `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, pr_numbers, approved_shas, retry_count, updated_at)
       VALUES ('b-stuck', 'org/repo', 'main', 'abc', 'building', '[100]', '["sha-100"]', 0, ?)`,
    ).run(staleIso)

    await processMergeQueue(db, makeForge(), makeRepoConfig())

    const row = db.prepare("SELECT status FROM merge_batches WHERE id = 'b-stuck'").get() as { status: string }
    expect(row.status).toBe('failed')
  })

  it('marks batch failed when formNewBatch staging throws', async () => {
    const { buildStagingBranch } = await import('../../src/merge-queue/staging.js')
    vi.mocked(buildStagingBranch).mockRejectedValueOnce(new Error('git fetch failed'))

    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()

    await processMergeQueue(db, makeForge(), makeRepoConfig())

    const batch = db.prepare("SELECT status FROM merge_batches WHERE repo = 'org/repo'").get() as { status: string } | undefined
    expect(batch?.status).toBe('failed')
  })

  it('quarantines culprit PR when single-item batch fails CI', async () => {
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status, pr_number) VALUES ('r1', 'org/repo', 1, 'review_ready', 100)",
    ).run()
    db.prepare(
      `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, staging_branch, staging_sha, pr_numbers, approved_shas, retry_count)
       VALUES ('b1', 'org/repo', 'main', 'abc123', 'testing', 'orch/staging/123', 'staging-sha-123', '[100]', '["sha-100"]', 1)`,
    ).run()

    const forge = makeForge({
      getRefCheckStatus: vi.fn().mockResolvedValue({ overall: 'failure', checks: [] }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabels: vi.fn().mockResolvedValue(undefined),
    })

    await processMergeQueue(db, forge, makeRepoConfig())

    const row = db.prepare("SELECT status, block_reason FROM runs WHERE id = 'r1'").get() as { status: string; block_reason: string | null }
    expect(row.status).toBe('blocked')
    expect(row.block_reason).toBe('merge_conflict')
    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 100, ['no:merge-failed'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 100, ['no:merge-queued', 'no:merging'])
  })
})
