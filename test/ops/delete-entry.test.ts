import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import type { Config } from '../../src/config/schema.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { DeleteIssueEntryEngine } from '../../src/ops/delete-entry.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { mockRemove, mockRunGit, mockBranchExistsLocally } = vi.hoisted(() => ({
  mockRemove: vi.fn().mockResolvedValue(undefined),
  mockRunGit: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  mockBranchExistsLocally: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../src/git/worktree.js', () => ({
  createWorktreeManager: () => ({
    list: vi.fn(),
    ensure: vi.fn(),
    remove: mockRemove,
  }),
}))
vi.mock('../../src/git/process.js', () => ({
  runGit: mockRunGit,
}))
vi.mock('../../src/git/repo.js', () => ({
  branchExistsLocally: mockBranchExistsLocally,
}))

function makeConfig(tmpDir: string): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: join(tmpDir, 'wt'), logsRoot: join(tmpDir, 'logs') },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [{
      repo: 'org/repo',
      forge: 'github',
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: [],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: {},
    }],
  } as Config
}

describe('DeleteIssueEntryEngine', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    mockRunGit.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    mockBranchExistsLocally.mockResolvedValue(false)
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-delete-entry-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deletes issue-local state (runs, issues, links, leases, command tracking, events)', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 7,
      issueNodeId: 'node-7',
      issueTitle: 'Delete stale entry',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    const wtPath = join(tmpDir, 'wt', 'org__repo', '7')
    runManager.update(run.id, {
      status: 'blocked',
      worktreePath: wtPath,
      phaseData: { issueRepo: 'org/linked' },
    })

    db.prepare(
      `INSERT INTO issues (repo, issue_number, status, created_at, updated_at)
       VALUES (?, ?, 'queued', datetime('now'), datetime('now'))`,
    ).run('org/linked', 7)
    db.prepare(
      `INSERT INTO issue_links (repo, issue_number, branch_name, branch_slug)
       VALUES (?, ?, ?, ?)`,
    ).run('org/repo', 7, 'orch/7-delete-stale-entry', 'delete-stale-entry')
    db.prepare(
      `INSERT INTO leases (repo, issue_number, lease_owner, leased_until)
       VALUES (?, ?, ?, datetime('now', '+1 hour'))`,
    ).run('org/repo', 7, 'owner-a')
    db.prepare(
      `INSERT INTO leases (repo, issue_number, lease_owner, leased_until)
       VALUES (?, ?, ?, datetime('now', '+1 hour'))`,
    ).run('org/linked', 7, 'owner-b')
    db.prepare(
      `INSERT INTO command_tracking (repo, issue_number, comment_id, command)
       VALUES (?, ?, ?, ?)`,
    ).run('org/repo', 7, 101, 'retry:applied')
    db.prepare(
      `INSERT INTO command_tracking (repo, issue_number, comment_id, command)
       VALUES (?, ?, ?, ?)`,
    ).run('org/linked', 7, 102, 'retry:applied')
    db.prepare(
      `INSERT INTO events (run_id, repo, issue_number, event_type, phase, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(run.id, 'org/repo', 7, 'phase_started', 'plan', '{}')
    db.prepare(
      `INSERT INTO agent_events (run_id, phase, role, event_type, data, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(run.id, 'code', 'coder', 'text', '{"text":"hello"}')

    const engine = new DeleteIssueEntryEngine(db, makeConfig(tmpDir))
    const result = await engine.deleteEntry('org/repo', 7)

    expect(result.found).toBe(true)
    expect(result.runsDeleted).toBe(1)
    expect(result.issuesDeleted).toBe(2)
    expect(result.issueLinksDeleted).toBe(1)
    expect(result.leasesDeleted).toBe(2)
    expect(result.commandTrackingDeleted).toBe(2)
    expect(result.eventsDeleted).toBe(1)
    expect(result.agentEventsDeleted).toBe(1)
    expect(result.worktreesRemoved).toContain(wtPath)
    expect(result.worktreesFailed).toEqual([])
    expect(mockRemove).toHaveBeenCalledWith(wtPath, true)

    expect(db.prepare('SELECT 1 FROM runs WHERE repo = ? AND issue_number = ?').get('org/repo', 7)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM issues WHERE repo = ? AND issue_number = ?').get('org/repo', 7)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM issues WHERE repo = ? AND issue_number = ?').get('org/linked', 7)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM issue_links WHERE repo = ? AND issue_number = ?').get('org/repo', 7)).toBeUndefined()
  })

  it('supports dry-run without deleting data', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 8,
      issueNodeId: 'node-8',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'error',
      worktreePath: join(tmpDir, 'wt', 'org__repo', '8'),
    })

    const engine = new DeleteIssueEntryEngine(db, makeConfig(tmpDir))
    const result = await engine.deleteEntry('org/repo', 8, { dryRun: true })

    expect(result.found).toBe(true)
    expect(result.runsDeleted).toBe(1)
    expect(result.issuesDeleted).toBe(1)
    expect(mockRemove).not.toHaveBeenCalled()
    expect(db.prepare('SELECT 1 FROM runs WHERE id = ?').get(run.id)).toBeDefined()
  })

  it('rejects deleting a currently running run unless forced', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 9,
      issueNodeId: 'node-9',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, { status: 'running' })

    const engine = new DeleteIssueEntryEngine(db, makeConfig(tmpDir))
    await expect(engine.deleteEntry('org/repo', 9)).rejects.toThrow('currently running')

    const forced = await engine.deleteEntry('org/repo', 9, { force: true })
    expect(forced.runsDeleted).toBe(1)
  })

  it('returns found=false when no matching entry exists', async () => {
    const engine = new DeleteIssueEntryEngine(db, makeConfig(tmpDir))
    const result = await engine.deleteEntry('org/repo', 999)

    expect(result.found).toBe(false)
    expect(result.runsDeleted).toBe(0)
    expect(result.issuesDeleted).toBe(0)
    expect(result.issueLinksDeleted).toBe(0)
    expect(result.leasesDeleted).toBe(0)
  })

  it('blocks non-forced deletion when another repo has an active run sharing issueRepo state', async () => {
    const runManager = new RunManager(db)
    const runA = runManager.create({
      repo: 'org/repoA',
      issueNumber: 7,
      issueNodeId: 'node-a',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(runA.id, {
      status: 'blocked',
      phaseData: { issueRepo: 'org/linked' },
    })

    const runB = runManager.create({
      repo: 'org/repoB',
      issueNumber: 7,
      issueNodeId: 'node-b',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(runB.id, {
      status: 'running',
      phaseData: { issueRepo: 'org/linked' },
    })

    db.prepare(
      `INSERT INTO leases (repo, issue_number, lease_owner, leased_until)
       VALUES (?, ?, ?, datetime('now', '+1 hour'))`,
    ).run('org/linked', 7, 'owner-linked')

    const config = makeConfig(tmpDir)
    config.repos = [
      {
        ...config.repos[0]!,
        repo: 'org/repoA',
        localPath: '/tmp/repoA',
      },
      {
        ...config.repos[0]!,
        repo: 'org/repoB',
        localPath: '/tmp/repoB',
      },
    ]

    const engine = new DeleteIssueEntryEngine(db, config)
    await expect(engine.deleteEntry('org/repoA', 7)).rejects.toThrow('shared issue-scoped state is in use')

    const forced = await engine.deleteEntry('org/repoA', 7, { force: true })
    expect(forced.runsDeleted).toBe(1)
    expect(db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runA.id)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runB.id)).toBeDefined()
    expect(db.prepare('SELECT 1 FROM leases WHERE repo = ? AND issue_number = ?').get('org/linked', 7)).toBeDefined()
  })

  it('deletes derived deterministic branch on entry deletion', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 11,
      issueNodeId: 'node-11',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, { status: 'blocked' })

    db.prepare(
      `INSERT OR REPLACE INTO issue_links (repo, issue_number, branch_name, branch_slug)
       VALUES (?, ?, ?, ?)`,
    ).run('org/repo', 11, '', 'carry-over')

    mockBranchExistsLocally.mockResolvedValueOnce(true)

    const engine = new DeleteIssueEntryEngine(db, makeConfig(tmpDir))
    const result = await engine.deleteEntry('org/repo', 11)

    expect(result.runsDeleted).toBe(1)
    expect(mockBranchExistsLocally).toHaveBeenCalledWith('/tmp/repo', 'orch/11-carry-over')
    expect(mockRunGit).toHaveBeenCalledWith(['branch', '-D', 'orch/11-carry-over'], { cwd: '/tmp/repo' })
    expect(mockRunGit).toHaveBeenCalledWith(
      ['push', 'origin', '--delete', 'orch/11-carry-over'],
      { cwd: '/tmp/repo', reject: false },
    )
  })

  it('attempts remote branch deletion even when local branch is already gone', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 12,
      issueNodeId: 'node-12',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, { status: 'blocked' })

    db.prepare(
      `INSERT OR REPLACE INTO issue_links (repo, issue_number, branch_name, branch_slug)
       VALUES (?, ?, ?, ?)`,
    ).run('org/repo', 12, '', 'stale-remote')

    mockBranchExistsLocally.mockResolvedValueOnce(false)

    const engine = new DeleteIssueEntryEngine(db, makeConfig(tmpDir))
    const result = await engine.deleteEntry('org/repo', 12)

    expect(result.runsDeleted).toBe(1)
    expect(mockRunGit).not.toHaveBeenCalledWith(['branch', '-D', 'orch/12-stale-remote'], { cwd: '/tmp/repo' })
    expect(mockRunGit).toHaveBeenCalledWith(
      ['push', 'origin', '--delete', 'orch/12-stale-remote'],
      { cwd: '/tmp/repo', reject: false },
    )
  })
})
