import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../../src/forge/types.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { queueContinue } from '../../src/ops/continue.js'
import { makeTestRepoConfig, makeRunInput } from '../helpers/factories.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 58,
      nodeId: 'node-58',
      title: 'Test',
      body: '',
      labels: ['no:blocked'],
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
    const run = runManager.create(makeRunInput({
      issueNumber: 58,
      issueNodeId: 'node-58',
    }))
    runManager.update(run.id, {
      status: 'blocked',
      currentPhase: 'review',
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

    const result = await queueContinue(db, forge, makeTestRepoConfig(), 58, '')

    expect(result.queued).toBe(true)
    const updated = runManager.getByRepoAndIssue('org/repo', 58)
    expect(updated?.status).toBe('queued')
    expect(updated?.currentPhase).toBe('review')
    expect(updated?.blockReason).toBeNull()
    expect(updated?.phaseData?.reactionType).toBe('continue')
    expect(updated?.phaseData?.reactionContext).toContain('PR has merge conflicts with base branch')
    expect(updated?.phaseData?.reactionContext).toContain('Please also fix the flaky timeout assertion.')
    expect(updated?.phaseData?.reactionContext).not.toContain('/orch continue')
  })

  it('queues error runs for a follow-up continue pass', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 59,
      issueNodeId: 'node-59',
    }))
    runManager.update(run.id, {
      status: 'error',
      endedAt: '2026-02-01T12:00:00Z',
      lastError: 'Worker crashed while parsing output',
    })

    const forge = makeForge()
    const result = await queueContinue(db, forge, makeTestRepoConfig(), 59, '')

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
    const run = runManager.create(makeRunInput({
      issueNumber: 62,
      issueNodeId: 'node-62',
    }))
    runManager.update(run.id, {
      status: 'completed',
      endedAt: '2026-02-01T12:00:00Z',
    })

    const forge = makeForge()
    const result = await queueContinue(db, forge, makeTestRepoConfig(), 62, '')

    expect(result.queued).toBe(false)
    expect(result.reason).toContain('blocked/review_ready/error')
    const unchanged = runManager.getByRepoAndIssue('org/repo', 62)
    expect(unchanged?.status).toBe('completed')
  })

  it('queues fallback continue context when no PR signals exist', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 60,
      issueNodeId: 'node-60',
    }))
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
        labels: ['no:blocked'],
        assignees: [],
        state: 'open',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        url: 'https://example.invalid/issues/60',
      }),
      listIssueComments: vi.fn().mockResolvedValue([]),
    })

    const result = await queueContinue(db, forge, makeTestRepoConfig(), 60, '')

    expect(result.queued).toBe(true)
    const updated = runManager.getByRepoAndIssue('org/repo', 60)
    expect(updated?.status).toBe('queued')
    expect(updated?.phaseData?.reactionType).toBe('continue')
    expect(updated?.phaseData?.reactionContext).toContain('No new CI failures')
  })

  it('derives resume phase from checkpoint artifacts when current phase is missing', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 63,
      issueNodeId: 'node-63',
    }))
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: '2026-02-01T12:00:00Z',
      phaseData: {
        issueRepo: 'org/repo',
        plan: {
          plan: { objective: 'Fix issue' },
        },
        code: {
          codeResult: { summary: 'done' },
        },
      },
    })

    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
    })

    const result = await queueContinue(db, forge, makeTestRepoConfig(), 63, '')

    expect(result.queued).toBe(true)
    const updated = runManager.getByRepoAndIssue('org/repo', 63)
    expect(updated?.status).toBe('queued')
    expect(updated?.currentPhase).toBe('code')
  })

  it('supports dry-run without mutating state or posting updates', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 61,
      issueNodeId: 'node-61',
    }))
    runManager.update(run.id, {
      status: 'blocked',
      endedAt: '2026-02-01T12:00:00Z',
      phaseData: {
        issueRepo: 'org/repo',
      },
    })

    const forge = makeForge()
    const result = await queueContinue(db, forge, makeTestRepoConfig(), 61, '', { dryRun: true })

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

  it('resets cost fields on continue', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 64,
      issueNodeId: 'node-64',
    }))
    runManager.update(run.id, {
      status: 'blocked',
      blockReason: 'cost_limit',
      endedAt: '2026-02-01T12:00:00Z',
      lastError: 'Per-run cost limit exceeded',
      estimatedCostUsd: 15.5,
      promptTokens: 1000,
      completionTokens: 500,
      cacheReadTokens: 100,
    })

    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
    })
    const result = await queueContinue(db, forge, makeTestRepoConfig(), 64, '')

    expect(result.queued).toBe(true)
    const updated = runManager.getByRepoAndIssue('org/repo', 64)
    expect(updated?.status).toBe('queued')
    expect(updated?.estimatedCostUsd).toBe(0)
    expect(updated?.promptTokens).toBe(0)
    expect(updated?.completionTokens).toBe(0)
    expect(updated?.cacheReadTokens).toBe(0)
  })

  it('persists strategy override and records a user action event', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 65,
      issueNodeId: 'node-65',
    }))
    runManager.update(run.id, {
      status: 'blocked',
      manualState: 'awaiting_rebase_resolution',
      endedAt: '2026-02-01T12:00:00Z',
      controlPayload: {
        issueRepo: 'org/repo',
        conflictSummary: 'Refresh against origin/main conflicted in src/app.ts',
        conflictSnapshot: {
          schemaVersion: 1,
          capturedAt: '2026-02-01T11:59:00Z',
          source: 'branch_refresh',
          kind: 'merge',
          strategy: 'merge',
          summary: 'Refresh against origin/main conflicted in src/app.ts',
          branchName: 'orch/65-test',
          baseBranch: 'main',
          branchHeadSha: 'branch-sha-1',
          baseHeadSha: 'base-sha-1',
          files: ['src/app.ts'],
          excerpts: [
            {
              path: 'src/app.ts',
              preview: '<<<<<<< ours',
              ours: 'const mode = "ours"',
              theirs: 'const mode = "theirs"',
            },
          ],
          resolution: {
            attempted: true,
            outcome: 'failed',
            summary: 'Resolver could not preserve both behaviors',
            files: ['src/app.ts'],
          },
        },
      },
    })

    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
    })
    const result = await queueContinue(db, forge, makeTestRepoConfig(), 65, '', {
      strategyOverride: 'merge',
      actor: 'web',
    })

    expect(result.queued).toBe(true)
    const updated = runManager.getByRepoAndIssue('org/repo', 65)
    expect(updated?.controlPayload?.updateStrategy).toBe('merge')
    expect(updated?.controlPayload?.preserveBranchState).toBe(false)
    expect(updated?.phaseData?.reactionType).toBe('rebase_conflict_resolution')
    expect(updated?.phaseData?.reactionSummary).toContain('branch refresh conflict resolution')
    expect(updated?.phaseData?.reactionContext).toContain('## Branch Refresh Conflict Analysis')
    expect(updated?.phaseData?.reactionContext).toContain('Refresh against origin/main conflicted in src/app.ts')
    expect(updated?.phaseData?.reactionConflictSnapshot).toMatchObject({
      source: 'branch_refresh',
      strategy: 'merge',
      branchName: 'orch/65-test',
      files: ['src/app.ts'],
    })

    const eventRow = db.prepare(
      `SELECT source, role, event_type, data
       FROM run_log_events
       WHERE run_id = ?`,
    ).get(updated?.id) as { source: string; role: string | null; event_type: string; data: string | null }
    expect(eventRow.source).toBe('user')
    expect(eventRow.role).toBe('web')
    expect(eventRow.event_type).toBe('user_action')
    expect(JSON.parse(eventRow.data ?? '{}')).toMatchObject({
      kind: 'continue',
      actor: 'web',
      strategy: 'merge',
    })
  })

  it('surfaces malformed rebase conflict payload fields in the continue context', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 66,
      issueNodeId: 'node-66',
    }))
    runManager.update(run.id, {
      status: 'blocked',
      manualState: 'awaiting_rebase_resolution',
      endedAt: '2026-02-01T12:00:00Z',
      controlPayload: {
        issueRepo: 'org/repo',
        conflictSummary: 'Refresh against origin/main conflicted',
        conflictFiles: ['src/app.ts'],
        conflictExcerpts: [
          { path: 42, preview: '<<<<<<< ours' },
          'not an excerpt',
        ],
      },
    })

    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
    })
    const result = await queueContinue(db, forge, makeTestRepoConfig(), 66, '')

    expect(result.queued).toBe(true)
    expect(result.reason).toContain('malformed control payload')
    const updated = runManager.getByRepoAndIssue('org/repo', 66)
    expect(updated?.phaseData?.reactionSummary).toContain('malformed control payload')
    expect(updated?.phaseData?.reactionContext).toContain('## Malformed Continue Control Payload')
    expect(updated?.phaseData?.reactionContext).toContain('conflictExcerpts')
    expect(updated?.phaseData?.reactionContext).toContain('expected entries with string path and preview')
  })

  it('surfaces stored control payload corruption when conflict files fail validation', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create(makeRunInput({
      issueNumber: 67,
      issueNodeId: 'node-67',
    }))
    runManager.update(run.id, {
      status: 'blocked',
      manualState: 'awaiting_rebase_resolution',
      endedAt: '2026-02-01T12:00:00Z',
      phaseData: {
        issueRepo: 'org/repo',
      },
    })
    db.prepare('UPDATE runs SET control_payload = ? WHERE id = ?')
      .run(JSON.stringify({
        issueRepo: 'org/repo',
        conflictSummary: 'Refresh against origin/main conflicted',
        conflictFiles: [42],
        conflictExcerpts: [],
      }), run.id)

    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([]),
    })
    const result = await queueContinue(db, forge, makeTestRepoConfig(), 67, '')

    expect(result.queued).toBe(true)
    expect(result.reason).toContain('malformed control payload')
    const updated = runManager.getByRepoAndIssue('org/repo', 67)
    expect(updated?.phaseData?.reactionContext).toContain('## Malformed Continue Control Payload')
    expect(updated?.phaseData?.reactionContext).toContain('control_payload: schema_error')
  })
})
