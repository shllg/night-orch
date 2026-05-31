import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Config, RepoConfig } from '../../src/config/schema.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import { validateProjectSetup } from '../../src/ops/project-check.js'

const {
  mockIsGitRepo,
  mockBranchExistsLocally,
  mockBranchExistsRemotely,
  mockFetchOrigin,
  mockCheckWorkerAuth,
} = vi.hoisted(() => ({
  mockIsGitRepo: vi.fn().mockResolvedValue(true),
  mockBranchExistsLocally: vi.fn().mockResolvedValue(true),
  mockBranchExistsRemotely: vi.fn().mockResolvedValue(true),
  mockFetchOrigin: vi.fn().mockResolvedValue(undefined),
  mockCheckWorkerAuth: vi.fn().mockResolvedValue({ authenticated: true, error: null, remediation: null }),
}))

vi.mock('../../src/git/repo.js', () => ({
  isGitRepo: (...args: unknown[]) => mockIsGitRepo(...args),
  branchExistsLocally: (...args: unknown[]) => mockBranchExistsLocally(...args),
  branchExistsRemotely: (...args: unknown[]) => mockBranchExistsRemotely(...args),
  fetchOrigin: (...args: unknown[]) => mockFetchOrigin(...args),
}))

vi.mock('../../src/workers/auth-check.js', () => ({
  checkWorkerAuth: (...args: unknown[]) => mockCheckWorkerAuth(...args),
}))

function makeForge(): ForgeAdapter {
  return {
    validateAuth: vi.fn().mockResolvedValue({ user: 'tester' }),
    getIssue: vi.fn().mockResolvedValue({}),
  } as unknown as ForgeAdapter
}

function makeConfig(localPath: string, workflowPromptPath: string): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '/tmp/db.sqlite', worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs', autoCleanup: { enabled: true, intervalMinutes: 60 }, retention: { worktreeAgeDays: 7, detailDays: 30, archiveDays: 90 } },
    notifications: { channels: [{ type: 'console' }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: {
      maxReviewIterations: 4,
      maxTotalAgentPasses: 10,
      stopOnPlannerFailure: true,
      requireVerificationPass: true,
      reviewApprovalKeyword: 'APPROVED',
      reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
      blockOnAmbiguousReview: true,
      maxAutoRetries: 3,
      maxEmptyDiffRetries: 2,
      maxConsecutiveBlocks: 4,
      decompose: false,
      maxSubtasks: 5,
      maxConcurrentSubtasks: 3,
    },
    fileLoop: {
      enabled: false,
      maxDurationMinutes: 480,
      maxIterations: 1000,
      minIntervalSecondsBetweenFiles: 5,
      perIterationTimeoutSeconds: 120,
      maxCostUsd: 5,
      maxFileLines: 1500,
      includeGlobs: ['**/*.{ts,tsx,js,jsx,py,go,rs,md}'],
      excludeGlobs: ['**/node_modules/**'],
      reviewerProfileKey: 'codex-default',
      branchNameTemplate: 'orch/file-loop/{repoSlug}/{yyyyMmDd}',
      loopMdPath: 'loop.md',
      commitPrefix: '[FILE-LOOP]',
      perEditVerify: { enabled: true, commands: ['pnpm typecheck'], timeoutSeconds: 60 },
      finalizeVerify: { enabled: true, commands: ['pnpm typecheck', 'pnpm lint'], timeoutSeconds: 300, onFailure: 'draft-pr' },
    },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    cost: { model: 'subscription', subscriptionMetered: { advisoryThresholdUsd: null, enforcePerRunLimit: false, enforceDailyLimit: false }, allowEstimatedDuration: false },
    ai: { internal: { provider: null, model: null, apiKeyEnv: null, timeoutMs: 30_000, maxTokens: 1024, features: { conflictResolver: true }, enable: { triage: false, reviewerParseFallback: false, prBody: false } } },
    autoResolveConflicts: { enabled: true, maxAttempts: 2, maxFiles: 5 },
    workerProfiles: {
      'codex-default': {
        type: 'codex',
        command: 'codex',
        args: ['exec', '--json'],
        workerTimeoutSeconds: 1800,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
      },
    },
    metrics: { enabled: true, port: 9090, host: '0.0.0.0' },
    observability: { agentStreaming: true, eventRetention: 1000, sessionLogs: true, sessionLogRetention: 7 },
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null, httpPort: 3100, httpHost: '127.0.0.1' },
    commentCommands: { enabled: true, requireCollaborator: true },
    workflows: {
      hardened: {
        steps: [
          { type: 'worker', id: 'security', role: 'reviewer', prompt: workflowPromptPath },
        ],
      },
    },
    repos: [
      {
        repo: 'org/repo',
        forge: 'github',
        linkedProjects: [],
        maxConcurrentRuns: 1,
        localPath,
        baseBranch: 'main',
        branchPrefix: 'orch',
        updateStrategy: 'merge',
        labels: {
          ready: ['no:ready'],
          running: 'no:running',
          blocked: 'no:blocked',
          needsHuman: 'no:needs-human',
          reviewReady: 'no:review-ready',
          error: 'no:error',
          retry: 'no:retry',
          planning: 'no:planning',
          mergeQueued: 'no:merge-queued',
          merging: 'no:merging',
          mergeFailed: 'no:merge-failed',
        },
        labelConfig: {},
        defaults: { planner: 'codex', coder: 'codex', reviewer: 'codex', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
        planning: { prdDirectory: 'docs/prd' },
        fileLoop: {},
        selectors: { includeLabelsAny: ['no:ready'], excludeLabelsAny: ['no:blocked', 'no:error', 'no:needs-human'] },
        agents: { codex: 'codex-default' },
        verify: [{ command: 'pnpm test', timeoutSeconds: 180 }],
        workflow: 'hardened',
        mergeQueue: { enabled: false, batchSize: 5, mergeMethod: 'merge', retryFlakyOnce: true, requireApproval: true, stagingBranchPrefix: 'orch/staging' },
      },
    ],
  }
}

describe('validateProjectSetup', () => {
  let tmp: string
  let repoPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmp = mkdtempSync(join(tmpdir(), 'night-orch-project-check-'))
    repoPath = join(tmp, 'repo')
    mkdirSync(repoPath, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('flags missing workflow prompt files', async () => {
    const config = makeConfig(repoPath, join(tmp, 'missing-security-prompt.md'))
    const repoConfig = config.repos[0] as RepoConfig

    const results = await validateProjectSetup(repoConfig, config, makeForge())
    const promptCheck = results.find((r) => r.name === 'Workflow prompt: security')

    expect(promptCheck).toBeDefined()
    expect(promptCheck?.passed).toBe(false)
  })

  it('checks worker auth for resolved project roles', async () => {
    const promptPath = join(tmp, 'security.md')
    writeFileSync(promptPath, '# prompt')
    mockCheckWorkerAuth.mockResolvedValueOnce({
      authenticated: false,
      error: 'session expired',
      remediation: 'Run `codex auth login` to re-authenticate.',
    })
    mockCheckWorkerAuth.mockResolvedValue({
      authenticated: true,
      error: null,
      remediation: null,
    })

    const config = makeConfig(repoPath, promptPath)
    const repoConfig = config.repos[0] as RepoConfig
    const results = await validateProjectSetup(repoConfig, config, makeForge())

    const authCheck = results.find((r) => r.name === 'Worker auth for planner (codex)')
    expect(authCheck).toBeDefined()
    expect(authCheck?.passed).toBe(false)
    expect(authCheck?.message).toContain('session expired')
  })
})
