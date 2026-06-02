import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollOnce } from '../../src/runner/poller.js'
import { createOrchestrationCache } from '../../src/runner/orchestration-cache.js'
import { initDatabase } from '../../src/state/db.js'
import type { Config } from '../../src/config/schema.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { RunManager } from '../../src/state/runs.js'
import { makeTestConfig } from '../helpers/factories.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockDiscoverEligibleIssues = vi.fn().mockResolvedValue([])
const mockCommentOnIssue = vi.fn().mockResolvedValue(undefined)
const mockListIssueComments = vi.fn().mockResolvedValue([])
const mockIsCollaborator = vi.fn().mockResolvedValue(true)
const mockNotificationDispatch = vi.fn().mockResolvedValue({ sent: [] })
const mockAddLabels = vi.fn().mockResolvedValue(undefined)
const mockRemoveLabels = vi.fn().mockResolvedValue(undefined)
const mockCreatePR = vi.fn().mockResolvedValue({
  number: 101,
  title: 'Test PR',
  url: 'https://example.com/pr/101',
  state: 'open',
})
const mockUpdatePR = vi.fn().mockResolvedValue({
  number: 202,
  title: 'Existing PR',
  url: 'https://example.com/pr/202',
  state: 'open',
})
const mockFindPRByBranch = vi.fn().mockResolvedValue(null)
const mockPushBranch = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/discovery/discover.js', () => ({
  discoverEligibleIssues: async (...args: unknown[]) => {
    const repoConfig = args[0] as Config['repos'][number]
    const discovered = await mockDiscoverEligibleIssues(...args) as Array<Record<string, unknown>>
    return discovered.map((item) => ({
      issueRepo: repoConfig.repo,
      repoConfig,
      ...item,
    }))
  },
}))

vi.mock('../../src/forge/factory.js', () => ({
  createForgeAdapter: vi.fn().mockReturnValue({
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 1,
      nodeId: '',
      title: 'Test',
      body: '',
      labels: ['no:running'],
      assignees: [],
      state: 'open',
      createdAt: '',
      updatedAt: '',
      url: '',
    }),
    addLabels: (...args: unknown[]) => mockAddLabels(...args),
    removeLabels: (...args: unknown[]) => mockRemoveLabels(...args),
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
    listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
    isCollaborator: (...args: unknown[]) => mockIsCollaborator(...args),
    validateAuth: vi.fn(),
    createPR: (...args: unknown[]) => mockCreatePR(...args),
    updatePR: (...args: unknown[]) => mockUpdatePR(...args),
    findPRByBranch: (...args: unknown[]) => mockFindPRByBranch(...args),
    getPRDiff: vi.fn(),
  }),
}))

vi.mock('../../src/notify/factory.js', () => ({
  createChannels: vi.fn().mockReturnValue([]),
}))

vi.mock('../../src/notify/dispatcher.js', () => {
  class MockNotificationDispatcher {
    dispatch = (...args: unknown[]) => mockNotificationDispatch(...args)
  }
  return { NotificationDispatcher: MockNotificationDispatcher }
})

const mockExecuteLoop = vi.fn()
const mockExecutePostPublishSteps = vi.fn(async (input: { ctx: unknown }) => ({
  ctx: input.ctx,
  reactions: [],
}))
const mockFileLoopGetActiveSession = vi.fn().mockReturnValue(null)
const mockFileLoopTickRepo = vi.fn().mockResolvedValue(null)
vi.mock('../../src/loop/engine.js', () => ({
  executeLoop: (...args: unknown[]) => mockExecuteLoop(...args),
  executePostPublishSteps: (...args: unknown[]) => mockExecutePostPublishSteps(...args),
}))
vi.mock('../../src/fileloop/engine.js', () => ({
  FileLoopEngine: class MockFileLoopEngine {
    getActiveSession(...args: unknown[]) {
      return mockFileLoopGetActiveSession(...args)
    }
    tickRepo(...args: unknown[]) {
      return mockFileLoopTickRepo(...args)
    }
  },
}))

const mockExecuteRebase = vi.fn().mockResolvedValue({
  rebased: false,
  verifyPassed: true,
  conflict: false,
})
const mockQueueRebase = vi.fn().mockResolvedValue({
  queued: true,
  reason: 'queued',
})
vi.mock('../../src/ops/rebase-and-check.js', () => ({
  executeRebase: (...args: unknown[]) => mockExecuteRebase(...args),
  queueRebase: (...args: unknown[]) => mockQueueRebase(...args),
}))

