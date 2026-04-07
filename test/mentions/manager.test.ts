import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PRMentionManager } from '../../src/mentions/manager.js'
import type { RunContext } from '../../src/loop/types.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { Config } from '../../src/config/schema.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: 'abc123def' }),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeMockForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
  }
}

function makeConfig(appMentions: Record<string, { enabled: boolean; commentTemplate: string }> = {}): Config {
  return {
    version: 1,
    github: {
      tokenEnv: 'GITHUB_TOKEN',
      apiBaseUrl: 'https://api.github.com',
      pollIntervalSeconds: 300,
      appMentions,
    },
    storage: { dbPath: '', worktreeRoot: '', logsRoot: '' },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [],
  } as Config
}

function makeCtx(labels: string[] = [], prMentions: string[] = []): RunContext {
  return {
    runId: 'run-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: 'Fix', body: '', labels, assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {
      repo: 'org/repo',
      forge: 'github',
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions },
      verify: [],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: {},
    } as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-fix',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'publish',
    terminalStatus: 'publish',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh' as const,
    blockReason: null,
    prReviewFeedback: null,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
  }
}

describe('PRMentionManager', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mention-mgr-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves mentions, posts comment, records in tracker', async () => {
    const forge = makeMockForge()
    const config = makeConfig({ codex: { enabled: true, commentTemplate: '@codex please review PR #{pr}' } })
    const manager = new PRMentionManager(db, forge, config)

    await manager.postMentions(makeCtx(['pr-mention:codex']), 10)

    expect(forge.commentOnIssue).toHaveBeenCalledWith('org/repo', 10, '@codex please review PR #10')
  })

  it('already posted → skipped', async () => {
    const forge = makeMockForge()
    const config = makeConfig()
    const manager = new PRMentionManager(db, forge, config)

    // First call posts
    await manager.postMentions(makeCtx(['pr-mention:codex']), 10)
    expect(forge.commentOnIssue).toHaveBeenCalledTimes(1)

    // Second call with same commit sha — skipped
    vi.clearAllMocks()
    await manager.postMentions(makeCtx(['pr-mention:codex']), 10)
    expect(forge.commentOnIssue).not.toHaveBeenCalled()
  })

  it('comment posting failure → logged, not thrown', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.commentOnIssue).mockRejectedValue(new Error('API error'))
    const config = makeConfig()
    const manager = new PRMentionManager(db, forge, config)

    await expect(manager.postMentions(makeCtx(['pr-mention:codex']), 10)).resolves.toBeUndefined()
  })

  it('no mentions resolved → no API calls', async () => {
    const forge = makeMockForge()
    const config = makeConfig()
    const manager = new PRMentionManager(db, forge, config)

    await manager.postMentions(makeCtx([]), 10)

    expect(forge.commentOnIssue).not.toHaveBeenCalled()
  })

  it('uses default template when no config', async () => {
    const forge = makeMockForge()
    const config = makeConfig()
    const manager = new PRMentionManager(db, forge, config)

    await manager.postMentions(makeCtx(['pr-mention:reviewer-bot']), 10)

    expect(forge.commentOnIssue).toHaveBeenCalledWith('org/repo', 10, '@reviewer-bot')
  })

  it('uses repo default prMentions', async () => {
    const forge = makeMockForge()
    const config = makeConfig()
    const manager = new PRMentionManager(db, forge, config)

    await manager.postMentions(makeCtx([], ['codex']), 10)

    expect(forge.commentOnIssue).toHaveBeenCalledTimes(1)
  })
})
