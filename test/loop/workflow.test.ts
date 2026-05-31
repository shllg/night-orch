import { describe, it, expect } from 'vitest'
import {
  resolveWorkflow,
  DEFAULT_WORKFLOW,
  LIGHTWEIGHT_WORKFLOW,
  PLANNING_ONLY_WORKFLOW,
} from '../../src/loop/workflow.js'
import type { Config, RepoConfig } from '../../src/config/schema.js'

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: { ready: ['no:ready'], running: 'no:running', blocked: 'no:blocked', needsHuman: 'no:needs-human', reviewReady: 'no:review-ready', error: 'no:error', retry: 'no:retry', planning: 'no:planning' },
    defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
    planning: { prdDirectory: 'docs/prd' },
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
    notifications: { channels: [{ type: 'console' }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
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
  it('returns DEFAULT_WORKFLOW for standard issues when no workflow configured', () => {
    const result = resolveWorkflow(makeRepoConfig(), makeConfig(), [], 'standard')
    expect(result).toBe(DEFAULT_WORKFLOW)
  })

  it('returns LIGHTWEIGHT_WORKFLOW for trivial issues when no workflow configured', () => {
    const result = resolveWorkflow(makeRepoConfig(), makeConfig(), [], 'trivial')
    expect(result).toBe(LIGHTWEIGHT_WORKFLOW)
  })

  it('returns DEFAULT_WORKFLOW when named workflow not found', () => {
    const result = resolveWorkflow(
      makeRepoConfig({ workflow: 'nonexistent' }),
      makeConfig(),
      [],
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
      [],
      'standard',
    )
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0]!.id).toBe('code')
  })

  it('resolves DAG workflows into executable step order', () => {
    const dagWorkflow = {
      dag: {
        entry: 'code',
        stages: {
          code: { type: 'worker' as const, role: 'coder', next: 'smoke' },
          smoke: { type: 'verify' as const, next: 'decide' },
          decide: { type: 'decide' as const, onIterate: 'code', requireReview: false },
        },
      },
      roles: { coder: 'codex' as const },
      agents: { codex: 'codex-fast' },
    }
    const result = resolveWorkflow(
      makeRepoConfig({ workflow: 'dag-minimal' }),
      makeConfig({ workflows: { 'dag-minimal': dagWorkflow as Config['workflows'][string] } }),
      [],
      'standard',
    )

    expect(result.steps.map((step) => step.id)).toEqual(['code', 'smoke', 'decide'])
    expect(result.steps[1]).toMatchObject({ type: 'verify', id: 'smoke' })
    expect(result.roles?.coder).toBe('codex')
    expect(result.agents?.['codex']).toBe('codex-fast')
  })

  it('returns triage-mapped workflow when configured', () => {
    const fastWorkflow = {
      steps: [
        { type: 'worker' as const, id: 'code', role: 'coder' },
        { type: 'decide' as const, id: 'decide', onIterate: 'code', requireReview: false },
      ],
      roles: { coder: 'codex' as const },
      agents: { codex: 'codex-fast' },
    }
    const result = resolveWorkflow(
      makeRepoConfig({ workflowByTriage: { trivial: 'fast-trivial' } }),
      makeConfig({ workflows: { 'fast-trivial': fastWorkflow } }),
      [],
      'trivial',
    )
    expect(result.steps).toHaveLength(2)
    expect(result.roles?.coder).toBe('codex')
    expect(result.agents?.['codex']).toBe('codex-fast')
  })

  it('returns PLANNING_ONLY_WORKFLOW when planning label is present', () => {
    const result = resolveWorkflow(
      makeRepoConfig({ workflow: 'minimal' }),
      makeConfig(),
      ['no:planning'],
      'standard',
    )
    expect(result).toBe(PLANNING_ONLY_WORKFLOW)
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
