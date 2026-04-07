import type Database from 'better-sqlite3'
import type { CostModel } from '../config/schema.js'
import { nowUtcIso } from '../utils/time.js'

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
  cacheReadTokens?: number
  totalTokens: number
  runCount: number
}

export interface StepCostAggregate {
  stepId: string
  totalCostUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export interface WorkerCostAggregate {
  workerType: string
  totalCostUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export interface ErrorPatternAggregate {
  pattern: string
  count: number
}

export interface TuiStatsOptions {
  costModel?: CostModel
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
  readonly reliability: {
    failureCount7d: number
    failureRate7d: number
    topErrorPatterns7d: ErrorPatternAggregate[]
  }
  readonly cost: {
    model: CostModel
    todayCostUsd: number
    todayRunCount: number
    cost7d: number
    cost30d: number
    avgDailyCost7d: number
    dailyHistory: DailyCostAggregate[]
    phaseBreakdown7d?: StepCostAggregate[]
    workerBreakdown7d?: WorkerCostAggregate[]
  }
  readonly usage: {
    todayPromptTokens: number
    todayCompletionTokens: number
    todayCacheReadTokens?: number
    todayTotalTokens: number
    tokens7d: number
    tokens30d: number
    avgDailyTokens7d: number
    dailyHistory: DailyUsageAggregate[]
  }
  readonly efficiency: {
    totalCostUsd7d: number
    avgCostPerRun7d: number
    avgCostPerSuccess7d: number
    avgCostPerIteration7d: number
    completedPerDollar7d: number
    avgTokensPerRun7d: number
    avgTokensPerSuccess7d: number
    avgTokensPerIteration7d: number
  }
  readonly resources: {
    activeLeases: number
    expiringLeases: number
    expiredLeases: number
    leasedRepos: number
    activeWorktrees: number
    missingWorktrees: number
    staleWorktrees: number
  }
  readonly timing: {
    sampleSize30d: number
    p50Minutes: number
    p90Minutes: number
    p99Minutes: number
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

export function loadTuiStats(
  db: Database.Database,
  options: TuiStatsOptions = {},
): TuiStatsSnapshot {
  const costModel = options.costModel ?? 'pay-per-use'

  const overviewRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total_runs,
         SUM(CASE WHEN status IN ('queued', 'running', 'blocked', 'review_ready', 'error') THEN 1 ELSE 0 END) AS active_runs,
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

  const efficiencyRow = db
    .prepare(
      `SELECT
         COUNT(*) AS runs_7d,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_7d,
         SUM(COALESCE(estimated_cost_usd, 0)) AS total_cost_usd_7d,
         SUM(COALESCE(iteration_count, 0)) AS total_iterations_7d,
         SUM(COALESCE(prompt_tokens, 0)) AS total_prompt_tokens_7d,
         SUM(COALESCE(completion_tokens, 0)) AS total_completion_tokens_7d,
         SUM(COALESCE(cache_read_tokens, 0)) AS total_cache_read_tokens_7d
       FROM runs
       WHERE datetime(created_at) >= datetime('now', '-7 days')`,
    )
    .get() as EfficiencyRow | undefined

  const costRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN date = date('now') THEN total_cost_usd ELSE 0 END) AS today_cost_usd,
         SUM(CASE WHEN date = date('now') THEN run_count ELSE 0 END) AS today_run_count,
         SUM(CASE WHEN date = date('now') THEN total_prompt_tokens ELSE 0 END) AS today_prompt_tokens,
         SUM(CASE WHEN date = date('now') THEN total_completion_tokens ELSE 0 END) AS today_completion_tokens,
         SUM(CASE WHEN date = date('now') THEN total_cache_read_tokens ELSE 0 END) AS today_cache_read_tokens,
         SUM(CASE WHEN date >= date('now', '-6 days') THEN total_cost_usd ELSE 0 END) AS cost_7d,
         SUM(CASE WHEN date >= date('now', '-29 days') THEN total_cost_usd ELSE 0 END) AS cost_30d,
         AVG(CASE WHEN date >= date('now', '-6 days') THEN total_cost_usd ELSE NULL END) AS avg_daily_cost_7d,
         SUM(CASE WHEN date >= date('now', '-6 days') THEN total_prompt_tokens + total_completion_tokens + total_cache_read_tokens ELSE 0 END) AS tokens_7d,
         SUM(CASE WHEN date >= date('now', '-29 days') THEN total_prompt_tokens + total_completion_tokens + total_cache_read_tokens ELSE 0 END) AS tokens_30d,
         AVG(CASE WHEN date >= date('now', '-6 days') THEN total_prompt_tokens + total_completion_tokens + total_cache_read_tokens ELSE NULL END) AS avg_daily_tokens_7d
       FROM daily_costs`,
    )
    .get() as CostRow | undefined

  const dailyHistory = db
    .prepare(
      `SELECT date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens
       FROM daily_costs
       WHERE date >= date('now', '-6 days')
       ORDER BY date DESC`,
    )
    .all() as DailyCostRow[]

  const phaseCostBreakdown = db
    .prepare(
      `SELECT
         step_id,
         SUM(cost_usd) AS total_cost_usd,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens
       FROM run_cost_entries
       WHERE datetime(created_at) >= datetime('now', '-7 days')
       GROUP BY step_id
       ORDER BY total_cost_usd DESC, step_id ASC
       LIMIT 8`,
    )
    .all() as StepCostRow[]

  const workerCostBreakdown = db
    .prepare(
      `SELECT
         COALESCE(worker_type, 'unknown') AS worker_type,
         SUM(cost_usd) AS total_cost_usd,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens
       FROM run_cost_entries
       WHERE datetime(created_at) >= datetime('now', '-7 days')
       GROUP BY worker_type
       ORDER BY total_cost_usd DESC, worker_type ASC
       LIMIT 8`,
    )
    .all() as WorkerCostRow[]

  const errorMessages = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(block_reason), ''), NULLIF(TRIM(last_error), '')) AS message
       FROM runs
       WHERE datetime(created_at) >= datetime('now', '-7 days')
         AND status IN ('blocked', 'error')
         AND COALESCE(NULLIF(TRIM(block_reason), ''), NULLIF(TRIM(last_error), '')) IS NOT NULL
       ORDER BY datetime(updated_at) DESC
       LIMIT 200`,
    )
    .all() as ErrorMessageRow[]

  const leaseHealthRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN datetime(leased_until) >= datetime('now') THEN 1 ELSE 0 END) AS active_leases,
         SUM(
           CASE
             WHEN datetime(leased_until) >= datetime('now')
               AND datetime(leased_until) <= datetime('now', '+30 minutes')
             THEN 1
             ELSE 0
           END
         ) AS expiring_leases,
         SUM(CASE WHEN datetime(leased_until) < datetime('now') THEN 1 ELSE 0 END) AS expired_leases,
         COUNT(DISTINCT CASE WHEN datetime(leased_until) >= datetime('now') THEN repo ELSE NULL END) AS leased_repos
       FROM leases`,
    )
    .get() as LeaseHealthRow | undefined

  const worktreeHealthRow = db
    .prepare(
      `SELECT
         COUNT(
           DISTINCT CASE
             WHEN status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
               AND worktree_path IS NOT NULL
               AND TRIM(worktree_path) != ''
             THEN worktree_path
             ELSE NULL
           END
         ) AS active_worktrees,
         SUM(
           CASE
             WHEN status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
               AND (worktree_path IS NULL OR TRIM(worktree_path) = '')
             THEN 1
             ELSE 0
           END
         ) AS missing_worktrees,
         COUNT(
           DISTINCT CASE
             WHEN status = 'completed'
               AND worktree_path IS NOT NULL
               AND TRIM(worktree_path) != ''
               AND datetime(COALESCE(ended_at, updated_at, created_at)) < datetime('now', '-24 hours')
             THEN worktree_path
             ELSE NULL
           END
         ) AS stale_worktrees
       FROM runs`,
    )
    .get() as WorktreeHealthRow | undefined

  const durationRows = db
    .prepare(
      `SELECT (julianday(ended_at) - julianday(started_at)) * 24 * 60 AS duration_minutes
       FROM runs
       WHERE datetime(created_at) >= datetime('now', '-30 days')
         AND status IN ('completed', 'blocked', 'error')
         AND started_at IS NOT NULL
         AND ended_at IS NOT NULL
       ORDER BY duration_minutes ASC`,
    )
    .all() as DurationRow[]

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
  const runs7d = toNumber(throughputRow?.runs_7d)
  const terminal7d = completed7d + blocked7d + error7d
  const successRate7d = terminal7d > 0 ? (completed7d / terminal7d) * 100 : 0
  const failureCount7d = blocked7d + error7d
  const failureRate7d = terminal7d > 0 ? (failureCount7d / terminal7d) * 100 : 0
  const topErrorPatterns7d = summarizeErrorPatterns(errorMessages.map((row) => row.message))

  const totalCostUsd7d = toNumber(efficiencyRow?.total_cost_usd_7d)
  const completedRunsForEfficiency = toNumber(efficiencyRow?.completed_7d)
  const totalIterations7d = toNumber(efficiencyRow?.total_iterations_7d)
  const totalPromptTokens7d = toNumber(efficiencyRow?.total_prompt_tokens_7d)
  const totalCompletionTokens7d = toNumber(efficiencyRow?.total_completion_tokens_7d)
  const totalCacheReadTokens7d = toNumber(efficiencyRow?.total_cache_read_tokens_7d)
  const totalTokens7d = totalPromptTokens7d + totalCompletionTokens7d + totalCacheReadTokens7d
  const runsForEfficiency = toNumber(efficiencyRow?.runs_7d)

  const avgCostPerRun7d = runsForEfficiency > 0 ? totalCostUsd7d / runsForEfficiency : 0
  const avgCostPerSuccess7d = completedRunsForEfficiency > 0 ? totalCostUsd7d / completedRunsForEfficiency : 0
  const avgCostPerIteration7d = totalIterations7d > 0 ? totalCostUsd7d / totalIterations7d : 0
  const completedPerDollar7d = totalCostUsd7d > 0 ? completedRunsForEfficiency / totalCostUsd7d : 0
  const avgTokensPerRun7d = runsForEfficiency > 0 ? totalTokens7d / runsForEfficiency : 0
  const avgTokensPerSuccess7d = completedRunsForEfficiency > 0 ? totalTokens7d / completedRunsForEfficiency : 0
  const avgTokensPerIteration7d = totalIterations7d > 0 ? totalTokens7d / totalIterations7d : 0

  const durations = durationRows
    .map((row) => toNumber(row.duration_minutes))
    .filter((duration) => duration > 0)
    .sort((a, b) => a - b)

  return {
    updatedAt: nowUtcIso(),
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
      runs7d,
      runs30d: toNumber(throughputRow?.runs_30d),
      completed7d,
      blocked7d,
      error7d,
      successRate7d,
      avgDurationMinutes7d: toNumber(throughputRow?.avg_duration_min_7d),
      avgIterations7d: toNumber(throughputRow?.avg_iterations_7d),
    },
    reliability: {
      failureCount7d,
      failureRate7d,
      topErrorPatterns7d,
    },
    cost: {
      model: costModel,
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
      phaseBreakdown7d: phaseCostBreakdown.map((row) => {
        const promptTokens = toNumber(row.prompt_tokens)
        const completionTokens = toNumber(row.completion_tokens)
        const cacheReadTokens = toNumber(row.cache_read_tokens)
        return {
          stepId: row.step_id,
          totalCostUsd: toNumber(row.total_cost_usd),
          promptTokens,
          completionTokens,
          cacheReadTokens,
          totalTokens: promptTokens + completionTokens + cacheReadTokens,
        }
      }),
      workerBreakdown7d: workerCostBreakdown.map((row) => {
        const promptTokens = toNumber(row.prompt_tokens)
        const completionTokens = toNumber(row.completion_tokens)
        const cacheReadTokens = toNumber(row.cache_read_tokens)
        return {
          workerType: row.worker_type,
          totalCostUsd: toNumber(row.total_cost_usd),
          promptTokens,
          completionTokens,
          cacheReadTokens,
          totalTokens: promptTokens + completionTokens + cacheReadTokens,
        }
      }),
    },
    usage: {
      todayPromptTokens: toNumber(costRow?.today_prompt_tokens),
      todayCompletionTokens: toNumber(costRow?.today_completion_tokens),
      todayCacheReadTokens: toNumber(costRow?.today_cache_read_tokens),
      todayTotalTokens:
        toNumber(costRow?.today_prompt_tokens) +
        toNumber(costRow?.today_completion_tokens) +
        toNumber(costRow?.today_cache_read_tokens),
      tokens7d: toNumber(costRow?.tokens_7d),
      tokens30d: toNumber(costRow?.tokens_30d),
      avgDailyTokens7d: toNumber(costRow?.avg_daily_tokens_7d),
      dailyHistory: dailyHistory.map((row) => {
        const promptTokens = toNumber(row.total_prompt_tokens)
        const completionTokens = toNumber(row.total_completion_tokens)
        const cacheReadTokens = toNumber(row.total_cache_read_tokens)
        return {
          date: row.date,
          promptTokens,
          completionTokens,
          cacheReadTokens,
          totalTokens: promptTokens + completionTokens + cacheReadTokens,
          runCount: toNumber(row.run_count),
        }
      }),
    },
    efficiency: {
      totalCostUsd7d,
      avgCostPerRun7d,
      avgCostPerSuccess7d,
      avgCostPerIteration7d,
      completedPerDollar7d,
      avgTokensPerRun7d,
      avgTokensPerSuccess7d,
      avgTokensPerIteration7d,
    },
    resources: {
      activeLeases: toNumber(leaseHealthRow?.active_leases),
      expiringLeases: toNumber(leaseHealthRow?.expiring_leases),
      expiredLeases: toNumber(leaseHealthRow?.expired_leases),
      leasedRepos: toNumber(leaseHealthRow?.leased_repos),
      activeWorktrees: toNumber(worktreeHealthRow?.active_worktrees),
      missingWorktrees: toNumber(worktreeHealthRow?.missing_worktrees),
      staleWorktrees: toNumber(worktreeHealthRow?.stale_worktrees),
    },
    timing: {
      sampleSize30d: durations.length,
      p50Minutes: calculatePercentile(durations, 0.5),
      p90Minutes: calculatePercentile(durations, 0.9),
      p99Minutes: calculatePercentile(durations, 0.99),
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

function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0
  const clamped = Math.min(1, Math.max(0, percentile))
  const position = clamped * (sortedValues.length - 1)
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)

  const lowerValue = sortedValues[lowerIndex] ?? 0
  const upperValue = sortedValues[upperIndex] ?? lowerValue
  if (lowerIndex === upperIndex) return lowerValue

  const weight = position - lowerIndex
  return lowerValue + ((upperValue - lowerValue) * weight)
}

function summarizeErrorPatterns(messages: Array<string | null | undefined>): ErrorPatternAggregate[] {
  const patterns = new Map<string, { count: number; pattern: string }>()

  for (const message of messages) {
    if (typeof message !== 'string') continue
    const normalizedWhitespace = message.replace(/\s+/g, ' ').trim()
    if (!normalizedWhitespace) continue

    const key = normalizeErrorPattern(normalizedWhitespace)
    const existing = patterns.get(key)
    if (existing) {
      existing.count += 1
      continue
    }
    patterns.set(key, {
      count: 1,
      pattern: truncateErrorPattern(normalizedWhitespace, 80),
    })
  }

  return [...patterns.values()]
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, 4)
    .map((entry) => ({
      pattern: entry.pattern,
      count: entry.count,
    }))
}

function normalizeErrorPattern(message: string): string {
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<id>')
    .replace(/#[0-9]+\b/g, '#<n>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateErrorPattern(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3)}...`
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

interface EfficiencyRow {
  runs_7d: number | null
  completed_7d: number | null
  total_cost_usd_7d: number | null
  total_iterations_7d: number | null
  total_prompt_tokens_7d: number | null
  total_completion_tokens_7d: number | null
  total_cache_read_tokens_7d: number | null
}

interface CostRow {
  today_cost_usd: number | null
  today_run_count: number | null
  today_prompt_tokens: number | null
  today_completion_tokens: number | null
  today_cache_read_tokens: number | null
  cost_7d: number | null
  cost_30d: number | null
  avg_daily_cost_7d: number | null
  tokens_7d: number | null
  tokens_30d: number | null
  avg_daily_tokens_7d: number | null
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
  total_prompt_tokens: number | null
  total_completion_tokens: number | null
  total_cache_read_tokens: number | null
}

interface StepCostRow {
  step_id: string
  total_cost_usd: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read_tokens: number | null
}

interface WorkerCostRow {
  worker_type: string
  total_cost_usd: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read_tokens: number | null
}

interface ErrorMessageRow {
  message: string | null
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

interface LeaseHealthRow {
  active_leases: number | null
  expiring_leases: number | null
  expired_leases: number | null
  leased_repos: number | null
}

interface WorktreeHealthRow {
  active_worktrees: number | null
  missing_worktrees: number | null
  stale_worktrees: number | null
}

interface DurationRow {
  duration_minutes: number | null
}
