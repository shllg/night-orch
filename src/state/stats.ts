import type Database from 'better-sqlite3'

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

export interface TuiStatsSnapshot {
  readonly updatedAt: string
  readonly overview: {
    totalRuns: number
    activeRuns: number
    queuedRuns: number
    runningRuns: number
    reviewReadyRuns: number
    completedRuns: number
    blockedRuns: number
    errorRuns: number
  }
  readonly statusCounts: StatusAggregate[]
  readonly phaseCounts: PhaseAggregate[]
  readonly throughput: {
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
  readonly cost: {
    todayCostUsd: number
    todayRunCount: number
    cost7d: number
    cost30d: number
    avgDailyCost7d: number
    dailyHistory: DailyCostAggregate[]
  }
  readonly queue: {
    activeBatches: number
    statuses: StatusAggregate[]
  }
  readonly agents: {
    eventsTotal: number
    events24h: number
    events7d: number
    toolCalls24h: number
    thinking24h: number
    uniqueRuns7d: number
    roleBreakdown7d: AgentRoleAggregate[]
  }
  readonly topRepos30d: RepoAggregate[]
}

export function loadTuiStats(db: Database.Database): TuiStatsSnapshot {
  const overviewRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total_runs,
         SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS active_runs,
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_runs,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_runs,
         SUM(CASE WHEN status = 'review_ready' THEN 1 ELSE 0 END) AS review_ready_runs,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_runs,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_runs
       FROM runs`,
    )
    .get() as OverviewRow | undefined

  const statusCounts = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM runs
       GROUP BY status
       ORDER BY count DESC, status ASC`,
    )
    .all() as StatusCountRow[]

  const phaseCounts = db
    .prepare(
      `SELECT current_phase AS phase, COUNT(*) AS count
       FROM runs
       WHERE status IN ('queued', 'running', 'review_ready')
         AND current_phase IS NOT NULL
       GROUP BY current_phase
       ORDER BY count DESC, current_phase ASC
       LIMIT 8`,
    )
    .all() as PhaseCountRow[]

