import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createForgeAdapter } from '../../src/forge/factory.js'
import type { Config, RepoConfig } from '../../src/config/schema.js'

function makeGlobalConfig(): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '', logsRoot: '' },
    notifications: { channels: [{ type: 'console' }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null },
    repos: [],
  }
}

function makeForgejoRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'forgejo',
    apiBaseUrl: 'https://forgejo.example.com/api/v1',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
    defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
    selectors: { includeLabelsAny: ['orch:ready'], excludeLabelsAny: ['orch:error'] },
    verify: [],
    agents: {},
    ...overrides,
  } as RepoConfig
}

describe('createForgeAdapter', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env['FORGEJO_TOKEN']
    delete process.env['GITHUB_TOKEN']
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('uses FORGEJO_TOKEN fallback for forgejo repos', () => {
    process.env['FORGEJO_TOKEN'] = 'forgejo-secret'
    const adapter = createForgeAdapter(makeForgejoRepo(), makeGlobalConfig())
    expect(adapter).toBeDefined()
  })

  it('throws when FORGEJO_TOKEN fallback is missing', () => {
    expect(() => createForgeAdapter(makeForgejoRepo(), makeGlobalConfig())).toThrow('FORGEJO_TOKEN')
  })
})
