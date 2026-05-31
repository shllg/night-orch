import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CleanupEngine } from '../../src/ops/cleanup.js'
import { initDatabase } from '../../src/state/db.js'
import type { Config } from '../../src/config/schema.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { execa } from 'execa'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockRemove = vi.fn().mockResolvedValue(undefined)
const mockList = vi.fn().mockResolvedValue([])

vi.mock('../../src/git/worktree.js', () => ({
  createWorktreeManager: () => ({
    list: mockList,
    ensure: vi.fn(),
    remove: mockRemove,
  }),
}))

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}))

function makeMockForge(prState: 'open' | 'closed' | 'merged'): ForgeAdapter {
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
    getPR: vi.fn().mockResolvedValue({
      number: 11,
      title: 'PR',
      body: '',
      state: prState,
      headBranch: 'orch/1-fix',
      headSha: 'sha-11',
      baseBranch: 'main',
      url: 'https://example.test/pr/11',
    }),
    getPRDiff: vi.fn(),
  }
}

function makeConfig(tmpDir: string): Config {
  const logsRoot = join(tmpDir, 'logs')
  mkdirSync(logsRoot, { recursive: true })
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: join(tmpDir, 'wt'), logsRoot },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [{
      repo: 'org/repo', forge: 'github', localPath: '/tmp/repo', baseBranch: 'main',
      branchPrefix: 'orch', labels: { ready: ['no:ready'], running: 'no:running', blocked: ['no:blocked'], reviewReady: 'no:review-ready', error: 'no:error', retry: 'no:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: [], selectors: { includeLabelsAny: [], excludeLabelsAny: [] }, agents: {},
    }],
  } as Config
}

function insertRun(db: Database.Database, overrides: Record<string, unknown> = {}): string {
  const id = `run-${Math.random().toString(36).slice(2, 8)}`
  const defaults = {
    id,
    repo: 'org/repo',
    issue_number: 1,
    issue_node_id: 'node1',
    status: 'completed',
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
    started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    ...overrides,
  }
  db.prepare(
    `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, planner, coder, reviewer, started_at, created_at, updated_at, ended_at, worktree_path, branch_name, pr_number)
     VALUES (@id, @repo, @issue_number, @issue_node_id, @status, @planner, @coder, @reviewer, @started_at, @created_at, @updated_at, @ended_at, @worktree_path, @branch_name, @pr_number)`,
  ).run({ worktree_path: null, branch_name: null, pr_number: null, ...defaults })
  return id
}

describe('CleanupEngine', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-cleanup-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completed run worktree → removed', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-1')
    insertRun(db, { worktree_path: wtPath })
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/1-fix', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run({ completedWorktrees: true })

    expect(result.removedWorktrees).toContain(wtPath)
    expect(mockRemove).toHaveBeenCalledWith(wtPath, false)
  })

  it('error run > 7 days → removed', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-2')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    insertRun(db, { status: 'error', worktree_path: wtPath, ended_at: eightDaysAgo })
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/2-fix', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run({ errorWorktreeAgeDays: 7 })

    expect(result.removedWorktrees).toContain(wtPath)
  })

  it('error run < 7 days → kept', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-3')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    insertRun(db, { status: 'error', worktree_path: wtPath, ended_at: twoDaysAgo })
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/3-fix', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run({ errorWorktreeAgeDays: 7 })

    expect(result.removedWorktrees).not.toContain(wtPath)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('active run worktree → kept', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-4')
    insertRun(db, { status: 'running', worktree_path: wtPath, ended_at: null })
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/4-fix', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run()

    expect(result.removedWorktrees).not.toContain(wtPath)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('orphaned worktree (no DB record) → removed by default', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-orphan')
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/orphan', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run()

    expect(result.removedWorktrees).toContain(wtPath)
    expect(mockRemove).toHaveBeenCalled()
  })

  it('orphaned worktree → not removed when orphanedWorktrees=false', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-orphan')
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/orphan', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run({ orphanedWorktrees: false })

    expect(result.removedWorktrees).not.toContain(wtPath)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('dry run → reports but does not remove', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-dry')
    insertRun(db, { worktree_path: wtPath })
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/1-fix', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run({ dryRun: true })

    expect(result.removedWorktrees).toContain(wtPath)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('cleans expired leases', async () => {
    // Insert an expired lease
    db.prepare("INSERT INTO leases (repo, issue_number, lease_owner, leased_until) VALUES ('org/repo', 99, 'test', datetime('now', '-1 hour'))").run()
    mockList.mockResolvedValue([])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config)
    const result = await engine.run()

    expect(result.expiredLeases).toBe(1)
  })

  it('archives old logs', async () => {
    const config = makeConfig(tmpDir)
    const oldLog = join(config.storage.logsRoot, 'old-run.log')
    writeFileSync(oldLog, 'old log data')
    // Backdate the file
    const { utimesSync } = await import('node:fs')
    const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    utimesSync(oldLog, oldTime, oldTime)

    mockList.mockResolvedValue([])
    const engine = new CleanupEngine(db, config)
    const result = await engine.run({ logArchiveAgeDays: 30 })

    expect(result.archivedLogs).toContain(oldLog)
  })

  it('deletes branch only when forge confirms merged PR', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-merge')
    insertRun(db, { worktree_path: wtPath, branch_name: 'orch/1-fix', pr_number: 11, status: 'completed' })
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/1-fix', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config, () => makeMockForge('merged'))
    const result = await engine.run({ mergedBranches: true })

    expect(result.removedBranches).toContain('orch/1-fix')
    expect(execa).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'orch/1-fix'],
      expect.objectContaining({ cwd: '/tmp/repo', extendEnv: false }),
    )
  })

  it('skips branch deletion when PR is closed but not merged', async () => {
    const wtPath = join(tmpDir, 'wt', 'org-repo-closed')
    insertRun(db, { worktree_path: wtPath, branch_name: 'orch/1-fix', pr_number: 11, status: 'completed' })
    mockList.mockResolvedValue([{ path: wtPath, branchName: 'orch/1-fix', exists: true, isClean: true }])

    const config = makeConfig(tmpDir)
    const engine = new CleanupEngine(db, config, () => makeMockForge('closed'))
    const result = await engine.run({ mergedBranches: true })

    expect(result.removedBranches).not.toContain('orch/1-fix')
    // execa may be called for `du -sk` (disk size estimation), but not for `git branch -D`
    const gitBranchCalls = (execa as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'git' && (call[1] as string[])?.[0] === 'branch',
    )
    expect(gitBranchCalls).toHaveLength(0)
  })
})