  const throughputRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN datetime(created_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS runs_24h,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS runs_7d,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS runs_30d,
         SUM(CASE WHEN status = 'completed' AND datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS completed_7d,
         SUM(CASE WHEN status = 'blocked' AND datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS blocked_7d,
         SUM(CASE WHEN status = 'error' AND datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS error_7d,
         AVG(
           CASE
             WHEN datetime(created_at) >= datetime('now', '-7 days')
               AND started_at IS NOT NULL
               AND ended_at IS NOT NULL
             THEN (julianday(ended_at) - julianday(started_at)) * 24 * 60
             ELSE NULL
           END
         ) AS avg_duration_min_7d,
         AVG(
           CASE
             WHEN datetime(created_at) >= datetime('now', '-7 days')
             THEN COALESCE(iteration_count, 0)
             ELSE NULL
           END
         ) AS avg_iterations_7d
       FROM runs`,
    )
    .get() as ThroughputRow | undefined

  const costRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN date = date('now') THEN total_cost_usd ELSE 0 END) AS today_cost_usd,
         SUM(CASE WHEN date = date('now') THEN run_count ELSE 0 END) AS today_run_count,
         SUM(CASE WHEN date >= date('now', '-6 days') THEN total_cost_usd ELSE 0 END) AS cost_7d,
         SUM(CASE WHEN date >= date('now', '-29 days') THEN total_cost_usd ELSE 0 END) AS cost_30d,
         AVG(CASE WHEN date >= date('now', '-6 days') THEN total_cost_usd ELSE NULL END) AS avg_daily_cost_7d
       FROM daily_costs`,
    )
    .get() as CostRow | undefined

  const dailyHistory = db
    .prepare(
      `SELECT date, total_cost_usd, run_count
       FROM daily_costs
       WHERE date >= date('now', '-6 days')
       ORDER BY date DESC`,
    )
    .all() as DailyCostRow[]

  const queueStatuses = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM merge_batches
       WHERE status NOT IN ('passed', 'failed')
       GROUP BY status
       ORDER BY count DESC, status ASC`,
    )
    .all() as StatusCountRow[]

  const queueActive = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM merge_batches
       WHERE status NOT IN ('passed', 'failed')`,
    )
    .get() as CountRow | undefined

  const agentRow = db
    .prepare(
      `SELECT
         COUNT(*) AS events_total,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS events_24h,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS events_7d,
         SUM(CASE WHEN event_type = 'tool_call' AND datetime(created_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS tool_calls_24h,
         SUM(CASE WHEN event_type = 'thinking' AND datetime(created_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS thinking_24h,
         COUNT(DISTINCT CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN run_id ELSE NULL END) AS unique_runs_7d
       FROM agent_events`,
    )
    .get() as AgentRow | undefined

  const roleBreakdown = db
    .prepare(
      `SELECT
         role,
         COUNT(*) AS events,
         SUM(CASE WHEN event_type = 'tool_call' THEN 1 ELSE 0 END) AS tool_calls
       FROM agent_events
       WHERE datetime(created_at) >= datetime('now', '-7 days')
       GROUP BY role
       ORDER BY events DESC, role ASC
       LIMIT 6`,
    )
    .all() as RoleRow[]

  const topRepos = db
    .prepare(
      `SELECT
         repo,
         COUNT(*) AS total_runs,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_runs,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_runs,
         SUM(COALESCE(estimated_cost_usd, 0)) AS total_cost_usd,
         AVG(COALESCE(iteration_count, 0)) AS avg_iterations
       FROM runs
       WHERE datetime(created_at) >= datetime('now', '-30 days')
       GROUP BY repo
       ORDER BY total_runs DESC, total_cost_usd DESC, repo ASC
       LIMIT 6`,
    )
    .all() as RepoRow[]

  const completed7d = toNumber(throughputRow?.completed_7d)
  const blocked7d = toNumber(throughputRow?.blocked_7d)
  const error7d = toNumber(throughputRow?.error_7d)
  const terminal7d = completed7d + blocked7d + error7d
  const successRate7d = terminal7d > 0 ? (completed7d / terminal7d) * 100 : 0

  return {
    updatedAt: new Date().toISOString(),
    overview: {
      totalRuns: toNumber(overviewRow?.total_runs),
      activeRuns: toNumber(overviewRow?.active_runs),
      queuedRuns: toNumber(overviewRow?.queued_runs),
      runningRuns: toNumber(overviewRow?.running_runs),
      reviewReadyRuns: toNumber(overviewRow?.review_ready_runs),
      completedRuns: toNumber(overviewRow?.completed_runs),
      blockedRuns: toNumber(overviewRow?.blocked_runs),
      errorRuns: toNumber(overviewRow?.error_runs),
    },
    statusCounts: statusCounts.map((row) => ({
      status: row.status,
      count: toNumber(row.count),
    })),
    phaseCounts: phaseCounts.map((row) => ({
      phase: row.phase,
      count: toNumber(row.count),
    })),
    throughput: {
      runs24h: toNumber(throughputRow?.runs_24h),
      runs7d: toNumber(throughputRow?.runs_7d),
      runs30d: toNumber(throughputRow?.runs_30d),
      completed7d,
      blocked7d,
      error7d,
      successRate7d,
      avgDurationMinutes7d: toNumber(throughputRow?.avg_duration_min_7d),
      avgIterations7d: toNumber(throughputRow?.avg_iterations_7d),
    },
    cost: {
      todayCostUsd: toNumber(costRow?.today_cost_usd),
      todayRunCount: toNumber(costRow?.today_run_count),
      cost7d: toNumber(costRow?.cost_7d),
      cost30d: toNumber(costRow?.cost_30d),
      avgDailyCost7d: toNumber(costRow?.avg_daily_cost_7d),
      dailyHistory: dailyHistory.map((row) => ({
        date: row.date,
        totalCostUsd: toNumber(row.total_cost_usd),
        runCount: toNumber(row.run_count),
      })),
    },
    queue: {
      activeBatches: toNumber(queueActive?.count),
      statuses: queueStatuses.map((row) => ({
        status: row.status,
        count: toNumber(row.count),
      })),
    },
    agents: {
      eventsTotal: toNumber(agentRow?.events_total),
      events24h: toNumber(agentRow?.events_24h),
      events7d: toNumber(agentRow?.events_7d),
      toolCalls24h: toNumber(agentRow?.tool_calls_24h),
      thinking24h: toNumber(agentRow?.thinking_24h),
      uniqueRuns7d: toNumber(agentRow?.unique_runs_7d),
      roleBreakdown7d: roleBreakdown.map((row) => ({
        role: row.role,
        events: toNumber(row.events),
        toolCalls: toNumber(row.tool_calls),
      })),
    },
    topRepos30d: topRepos.map((row) => ({
      repo: row.repo,
      totalRuns: toNumber(row.total_runs),
      completedRuns: toNumber(row.completed_runs),
      blockedRuns: toNumber(row.blocked_runs),
      errorRuns: toNumber(row.error_runs),
      totalCostUsd: toNumber(row.total_cost_usd),
      avgIterations: toNumber(row.avg_iterations),
    })),
  }
}

function toNumber(value: number | bigint | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

interface OverviewRow {
  total_runs: number | null
  active_runs: number | null
  queued_runs: number | null
  running_runs: number | null
  review_ready_runs: number | null
  completed_runs: number | null
  blocked_runs: number | null
  error_runs: number | null
}

interface ThroughputRow {
  runs_24h: number | null
  runs_7d: number | null
  runs_30d: number | null
  completed_7d: number | null
  blocked_7d: number | null
  error_7d: number | null
  avg_duration_min_7d: number | null
  avg_iterations_7d: number | null
}

interface CostRow {
  today_cost_usd: number | null
  today_run_count: number | null
  cost_7d: number | null
  cost_30d: number | null
  avg_daily_cost_7d: number | null
}

interface AgentRow {
  events_total: number | null
  events_24h: number | null
  events_7d: number | null
  tool_calls_24h: number | null
  thinking_24h: number | null
  unique_runs_7d: number | null
}

interface DailyCostRow {
  date: string
  total_cost_usd: number | null
  run_count: number | null
}

interface StatusCountRow {
  status: string
  count: number | null
}

interface PhaseCountRow {
  phase: string
  count: number | null
}

interface RoleRow {
  role: string
  events: number | null
  tool_calls: number | null
}

interface RepoRow {
  repo: string
  total_runs: number | null
  completed_runs: number | null
  blocked_runs: number | null
  error_runs: number | null
  total_cost_usd: number | null
  avg_iterations: number | null
}

interface CountRow {
  count: number | null
}
