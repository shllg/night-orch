import { ConfigSchema, type Config, type RepoConfig } from '../../src/config/schema.js'
import type { CreateRunParams } from '../../src/state/runs.js'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

export function makeTestConfig(overrides: DeepPartial<Config> = {}): Config {
  return ConfigSchema.parse(deepMerge({
    version: 1,
    github: {
      tokenEnv: 'GITHUB_TOKEN',
      apiBaseUrl: 'https://api.github.com',
      pollIntervalSeconds: 300,
      appMentions: {},
    },
    storage: {
      dbPath: '',
      worktreeRoot: '/tmp/wt',
      logsRoot: '/tmp/logs',
    },
    notifications: {
      channels: [{ type: 'console' }],
      events: {
        onRunStarted: false,
        onBlocked: true,
        onPrReady: true,
        onPrUpdated: true,
        onError: true,
        onRetryExhausted: true,
      },
    },
    loop: {
      maxReviewIterations: 4,
      maxTotalAgentPasses: 10,
      stopOnPlannerFailure: true,
      requireVerificationPass: true,
      reviewApprovalKeyword: 'APPROVED',
      reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
      blockOnAmbiguousReview: true,
      maxAutoRetries: 3,
      decompose: false,
      maxSubtasks: 5,
      maxConcurrentSubtasks: 3,
    },
    security: {
      maxChangedFiles: 50,
      maxChangedLines: 5000,
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
    },
    cost: {
      model: 'pay-per-use',
    },
    workerProfiles: {},
    metrics: {
      enabled: false,
      port: 9090,
      host: '127.0.0.1',
    },
    observability: {
      agentStreaming: true,
      eventRetention: 1000,
      sessionLogs: false,
      sessionLogRetention: 7,
    },
    mcp: {
      enabled: true,
      transport: 'stdio',
      authTokenEnv: null,
      httpHost: '127.0.0.1',
      httpPort: 3100,
    },
    commentCommands: {
      enabled: true,
      requireCollaborator: false,
    },
    repos: [makeRawTestRepoConfig()],
    workflows: {},
  }, overrides))
}

export function makeTestRepoConfig(overrides: DeepPartial<RepoConfig> = {}): RepoConfig {
  return makeTestConfig({ repos: [deepMerge(makeRawTestRepoConfig(), overrides)] }).repos[0]!
}

export function makeRunInput(overrides: Partial<CreateRunParams> = {}): CreateRunParams {
  return {
    repo: 'org/repo',
    issueNumber: 1,
    issueNodeId: 'node1',
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
    ...overrides,
  }
}

function makeRawTestRepoConfig(): Record<string, unknown> {
  return {
    repo: 'org/repo',
    forge: 'github',
    linkedProjects: [],
    localPath: '/tmp/repo',
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
    defaults: {
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
      doneMode: 'pr-ready',
      notifyPriority: 'normal',
      prMentions: [],
    },
    planning: {
      prdDirectory: 'docs/prd',
    },
    selectors: {
      includeLabelsAny: ['no:ready'],
      excludeLabelsAny: ['no:blocked', 'no:error', 'no:needs-human'],
    },
    verify: [],
    agents: {},
    mergeQueue: {
      enabled: false,
      batchSize: 5,
      mergeMethod: 'merge',
      retryFlakyOnce: true,
      requireApproval: true,
      stagingBranchPrefix: 'orch/staging',
    },
  }
}

function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  if (Array.isArray(base) && Array.isArray(overrides)) {
    return overrides.map((overrideValue, index) => {
      const baseValue = base[index]
      return baseValue !== undefined && isPlainObject(baseValue) && isPlainObject(overrideValue)
        ? deepMerge(baseValue, overrideValue)
        : structuredClone(overrideValue)
    }) as T
  }

  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides === undefined ? structuredClone(base) : overrides as T
  }

  const merged: Record<string, unknown> = { ...base }
  for (const [key, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === undefined) continue
    const baseValue = (base as Record<string, unknown>)[key]
    merged[key] = canDeepMerge(baseValue, overrideValue)
      ? deepMerge(baseValue, overrideValue)
      : structuredClone(overrideValue)
  }
  return merged as T
}

function canDeepMerge(left: unknown, right: unknown): boolean {
  return (isPlainObject(left) && isPlainObject(right))
    || (Array.isArray(left) && Array.isArray(right))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
