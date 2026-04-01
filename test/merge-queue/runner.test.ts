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
    labels: { ready: ['orch:ready'], running: 'orch:running', blocked: 'orch:blocked', needsHuman: 'orch:needs-human', reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry', mergeQueued: 'orch:merge-queued', merging: 'orch:merging', mergeFailed: 'orch:merge-failed' },
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
    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 100, ['orch:merge-failed'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 100, ['orch:merge-queued', 'orch:merging'])
  })
})
