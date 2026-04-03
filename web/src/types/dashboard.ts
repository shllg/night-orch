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