vi.mock('../../src/publishing/push.js', () => ({
  MergeConflictError: class MergeConflictError extends Error {
    readonly code = 'MERGE_CONFLICT' as const
  },
  pushBranch: (...args: unknown[]) => mockPushBranch(...args),
}))

vi.mock('../../src/workers/factory.js', () => ({
  createWorkerAdapter: vi.fn().mockReturnValue({
    runTask: vi.fn(),
    checkAvailability: vi.fn(),
  }),
}))

vi.mock('../../src/git/worktree.js', () => ({
  createWorktreeManager: () => ({
    ensure: vi.fn().mockResolvedValue({ path: '/tmp/wt', branchName: 'orch/1-fix', exists: true, isClean: true }),
    remove: vi.fn(),
    list: vi.fn(),
  }),
}))

vi.mock('../../src/state/leases.js', () => {
  const actual = vi.importActual('../../src/state/leases.js')
  return actual
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function publishFinalCtx(ctx: unknown): Record<string, unknown> {
  return {
    ...(ctx as Record<string, unknown>),
    currentPhase: 'completed',
    terminalStatus: 'publish',
  }
}

function makeConfig(dbPath: string): Config {
  return makeTestConfig({
    storage: { dbPath, worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: { channels: [] },
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null },
    repos: [{
      maxConcurrentRuns: 1,
      verify: ['pnpm test'],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: { claude: 'claude' },
    }],
    workerProfiles: {
      claude: {
        type: 'claude',
        command: 'claude',
        args: ['-p'],
        workerTimeoutSeconds: 1800,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
      },
    },
  })
}

describe('pollOnce', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    mockExecutePostPublishSteps.mockImplementation(async (input: { ctx: unknown }) => ({
      ctx: input.ctx,
      reactions: [],
    }))
    mockFileLoopGetActiveSession.mockReturnValue(null)
    mockFileLoopTickRepo.mockResolvedValue(null)
    mockCreatePR.mockResolvedValue({
      number: 101,
      title: 'Test PR',
      url: 'https://example.com/pr/101',
      state: 'open',
    })
    mockUpdatePR.mockResolvedValue({
      number: 202,
      title: 'Existing PR',
      url: 'https://example.com/pr/202',
      state: 'open',
    })
    mockFindPRByBranch.mockResolvedValue(null)
    mockPushBranch.mockResolvedValue(undefined)
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-poller-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('no eligible issues → logs and returns zero', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.immediateFollowupRepos).toEqual([])
  })

  it('runs the file-loop hook on idle repos when a session is active', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockFileLoopGetActiveSession.mockReturnValue({
      id: 1,
      repo: 'org/repo',
      status: 'running',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(0)
    expect(mockFileLoopTickRepo).toHaveBeenCalledTimes(1)
    expect(mockFileLoopTickRepo.mock.calls[0]?.[0]).toMatchObject({ repo: 'org/repo' })
  })

  it('dry run logs discovered issues without processing', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, true)

    // Dry run doesn't process
    expect(result.processed).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('error in discovery → records repo error and continues', async () => {
    mockDiscoverEligibleIssues.mockRejectedValueOnce(new Error('API error'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)
    expect(result.processed).toBe(0)
    expect(result.errors).toBe(1)
  })

  it('returns PollResult shape', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result).toHaveProperty('processed')
    expect(result).toHaveProperty('errors')
    expect(result).toHaveProperty('immediateFollowupRepos')
    expect(typeof result.processed).toBe('number')
    expect(typeof result.errors).toBe('number')
    expect(Array.isArray(result.immediateFollowupRepos)).toBe(true)
  })

  it('trivial issues use lightweight workflow and fallback codex profile-by-type when agent mapping is missing', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Tiny fix', body: 'Fix typo', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'trivial', reason: 'Short body with trivial label' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.workerProfiles['codex-fast'] = {
      type: 'codex',
      command: 'codex',
      args: ['exec'],
      workerTimeoutSeconds: 1200,
      minimalEnv: true,
      runtimeWrapper: null,
      env: {},
    }
    config.repos[0]!.agents = { claude: 'claude' }

    const result = await pollOnce(config, db, false)

    expect(result.errors).toBe(0)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(1)
    const initialCtx = mockExecuteLoop.mock.calls[0]?.[0] as {
      roles: { coder: string }
      repoConfig: { agents: Record<string, string> }
    }
    const loopDeps = mockExecuteLoop.mock.calls[0]?.[1] as {
      workflow: { steps: Array<{ id: string }>; }
    }
    expect(initialCtx.roles.coder).toBe('codex')
    expect(initialCtx.repoConfig.agents['codex']).toBeUndefined()
    expect(loopDeps.workflow.steps.map((step) => step.id)).toEqual(['code', 'verify', 'decide'])
  })

  it('applies workflowByTriage role and agent overrides during run setup', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Tiny fix', body: 'Fix typo', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'trivial', reason: 'Short body with trivial label' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.workerProfiles['codex-fast'] = {
      type: 'codex',
      command: 'codex',
      args: ['exec'],
      workerTimeoutSeconds: 900,
      minimalEnv: true,
      runtimeWrapper: null,
      env: {},
    }
    config.workflows = {
      'fast-trivial': {
        roles: {
          coder: 'codex',
          reviewer: 'codex',
        },
        agents: {
          codex: 'codex-fast',
        },
        steps: [
          { type: 'worker', id: 'code', role: 'coder' },
          { type: 'verify', id: 'verify' },
          { type: 'decide', id: 'decide', onIterate: 'code', requireReview: false },
        ],
      },
    }
    config.repos[0]!.workflowByTriage = { trivial: 'fast-trivial' }

    const result = await pollOnce(config, db, false)

    expect(result.errors).toBe(0)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(1)
    const initialCtx = mockExecuteLoop.mock.calls[0]?.[0] as {
      roles: { coder: string; reviewer: string }
      repoConfig: { agents: Record<string, string> }
    }
    const loopDeps = mockExecuteLoop.mock.calls[0]?.[1] as {
      workflow: { agents?: Record<string, string>; roles?: Record<string, string>; steps: Array<{ id: string }> }
    }
    expect(initialCtx.roles.coder).toBe('codex')
    expect(initialCtx.roles.reviewer).toBe('codex')
    expect(initialCtx.repoConfig.agents['codex']).toBe('codex-fast')
    expect(loopDeps.workflow.agents?.['codex']).toBe('codex-fast')
    expect(loopDeps.workflow.roles?.['coder']).toBe('codex')
    expect(loopDeps.workflow.steps.map((step) => step.id)).toEqual(['code', 'verify', 'decide'])
  })

  it('uses terminalStatus for blocked runs even when currentPhase is publish', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
    expect(result.immediateFollowupRepos).toEqual(['org/repo'])
    expect(mockCreatePR).not.toHaveBeenCalled()

    const row = db.prepare('SELECT status FROM runs ORDER BY created_at DESC LIMIT 1').get() as { status: string }
    expect(row.status).toBe('blocked')
  })

  it('propagates blockReason into blocked labels and status comments', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'decision',
      terminalStatus: 'blocked',
      iteration: 2,
      estimatedCostUsd: 1.25,
      adjustedLimits: { maxReviewIterations: 4 },
      blockReason: 'reviewer_blocked',
      stepOutputs: { blockMessage: 'Reviewer blocked: needs human sign-off' },
      reviewResults: { review: { summary: 'needs human sign-off' } },
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    expect(mockAddLabels).toHaveBeenCalledWith('org/repo', 1, ['no:blocked', 'no:needs-human'])
    expect(mockRemoveLabels).toHaveBeenCalledWith('org/repo', 1, ['no:ready'])

    const statusComment = mockCommentOnIssue.mock.calls.find(
      (call) => typeof call[2] === 'string' && call[2].includes('Reviewer blocked: needs human sign-off'),
    )
    expect(statusComment).toBeDefined()

    const row = db
      .prepare('SELECT status, block_reason, last_error FROM runs ORDER BY created_at DESC LIMIT 1')
      .get() as { status: string; block_reason: string | null; last_error: string | null }
    expect(row.status).toBe('blocked')
    expect(row.block_reason).toBe('reviewer_blocked')
    expect(row.last_error).toContain('Reviewer blocked: needs human sign-off')
  })

  it('reuses existing queued run instead of creating a new run', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const runManager = new RunManager(db)
    const existing = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const rows = db.prepare('SELECT id FROM runs WHERE repo = ? AND issue_number = ?').all('org/repo', 1) as Array<{ id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(existing.id)
  })

  it('reuses existing blocked run when issue is rediscovered as ready', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 2, nodeId: '', title: 'Retry me', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const runManager = new RunManager(db)
    const existing = runManager.create({
      repo: 'org/repo',
      issueNumber: 2,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(existing.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'prior failure',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const rows = db.prepare('SELECT id FROM runs WHERE repo = ? AND issue_number = ?').all('org/repo', 2) as Array<{ id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(existing.id)
  })

  it('preserves queued run iteration_count when resuming execution', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 3, nodeId: '', title: 'Resume iteration', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementationOnce(async (ctx: { iteration: number }) => ({
      currentPhase: 'decision',
      terminalStatus: 'blocked',
      iteration: ctx.iteration,
      estimatedCostUsd: 0,
      adjustedLimits: { maxReviewIterations: 4 },
      blockReason: 'reviewer_blocked',
      stepOutputs: { blockMessage: 'Reviewer blocked: follow-up required' },
      reviewResults: {},
    }))

    const runManager = new RunManager(db)
    const existing = runManager.create({
      repo: 'org/repo',
      issueNumber: 3,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(existing.id, {
      status: 'queued',
      iterationCount: 4,
      currentPhase: 'code',
      phaseData: { code: { codeResult: { summary: 'partial' } } },
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const executeCtx = mockExecuteLoop.mock.calls[0]?.[0] as { iteration?: number } | undefined
    expect(executeCtx?.iteration).toBe(4)

    const row = db
      .prepare('SELECT status, iteration_count FROM runs WHERE id = ?')
      .get(existing.id) as { status: string; iteration_count: number | null }
    expect(row.status).toBe('blocked')
    expect(row.iteration_count).toBe(4)
  })

  it('denies /orch retry from non-collaborator when requireCollaborator=true', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockListIssueComments.mockResolvedValue([
      {
        id: 5001,
        body: '/orch retry',
        user: 'external-user',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ])
    mockIsCollaborator.mockResolvedValue(false)

    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.commentCommands = { enabled: true, requireCollaborator: true }
    await pollOnce(config, db, false)

    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string }
    expect(row.status).toBe('blocked')
    expect(mockIsCollaborator).toHaveBeenCalledWith('org/repo', 'external-user')

    const commandRow = db
      .prepare('SELECT command FROM command_tracking WHERE repo = ? AND issue_number = ? AND comment_id = ?')
      .get('org/repo', 1, 5001) as { command: string } | undefined
    expect(commandRow?.command).toBe('retry:denied')
  })

  it('applies /orch retry from collaborator when requireCollaborator=true', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockListIssueComments.mockResolvedValue([
      {
        id: 5002,
        body: '/orch retry',
        user: 'collaborator-user',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ])
    mockIsCollaborator.mockResolvedValue(true)

    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 2,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.commentCommands = { enabled: true, requireCollaborator: true }
    await pollOnce(config, db, false)

    // Post-R0c retry creates a new attempt; the previous row stays blocked
    // and frozen, and the new head is queued.
    const prev = db
      .prepare('SELECT status, terminated_at FROM runs WHERE id = ?')
      .get(run.id) as { status: string; terminated_at: string | null }
    expect(prev.status).toBe('blocked')
    expect(prev.terminated_at).not.toBeNull()

    const head = db
      .prepare(
        `SELECT status, previous_attempt_id FROM runs
         WHERE repo = ? AND issue_number = ?
         ORDER BY sequence_number DESC, created_at DESC
         LIMIT 1`,
      )
      .get('org/repo', 2) as { status: string; previous_attempt_id: string | null }
    expect(head.status).toBe('queued')
    expect(head.previous_attempt_id).toBe(run.id)

    expect(mockIsCollaborator).toHaveBeenCalledWith('org/repo', 'collaborator-user')

    const commandRow = db
      .prepare('SELECT command FROM command_tracking WHERE repo = ? AND issue_number = ? AND comment_id = ?')
      .get('org/repo', 2, 5002) as { command: string } | undefined
    expect(commandRow?.command).toBe('retry:applied')
  })

  it('continues scanning comment commands when one issue comment fetch returns 404', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockListIssueComments.mockImplementation(async (_repo: string, issueNumber: number) => {
      if (issueNumber === 1) {
        throw Object.assign(new Error('Not Found'), { status: 404 })
      }
      if (issueNumber === 2) {
        return [
          {
            id: 5003,
            body: '/orch retry',
            user: 'collaborator-user',
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ]
      }
      return []
    })

    const runManager = new RunManager(db)
    const staleRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(staleRun.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const retryRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 2,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(retryRun.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const staleRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(staleRun.id) as { status: string }
    expect(staleRow.status).toBe('blocked')

    // Post-R0c retry inserts a new attempt row; the previous one is frozen.
    const retryPrev = db
      .prepare('SELECT status, terminated_at FROM runs WHERE id = ?')
      .get(retryRun.id) as { status: string; terminated_at: string | null }
    expect(retryPrev.status).toBe('blocked')
    expect(retryPrev.terminated_at).not.toBeNull()

    const retryHead = db
      .prepare(
        `SELECT status, previous_attempt_id FROM runs
         WHERE repo = ? AND issue_number = ?
         ORDER BY sequence_number DESC, created_at DESC
         LIMIT 1`,
      )
      .get('org/repo', 2) as { status: string; previous_attempt_id: string | null }
    expect(retryHead.status).toBe('queued')
    expect(retryHead.previous_attempt_id).toBe(retryRun.id)

    expect(mockListIssueComments).toHaveBeenCalledWith('org/repo', 1)
    expect(mockListIssueComments).toHaveBeenCalledWith('org/repo', 2)

    const commandRow = db
      .prepare('SELECT command FROM command_tracking WHERE repo = ? AND issue_number = ? AND comment_id = ?')
      .get('org/repo', 2, 5003) as { command: string } | undefined
    expect(commandRow?.command).toBe('retry:applied')
  })

  it('memoizes missing issues after 404 and skips repeated comment scans', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([])
    mockListIssueComments.mockImplementation(async (_repo: string, issueNumber: number) => {
      if (issueNumber === 4040) {
        throw Object.assign(new Error('Not Found'), { status: 404 })
      }
      return []
    })

    const runManager = new RunManager(db)
    const staleRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 4040,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(staleRun.id, {
      status: 'blocked',
      endedAt: new Date().toISOString(),
      lastError: 'failed verify',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const cache = createOrchestrationCache()
    await pollOnce(config, db, false, undefined, undefined, cache)
    await pollOnce(config, db, false, undefined, undefined, cache)

    const callsForIssue = mockListIssueComments.mock.calls.filter((call) => call[1] === 4040)
    expect(callsForIssue).toHaveLength(1)
  })

  it('returns error when publish fails', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementation(async (ctx) => publishFinalCtx(ctx))
    mockPushBranch.mockRejectedValueOnce(new Error('publish failed'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(1)
    expect(result.immediateFollowupRepos).toEqual(['org/repo'])
    const row = db.prepare('SELECT status FROM runs ORDER BY created_at DESC LIMIT 1').get() as { status: string }
    expect(row.status).toBe('error')
  })

  it('marks publish success as immediate follow-up eligible', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementation(async (ctx) => publishFinalCtx(ctx))
    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
    expect(result.immediateFollowupRepos).toEqual(['org/repo'])
    const row = db.prepare('SELECT status FROM runs ORDER BY created_at DESC LIMIT 1').get() as { status: string }
    expect(row.status).toBe('review_ready')
  })

  it('emits pr_updated notification when publish updates an existing PR', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 2, nodeId: '', title: 'Existing PR update', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: 'https://example.com/issues/2' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementation(async (ctx) => publishFinalCtx(ctx))
    mockFindPRByBranch.mockResolvedValueOnce({
      number: 202,
      title: 'Existing PR',
      url: 'https://example.com/pr/202',
      state: 'open',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const payloads = mockNotificationDispatch.mock.calls
      .map((call) => call[0] as { event?: string; prUrl?: string | null })
    const updatedPayload = payloads.find((payload) => payload.event === 'pr_updated')
    expect(updatedPayload).toBeDefined()
    expect(updatedPayload?.prUrl).toBe('https://example.com/pr/202')
  })

  it('posts a structured auto-retry status comment when publish fails and retries remain', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementation(async (ctx) => publishFinalCtx(ctx))
    mockPushBranch.mockRejectedValueOnce(new Error('publish failed'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    const statusComment = mockCommentOnIssue.mock.calls.find(
      (call) => typeof call[2] === 'string' && call[2].includes('**Status:** Error') && call[2].includes('Automatic retry queued'),
    )
    expect(statusComment).toBeDefined()
    expect(statusComment?.[0]).toBe('org/repo')
    expect(statusComment?.[1]).toBe(1)
    expect(statusComment?.[2]).toContain('Publish failed. Last error: publish failed')
  })

  it('posts a structured retry-exhausted status comment when publish retries are exhausted', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementation(async (ctx) => publishFinalCtx(ctx))
    mockPushBranch.mockRejectedValueOnce(new Error('publish failed'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.loop.maxAutoRetries = 0
    await pollOnce(config, db, false)

    const statusComment = mockCommentOnIssue.mock.calls.find(
      (call) => typeof call[2] === 'string' && call[2].includes('Failed after 1 attempts. Last error: publish failed'),
    )
    expect(statusComment).toBeDefined()
    expect(statusComment?.[2]).toContain('**Status:** Error')
    expect(statusComment?.[2]).toContain('Inspect the failure')
  })

  it('sanitizes error content before posting status comments', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementation(async (ctx) => publishFinalCtx(ctx))
    mockPushBranch.mockRejectedValueOnce(new Error('token=ghp_abcdefghijklmnopqrstuvwxyz123456\n@maintainer *boom*'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.loop.maxAutoRetries = 0
    await pollOnce(config, db, false)

    const statusComment = mockCommentOnIssue.mock.calls.find(
      (call) => typeof call[2] === 'string' && call[2].includes('**Status:** Error'),
    )
    expect(statusComment).toBeDefined()
    const body = statusComment?.[2] as string
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456')
    expect(body).toContain('token=\\[REDACTED\\]')
    expect(body).not.toContain('@maintainer')
    expect(body).toContain(`@\u200Bmaintainer`)
    expect(body).not.toContain('*boom*')
    expect(body).toContain('\\*boom\\*')
  })

  it('sanitizes retry_exhausted notification summaries', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockExecuteLoop.mockImplementation(async (ctx) => publishFinalCtx(ctx))
    mockPushBranch.mockRejectedValueOnce(new Error('token=ghp_abcdefghijklmnopqrstuvwxyz123456\n@maintainer *boom*'))

    const config = makeConfig(join(tmpDir, 'test.db'))
    config.loop.maxAutoRetries = 0
    await pollOnce(config, db, false)

    const retryExhaustedPayload = mockNotificationDispatch.mock.calls
      .map((call) => call[0] as { event: string; summary: string })
      .find((payload) => payload.event === 'retry_exhausted')

    expect(retryExhaustedPayload).toBeDefined()
    expect(retryExhaustedPayload?.summary).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456')
    expect(retryExhaustedPayload?.summary).toContain('token=\\[REDACTED\\]')
    expect(retryExhaustedPayload?.summary).not.toContain('@maintainer')
    expect(retryExhaustedPayload?.summary).toContain(`@\u200Bmaintainer`)
    expect(retryExhaustedPayload?.summary).not.toContain('*boom*')
    expect(retryExhaustedPayload?.summary).toContain('\\*boom\\*')
  })

  it('posts a night-orch plan summary comment through the loop onPlanReady hook', async () => {
    const callOrder: string[] = []
    mockDiscoverEligibleIssues.mockResolvedValue([{
      issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
      triage: { level: 'standard', reason: '' },
    }])
    mockCommentOnIssue.mockImplementation(async () => {
      callOrder.push('comment')
    })
    mockExecuteLoop.mockImplementationOnce(async (initialCtx: Record<string, unknown>, deps: { onPlanReady?: (ctx: Record<string, unknown>) => Promise<void> }) => {
      callOrder.push('executeLoop')
      expect(typeof deps.onPlanReady).toBe('function')
      await deps.onPlanReady?.({
        ...initialCtx,
        plan: {
          objective: 'Ship the requested issue change',
          assumptions: [],
          filesToChange: ['src/loop/engine.ts'],
          steps: [{ order: 1, description: 'Wire plan summary hook', files: ['src/loop/engine.ts'] }],
          risks: [],
          testStrategy: 'Run test suite',
        },
      })
      callOrder.push('afterOnPlanReady')
      return {
        currentPhase: 'publish',
        terminalStatus: 'blocked',
      }
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    await pollOnce(config, db, false)

    expect(mockCommentOnIssue).toHaveBeenCalled()
    const planCommentCall = mockCommentOnIssue.mock.calls.find(
      (call) => typeof call[2] === 'string' && call[2].includes('[night-orch] Plan Summary'),
    )
    expect(planCommentCall).toBeDefined()
    expect(planCommentCall?.[0]).toBe('org/repo')
    expect(planCommentCall?.[1]).toBe(1)
    const planCommentBody = planCommentCall?.[2]
    expect(typeof planCommentBody).toBe('string')
    expect(planCommentBody).toContain('**Automated comment** posted by **night-orch**')
    expect(callOrder).toEqual(['executeLoop', 'comment', 'afterOnPlanReady'])
  })

  it('processes the next eligible issue in the same poll cycle', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 1, nodeId: '', title: 'First', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 2, nodeId: '', title: 'Second', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(2)

    const firstCallCtx = mockExecuteLoop.mock.calls[0]?.[0] as { issueNumber: number }
    const secondCallCtx = mockExecuteLoop.mock.calls[1]?.[0] as { issueNumber: number }
    expect(firstCallCtx.issueNumber).toBe(1)
    expect(secondCallCtx.issueNumber).toBe(2)

    const runs = db
      .prepare('SELECT issue_number, status FROM runs ORDER BY created_at')
      .all() as Array<{ issue_number: number; status: string }>
    expect(runs).toEqual([
      { issue_number: 1, status: 'blocked' },
      { issue_number: 2, status: 'blocked' },
    ])
  })

  it('prioritizes queued merge-conflict follow-ups before fresh ready issues', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 41, nodeId: '', title: 'Fresh', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 13, nodeId: '', title: 'Follow-up', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const runManager = new RunManager(db)
    const existing = runManager.create({
      repo: 'org/repo',
      issueNumber: 13,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(existing.id, {
      status: 'queued',
      phaseData: {
        reactionType: 'merge_conflict',
      },
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(mockExecuteRebase).toHaveBeenCalledTimes(1)
    const rebaseIssueNumber = mockExecuteRebase.mock.calls[0]?.[5] as number | undefined
    expect(rebaseIssueNumber).toBe(13)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(1)
    const loopCtx = mockExecuteLoop.mock.calls[0]?.[0] as { issueNumber: number }
    expect(loopCtx.issueNumber).toBe(41)
  })

  it('posts a blocked status comment when branch refresh conflicts', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 13, nodeId: '', title: 'Follow-up', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])
    mockExecuteRebase.mockResolvedValueOnce({
      rebased: false,
      verifyPassed: false,
      conflict: true,
    })

    const runManager = new RunManager(db)
    const existing = runManager.create({
      repo: 'org/repo',
      issueNumber: 13,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(existing.id, {
      status: 'queued',
      phaseData: {
        reactionType: 'merge_conflict',
      },
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(1)
    expect(mockExecuteLoop).not.toHaveBeenCalled()

    const statusComment = mockCommentOnIssue.mock.calls.find(
      (call) => typeof call[2] === 'string' && call[2].includes('Branch refresh failed due to merge conflicts'),
    )
    expect(statusComment).toBeDefined()
    expect(statusComment?.[2]).toContain('Use /orch continue')
    expect(statusComment?.[2]).toContain('Use /orch continue to keep the existing branch')

    const run = db
      .prepare('SELECT status, block_reason FROM runs WHERE id = ?')
      .get(existing.id) as { status: string; block_reason: string | null }
    expect(run.status).toBe('blocked')
    expect(run.block_reason).toBe('merge_conflict')
  })

  it('does not enter the coder loop when executeRebase returns an error', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 13, nodeId: '', title: 'Follow-up', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])
    mockExecuteRebase.mockResolvedValueOnce({
      rebased: false,
      verifyPassed: false,
      conflict: false,
      error: 'push failed',
    })

    const runManager = new RunManager(db)
    const existing = runManager.create({
      repo: 'org/repo',
      issueNumber: 13,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(existing.id, {
      status: 'queued',
      phaseData: {
        reactionType: 'merge_conflict',
      },
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false)

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(1)
    expect(mockExecuteLoop).not.toHaveBeenCalled()

    const run = db
      .prepare('SELECT status, last_error FROM runs WHERE id = ?')
      .get(existing.id) as { status: string; last_error: string | null }
    expect(run.status).toBe('error')
    expect(run.last_error).toBe('push failed')
  })

  it('processes one issue per repo in parallel by default', async () => {
    const config = makeConfig(join(tmpDir, 'test.db'))
    config.repos = [
      {
        ...config.repos[0]!,
        repo: 'org/repo-a',
        localPath: '/tmp/repo-a',
      },
      {
        ...config.repos[0]!,
        repo: 'org/repo-b',
        localPath: '/tmp/repo-b',
      },
    ]

    mockDiscoverEligibleIssues.mockImplementation(async (repoConfig: { repo: string }) => {
      if (repoConfig.repo === 'org/repo-a') {
        return [{
          issue: { number: 1, nodeId: '', title: 'A', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
          triage: { level: 'standard', reason: '' },
        }]
      }
      return [{
        issue: { number: 2, nodeId: '', title: 'B', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      }]
    })

    const issue1Gate = deferred<void>()
    const issue2Gate = deferred<void>()
    const bothIssuesStarted = deferred<void>()
    mockExecuteLoop.mockImplementation(async (ctx: { issueNumber: number }) => {
      if (mockExecuteLoop.mock.calls.length === 2) {
        bothIssuesStarted.resolve()
      }
      if (ctx.issueNumber === 1) {
        await issue1Gate.promise
      } else if (ctx.issueNumber === 2) {
        await issue2Gate.promise
      }
      return {
        currentPhase: 'publish',
        terminalStatus: 'blocked',
      }
    })

    const pollPromise = pollOnce(config, db, false)
    await bothIssuesStarted.promise

    issue1Gate.resolve()
    issue2Gate.resolve()

    const result = await pollPromise
    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(2)

    const reposStarted = new Set(
      mockExecuteLoop.mock.calls.map((call) => (call[0] as { repo: string }).repo),
    )
    expect(reposStarted).toEqual(new Set(['org/repo-a', 'org/repo-b']))
  })

  it('continues processing healthy repos when one repo discovery fails', async () => {
    const config = makeConfig(join(tmpDir, 'test.db'))
    config.repos = [
      {
        ...config.repos[0]!,
        repo: 'org/repo-a',
        localPath: '/tmp/repo-a',
      },
      {
        ...config.repos[0]!,
        repo: 'org/repo-b',
        localPath: '/tmp/repo-b',
      },
    ]

    mockDiscoverEligibleIssues.mockImplementation(async (repoConfig: { repo: string }) => {
      if (repoConfig.repo === 'org/repo-a') {
        throw new Error('repo-a unavailable')
      }
      return [{
        issue: { number: 2, nodeId: '', title: 'B', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      }]
    })
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const result = await pollOnce(config, db, false)
    expect(result.processed).toBe(1)
    expect(result.errors).toBe(1)
    expect(mockExecuteLoop).toHaveBeenCalledTimes(1)
    const run = db
      .prepare('SELECT repo, issue_number, status FROM runs ORDER BY created_at DESC LIMIT 1')
      .get() as { repo: string; issue_number: number; status: string }
    expect(run.repo).toBe('org/repo-b')
    expect(run.issue_number).toBe(2)
    expect(run.status).toBe('blocked')
  })

  it('respects repos[].maxConcurrentRuns for per-repo parallelism', async () => {
    const config = makeConfig(join(tmpDir, 'test.db'))
    config.repos[0]!.maxConcurrentRuns = 2

    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 1, nodeId: '', title: 'First', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 2, nodeId: '', title: 'Second', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 3, nodeId: '', title: 'Third', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])

    const gate1 = deferred<void>()
    const gate2 = deferred<void>()
    const gate3 = deferred<void>()
    const firstWaveStarted = deferred<void>()
    const thirdStarted = deferred<void>()
    mockExecuteLoop.mockImplementation(async (ctx: { issueNumber: number }) => {
      if (mockExecuteLoop.mock.calls.length === 2) {
        firstWaveStarted.resolve()
      }
      if (ctx.issueNumber === 3) {
        thirdStarted.resolve()
      }
      if (ctx.issueNumber === 1) await gate1.promise
      if (ctx.issueNumber === 2) await gate2.promise
      if (ctx.issueNumber === 3) await gate3.promise
      return {
        currentPhase: 'publish',
        terminalStatus: 'blocked',
      }
    })

    const pollPromise = pollOnce(config, db, false)

    await firstWaveStarted.promise
    const firstWaveIssues = mockExecuteLoop.mock.calls
      .slice(0, 2)
      .map((call) => (call[0] as { issueNumber: number }).issueNumber)
    expect(firstWaveIssues.sort((a, b) => a - b)).toEqual([1, 2])

    await Promise.resolve()
    expect(mockExecuteLoop).toHaveBeenCalledTimes(2)

    gate1.resolve()
    await thirdStarted.promise

    gate2.resolve()
    gate3.resolve()

    const result = await pollPromise
    expect(result.processed).toBe(3)
    expect(result.errors).toBe(0)
  })

  it('processes only the targeted issue when targetIssue is provided', async () => {
    mockDiscoverEligibleIssues.mockResolvedValue([
      {
        issue: { number: 1, nodeId: '', title: 'First', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
      {
        issue: { number: 2, nodeId: '', title: 'Second', body: '', labels: ['no:ready'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
        triage: { level: 'standard', reason: '' },
      },
    ])
    mockExecuteLoop.mockResolvedValue({
      currentPhase: 'publish',
      terminalStatus: 'blocked',
    })

    const config = makeConfig(join(tmpDir, 'test.db'))
    const result = await pollOnce(config, db, false, undefined, { repo: 'org/repo', issueNumber: 2 })

    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
    const run = db
      .prepare('SELECT issue_number FROM runs ORDER BY created_at DESC LIMIT 1')
      .get() as { issue_number: number }
    expect(run.issue_number).toBe(2)
  })
})
