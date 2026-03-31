import { describe, it, expect } from 'vitest'
import { resolveWorkflow, DEFAULT_WORKFLOW } from '../../src/loop/workflow.js'
import type { Config, RepoConfig } from '../../src/config/schema.js'

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: { ready: ['orch:ready'], running: 'orch:running', blocked: 'orch:blocked', needsHuman: 'orch:needs-human', reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
    defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
    verify: [],
    selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
    agents: {},
    labelConfig: {},
    ...overrides,
  } as RepoConfig
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '', logsRoot: '' },
    notifications: { channels: [{ type: 'console' }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true, maxAutoRetries: 3, decompose: false, maxSubtasks: 5, maxConcurrentSubtasks: 3 },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    repos: [],
    workflows: {},
    ...overrides,
  } as Config
}

describe('resolveWorkflow', () => {
  it('returns DEFAULT_WORKFLOW when no workflow configured', () => {
    const result = resolveWorkflow(makeRepoConfig(), makeConfig(), 'standard')
    expect(result).toBe(DEFAULT_WORKFLOW)
  })

  it('returns DEFAULT_WORKFLOW when named workflow not found', () => {
    const result = resolveWorkflow(
      makeRepoConfig({ workflow: 'nonexistent' }),
      makeConfig(),
      'standard',
    )
    expect(result).toBe(DEFAULT_WORKFLOW)
  })

  it('returns named workflow from config', () => {
    const customWorkflow = {
      steps: [
        { type: 'worker' as const, id: 'code', role: 'coder' },
        { type: 'verify' as const, id: 'verify' },
        { type: 'decide' as const, id: 'decide', onIterate: 'code' },
      ],
    }
    const result = resolveWorkflow(
      makeRepoConfig({ workflow: 'minimal' }),
      makeConfig({ workflows: { minimal: customWorkflow } }),
      'standard',
    )
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0]!.id).toBe('code')
  })
})

describe('DEFAULT_WORKFLOW', () => {
  it('has correct step order', () => {
    const ids = DEFAULT_WORKFLOW.steps.map((s) => s.id)
    expect(ids).toEqual(['plan', 'code', 'verify', 'review', 'decide'])
  })

  it('plan step skips for trivial', () => {
    const planStep = DEFAULT_WORKFLOW.steps[0]!
    expect(planStep.type).toBe('worker')
    if (planStep.type === 'worker') {
      expect(planStep.skipWhen).toBe('trivial')
    }
  })

  it('code step continues from plan', () => {
    const codeStep = DEFAULT_WORKFLOW.steps[1]!
    expect(codeStep.type).toBe('worker')
    if (codeStep.type === 'worker') {
      expect(codeStep.continueFrom).toBe('plan')
    }
  })

  it('decide step iterates back to code', () => {
    const decideStep = DEFAULT_WORKFLOW.steps[4]!
    expect(decideStep.type).toBe('decide')
    if (decideStep.type === 'decide') {
      expect(decideStep.onIterate).toBe('code')
    }
  })
})
