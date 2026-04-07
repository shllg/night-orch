export type RunStatus = 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed'

export const DASHBOARD_PAGES = ['issues', 'stats', 'projects', 'agent', 'settings'] as const
export type DashboardPage = (typeof DASHBOARD_PAGES)[number]

export function isDashboardPage(page: string): page is DashboardPage {
  return DASHBOARD_PAGES.some((knownPage) => knownPage === page)
}

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

export interface StatusAggregate {
  status: string
  count: number
}

export interface PhaseAggregate {
  phase: string
  count: number
}

export interface RepoAggregate {
  repo: string
  totalRuns: number
  completedRuns: number
  blockedRuns: number
  errorRuns: number
  totalCostUsd: number
  avgIterations: number
}

export interface AgentRoleAggregate {
  role: string
  events: number
  toolCalls: number
}

export interface DailyCostAggregate {
  date: string
  totalCostUsd: number
  runCount: number
}

export interface DailyUsageAggregate {
  date: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  runCount: number
}

export interface ErrorPatternAggregate {
  pattern: string
  count: number
}

export interface TuiStatsSnapshot {
  updatedAt: string
  overview: {
    totalRuns: number
    activeRuns: number
    queuedRuns: number
    runningRuns: number
    reviewReadyRuns: number
    completedRuns: number
    blockedRuns: number
    errorRuns: number
  }
  statusCounts: StatusAggregate[]
  phaseCounts: PhaseAggregate[]
  throughput: {
    runs24h: number
    runs7d: number
    runs30d: number
    completed7d: number
    blocked7d: number
    error7d: number
    successRate7d: number
    avgDurationMinutes7d: number
    avgIterations7d: number
  }
  reliability: {
    failureCount7d: number
    failureRate7d: number
    topErrorPatterns7d: ErrorPatternAggregate[]
  }
  cost: {
    model: 'pay-per-use' | 'subscription'
    todayCostUsd: number
    todayRunCount: number
    cost7d: number
    cost30d: number
    avgDailyCost7d: number
    dailyHistory: DailyCostAggregate[]
  }
  usage: {
    todayPromptTokens: number
    todayCompletionTokens: number
    todayTotalTokens: number
    tokens7d: number
    tokens30d: number
    avgDailyTokens7d: number
    dailyHistory: DailyUsageAggregate[]
  }
  efficiency: {
    totalCostUsd7d: number
    avgCostPerRun7d: number
    avgCostPerSuccess7d: number
    avgCostPerIteration7d: number
    completedPerDollar7d: number
    avgTokensPerRun7d: number
    avgTokensPerSuccess7d: number
    avgTokensPerIteration7d: number
  }
  resources: {
    activeLeases: number
    expiringLeases: number
    expiredLeases: number
    leasedRepos: number
    activeWorktrees: number
    missingWorktrees: number
    staleWorktrees: number
  }
  timing: {
    sampleSize30d: number
    p50Minutes: number
    p90Minutes: number
    p99Minutes: number
  }
  queue: {
    activeBatches: number
    statuses: StatusAggregate[]
  }
  agents: {
    eventsTotal: number
    events24h: number
    events7d: number
    toolCalls24h: number
    thinking24h: number
    uniqueRuns7d: number
    roleBreakdown7d: AgentRoleAggregate[]
  }
  topRepos30d: RepoAggregate[]
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
    dailyBudgetOverrideUsd: number | null
    effectiveDailyBudgetUsd: number
  }
  build?: {
    version: string
    gitSha: string | null
  }
  config: {
    repos: string[]
    pollIntervalSeconds: number
  }
  stats: TuiStatsSnapshot
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

export type InteractiveAgentType = 'claude' | 'codex'
export type InteractiveAgentSessionStatus = 'idle' | 'running' | 'failed' | 'closed'
export type InteractiveAgentSessionEventType = 'status' | 'stdout' | 'stderr' | 'text' | 'tool_call'

export interface InteractiveAgentProfileSummary {
  name: string
  type: InteractiveAgentType
  command: string
  args: string[]
}

export interface InteractiveAgentSessionSummary {
  id: string
  agent: InteractiveAgentType
  profileName: string | null
  status: InteractiveAgentSessionStatus
  cwd: string
  createdAt: string
  updatedAt: string
  turnCount: number
  lastError: string | null
}

export interface InteractiveAgentSessionDetail extends InteractiveAgentSessionSummary {
  continueSessionId: string | null
  runningTurnId: string | null
}

export interface InteractiveAgentSessionEvent {
  id: number
  sessionId: string
  timestamp: string
  type: InteractiveAgentSessionEventType
  data: Record<string, unknown>
}

export interface InteractiveAgentSessionsSnapshot {
  generatedAt: string
  workspacePath: string
  profiles: InteractiveAgentProfileSummary[]
  sessions: InteractiveAgentSessionSummary[]
}

export interface InteractiveAgentSessionEventsPayload {
  sessionId: string
  status: InteractiveAgentSessionStatus
  events: InteractiveAgentSessionEvent[]
  lastEventId: number
}

export type ShellSessionStatus = 'running' | 'closed'
export type ShellSessionEventType = 'status' | 'output' | 'exit'

export interface ShellSessionSummary {
  id: string
  status: ShellSessionStatus
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: string
  updatedAt: string
  exitCode: number | null
  exitSignal: number | null
}

export type ShellSessionDetail = ShellSessionSummary

export interface ShellSessionEvent {
  id: number
  sessionId: string
  timestamp: string
  type: ShellSessionEventType
  data: Record<string, unknown>
}

export interface ShellSessionsSnapshot {
  generatedAt: string
  homePath: string
  sessions: ShellSessionSummary[]
}

export interface ShellSessionEventsPayload {
  sessionId: string
  status: ShellSessionStatus
  events: ShellSessionEvent[]
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

export type RuntimeSettingType = 'number' | 'boolean' | 'string' | 'json'

export type RuntimeSettingValue =
  | string
  | number
  | boolean
  | null
  | RuntimeSettingValue[]
  | { [key: string]: RuntimeSettingValue }

export interface RuntimeSettingSnapshot {
  key: string
  label: string
  description: string
  details: string
  type: RuntimeSettingType
  mutable: boolean
  sensitive: boolean
  min?: number
  max?: number
  step?: number
  options?: string[]
  allowNull?: boolean
  defaultValue: RuntimeSettingValue
  hasYamlValue: boolean
  yamlValue: RuntimeSettingValue | null
  baseValue: RuntimeSettingValue
  overrideValue: RuntimeSettingValue | null
  effectiveValue: RuntimeSettingValue
  source: 'base' | 'override'
  updatedBy: string | null
  updatedAt: string | null
}

export interface SettingsSnapshot {
  generatedAt: string
  settings: RuntimeSettingSnapshot[]
}

export type UpdateState =
  | 'idle'
  | 'draining'
  | 'pulling'
  | 'building'
  | 'restarting'
  | 'health-checking'
  | 'rolling-back'
  | 'failed'
  | (string & {})

export interface UpdateStatus {
  state: UpdateState
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
