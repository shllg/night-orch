export type RunStatus = 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed'
export type DashboardPage = 'issues' | 'stats' | 'projects' | 'settings'

export interface RunListResult {
  count: number
  runs: RunSummary[]
}

export interface RunSummary {
  runId: string
  hasRun: boolean
  repo: string
  issue: number
  issueTitle: string | null
  status: RunStatus
  prNumber: number | null
  phase: string | null
  iterations: number
  costUsd: number
  lastError: string | null
  startedAt: string | null
  endedAt: string | null
}

export interface DashboardSnapshot {
  generatedAt: string
  status: {
    activeRuns: number
    dailyCostUsd: number
  }
  runs: RunListResult
  cost: {
    dailyBudgetUsd: number
  }
  build?: {
    version: string
    gitSha: string | null
  }
  config: {
    repos: string[]
    pollIntervalSeconds: number
  }
  stats: {
    throughput: {
      runs24h: number
      successRate7d: number
    }
    overview: {
      queuedRuns: number
      runningRuns: number
      reviewReadyRuns: number
      blockedRuns: number
      errorRuns: number
    }
  }
}

export interface RunEvent {
  id: number
  runId: string
  phase: string
  role: string
  type: string
  timestamp: string
  data: Record<string, unknown> | null
}

export interface RunEventsPayload {
  runId: string
  events: RunEvent[]
  lastEventId: number
}

export interface WsEnvelope {
  type: string
  payload?: unknown
  error?: string
}

export interface SessionResponse {
  mutationToken: string
  operationsEnabled?: boolean
}

export interface UpdateStatus {
  state: string
  error?: string
}

export type CommandSpec = string | string[]

export interface ProjectWorkerProfileSummary {
  type: string
  command: string
  args: string[]
  workerTimeoutSeconds: number
  minimalEnv: boolean
  runtimeWrapper: string | null
  envKeys: string[]
}

export interface ProjectLabels {
  ready: string[]
  running: string
  blocked: string
  needsHuman: string
  reviewReady: string
  error: string
  retry: string
  planning: string
  mergeQueued: string
  merging: string
  mergeFailed: string
}

export interface ProjectRepoSummary {
  repo: string
  forge: 'github' | 'forgejo'
  linkedProjects: string[]
  apiBaseUrl?: string
  tokenEnv?: string
  maxConcurrentRuns: number
  localPath: string
  baseBranch: string
  branchPrefix: string
  labels: ProjectLabels
  kanban?: {
    triggerLabel: string
    labels: ProjectLabels
  }
  labelConfig: Record<string, { color?: string; description?: string }>
  defaults: {
    planner: 'claude' | 'codex'
    coder: 'claude' | 'codex'
    reviewer: 'claude' | 'codex'
    doneMode: 'pr-ready' | 'manual-only'
    notifyPriority: 'normal' | 'high'
    prMentions: string[]
  }
  environment?: {
    defaultMode: 'shared' | 'dedicated'
    dedicated?: {
      compose: {
        file: string
        services: string[]
        projectName: string
      }
      env: {
        copyFrom: string
        overrideKeys: string[]
        overrideFiles: string[]
      }
      healthcheck?: CommandSpec
      teardownOnComplete: boolean
    }
    shared?: {
      requireRunning: boolean
      healthcheck?: CommandSpec
    }
    bootstrap: Array<{
      command: CommandSpec
      when: 'always' | 'dedicated' | 'shared'
    }>
    cleanup: Array<{
      command: CommandSpec
      when: 'always' | 'dedicated' | 'shared'
    }>
  }
  verify: CommandSpec[]
  prompts: {
    plannerSystem: boolean
    coderSystem: boolean
    reviewerSystem: boolean
  }
  planning: {
    prdDirectory: string
  }
  selectors: {
    includeLabelsAny: string[]
    excludeLabelsAny: string[]
  }
  agents: Record<string, string>
  workflow?: string
  mergeQueue: {
    enabled: boolean
    batchSize: number
    mergeMethod: 'merge' | 'squash' | 'rebase'
    retryFlakyOnce: boolean
    requireApproval: boolean
    stagingBranchPrefix: string
  }
}

export interface ProjectsSnapshot {
  generatedAt: string
  githubDefaults: {
    tokenEnv: string
    apiBaseUrl: string
  }
  workerProfiles: Record<string, ProjectWorkerProfileSummary>
  repos: ProjectRepoSummary[]
}
