import type { MCPDependencies } from '../server.js'
import type { ForgeIssue } from '../../forge/types.js'
import { RunManager } from '../../state/runs.js'
import { CostTracker } from '../../loop/cost.js'
import { isIssueEligibleForRepo } from '../../discovery/discover.js'
import { flushActiveAgentObservability } from '../../events/observability.js'
import { loadRuns } from '../../cli/tui/data.js'

interface RunTimingRow {
  id: string
  started_at: string | null
  ended_at: string | null
}

interface CompletedRunRow extends RunTimingRow {
  repo: string
  issue_number: number
  status: string
  issue_title: string | null
  pr_number: number | null
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
}

interface AgentEventRow {
  id: number
  run_id: string
  phase: string
  role: string
  event_type: string
  data: string | null
  created_at: string
}

function parseEventData(data: string | null): unknown {
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return { raw: data, parseError: 'Invalid JSON in stored event payload' }
  }
}

function queryCompletedRuns(
  deps: MCPDependencies,
  repo: string | undefined,
  limit: number,
): CompletedRunRow[] {
  const params: unknown[] = []
  const repoClause = repo ? 'AND repo = ?' : ''
  if (repo) {
    params.push(repo)
  }
  params.push(limit)

  return deps.db
    .prepare(
      `SELECT
         id,
         repo,
         issue_number,
         status,
         issue_title,
         pr_number,
         current_phase,
         iteration_count,
         estimated_cost_usd,
         last_error,
         started_at,
         ended_at
       FROM runs
       WHERE status = 'completed'
         ${repoClause}
       ORDER BY
         COALESCE(julianday(created_at), 0) DESC,
         COALESCE(julianday(updated_at), 0) DESC,
         id DESC
       LIMIT ?`,
    )
    .all(...params) as CompletedRunRow[]
}

function loadRunTimingsByRunId(
  deps: MCPDependencies,
  runIds: string[],
): Map<string, RunTimingRow> {
  const uniqueRunIds = [...new Set(runIds)]
  if (uniqueRunIds.length === 0) {
    return new Map()
  }

  const placeholders = uniqueRunIds.map(() => '?').join(', ')
  const rows = deps.db
    .prepare(`SELECT id, started_at, ended_at FROM runs WHERE id IN (${placeholders})`)
    .all(...uniqueRunIds) as RunTimingRow[]

  return new Map(rows.map((row) => [row.id, row]))
}

function normalizeListRunsLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 20
  }

  return Math.min(500, Math.max(1, Math.floor(limit)))
}

export async function handleStatus(args: { repo?: string }, deps: MCPDependencies): Promise<unknown> {
  const runManager = new RunManager(deps.db)
  const costTracker = new CostTracker(deps.db)

  const active = runManager.getActive()
  const filtered = args.repo ? active.filter((r) => r.repo === args.repo) : active
  const dailyTokens = costTracker.getDailyTokenUsage()

  // Recent completed runs
  const recentSql = args.repo
    ? "SELECT * FROM runs WHERE status = 'completed' AND repo = ? ORDER BY updated_at DESC LIMIT 10"
    : "SELECT * FROM runs WHERE status = 'completed' ORDER BY updated_at DESC LIMIT 10"
  const recentRows = args.repo
    ? deps.db.prepare(recentSql).all(args.repo)
    : deps.db.prepare(recentSql).all()

  return {
    activeRuns: filtered.length,
    active: filtered.map((r) => ({
      runId: r.id,
      repo: r.repo,
      issue: r.issueNumber,
      status: r.status,
      phase: r.currentPhase,
      iteration: r.iterationCount,
    })),
    recentCompleted: (recentRows as Array<{ id: string; repo: string; issue_number: number; status: string; ended_at: string | null }>).map((r) => ({
      runId: r.id,
      repo: r.repo,
      issue: r.issue_number,
      status: r.status,
      endedAt: r.ended_at,
    })),
    dailyCostUsd: costTracker.getDailyCost(),
    dailyPromptTokens: dailyTokens.promptTokens,
    dailyCompletionTokens: dailyTokens.completionTokens,
    dailyCacheReadTokens: dailyTokens.cacheReadTokens,
    dailyTotalTokens: dailyTokens.totalTokens,
    configuredRepos: deps.config.repos.map((r) => r.repo),
  }
}

export async function handleRunDetail(args: { runId: string }, deps: MCPDependencies): Promise<unknown> {
  const runManager = new RunManager(deps.db)
  const run = runManager.getById(args.runId)
  if (!run) throw new Error(`Run not found: ${args.runId}`)

  // Get events for this run
  const events = deps.db
    .prepare('SELECT event_type, phase, data, created_at FROM events WHERE run_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(args.runId) as Array<{ event_type: string; phase: string | null; data: string | null; created_at: string }>

  return {
    ...run,
    events: events.map((e) => ({
      type: e.event_type,
      phase: e.phase,
      data: parseEventData(e.data),
      at: e.created_at,
    })),
  }
}

export async function handleListRuns(
  args: { repo?: string; status?: string; limit?: number },
  deps: MCPDependencies,
): Promise<unknown> {
  const limit = normalizeListRunsLimit(args.limit)

  if (args.status === 'completed') {
    const rows = queryCompletedRuns(deps, args.repo, limit)
    return {
      count: rows.length,
      runs: rows.map((row) => ({
        runId: row.id,
        hasRun: true,
        repo: row.repo,
        issue: row.issue_number,
        status: row.status,
        issueTitle: row.issue_title,
        prNumber: row.pr_number,
        phase: row.current_phase,
        iterations: row.iteration_count ?? 0,
        costUsd: row.estimated_cost_usd ?? 0,
        lastError: row.last_error,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      })),
    }
  }

  const filteredRows = loadRuns(deps.db, {
    limit,
    repo: args.repo,
    status: args.status,
  })
  const runTimings = loadRunTimingsByRunId(
    deps,
    filteredRows
      .map((row) => row.id)
      .filter((runId) => !runId.startsWith('issue:')),
  )

  return {
    count: filteredRows.length,
    runs: filteredRows.map((row) => {
      const hasRun = !row.id.startsWith('issue:')
      const timing = hasRun ? runTimings.get(row.id) : undefined

      return {
        runId: row.id,
        hasRun,
        repo: row.repo,
        issue: row.issue_number,
        status: row.status,
        issueTitle: row.issue_title,
        prNumber: row.pr_number,
        phase: row.current_phase,
        iterations: row.iteration_count ?? 0,
        costUsd: row.estimated_cost_usd ?? 0,
        lastError: row.last_error,
        startedAt: hasRun ? timing?.started_at ?? null : null,
        endedAt: hasRun ? timing?.ended_at ?? null : null,
      }
    }),
  }
}

export async function handleCostReport(args: { days?: number }, deps: MCPDependencies): Promise<unknown> {
  const days = args.days ?? 7
  const costModel = deps.config.cost?.model ?? 'pay-per-use'
  const costTracker = new CostTracker(deps.db)
  const dailyBudgetOverrideUsd = costTracker.getDailyCapOverride()
  const effectiveDailyBudgetUsd = dailyBudgetOverrideUsd ?? deps.config.security.maxDailyCostUsd
  const rows = deps.db
    .prepare(
      `SELECT
         date,
         total_cost_usd,
         run_count,
         total_prompt_tokens,
         total_completion_tokens,
         total_cache_read_tokens
       FROM daily_costs
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(days) as Array<{
      date: string
      total_cost_usd: number
      run_count: number
      total_prompt_tokens: number
      total_completion_tokens: number
      total_cache_read_tokens: number
    }>

  const totalCost = rows.reduce((sum, r) => sum + r.total_cost_usd, 0)
  const totalRuns = rows.reduce((sum, r) => sum + r.run_count, 0)
  const totalPromptTokens = rows.reduce((sum, r) => sum + r.total_prompt_tokens, 0)
  const totalCompletionTokens = rows.reduce((sum, r) => sum + r.total_completion_tokens, 0)
  const totalCacheReadTokens = rows.reduce((sum, r) => sum + r.total_cache_read_tokens, 0)

  return {
    model: costModel,
    period: `Last ${days} days`,
    totalCostUsd: Math.round(totalCost * 100) / 100,
    totalRuns,
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheReadTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens + totalCacheReadTokens,
    dailyBudgetUsd: deps.config.security.maxDailyCostUsd,
    dailyBudgetOverrideUsd,
    effectiveDailyBudgetUsd,
    budgetUtilizationPct: rows.length > 0
      ? Math.round((rows[0]!.total_cost_usd / effectiveDailyBudgetUsd) * 100)
      : 0,
    daily: rows.map((row) => ({
      date: row.date,
      totalCostUsd: row.total_cost_usd,
      runCount: row.run_count,
      promptTokens: row.total_prompt_tokens,
      completionTokens: row.total_completion_tokens,
      cacheReadTokens: row.total_cache_read_tokens,
      totalTokens: row.total_prompt_tokens + row.total_completion_tokens + row.total_cache_read_tokens,
    })),
  }
}

export async function handleListIssues(
  args: { repo: string; filter?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  const adapter = deps.forgeAdapters.get(args.repo)
  if (!adapter) {
    throw new Error(`No forge adapter configured for repo: ${args.repo}`)
  }

  const repoConfig = deps.config.repos.find((r) => r.repo === args.repo)
  if (!repoConfig) {
    throw new Error(`Repo not found in config: ${args.repo}`)
  }

  const issues: ForgeIssue[] = (await adapter.listEligibleIssues(repoConfig))
    .filter((issue) => isIssueEligibleForRepo(issue, repoConfig))
  const runManager = new RunManager(deps.db)
  const filter = args.filter ?? 'all'

  const enriched = issues.map((issue) => {
    const run = runManager.getByRepoAndIssue(args.repo, issue.number)
    let orchState: 'eligible' | 'running' | 'blocked'
    if (run && (run.status === 'queued' || run.status === 'running')) {
      orchState = 'running'
    } else if (run && (run.status === 'blocked' || run.status === 'error')) {
      orchState = 'blocked'
    } else {
      orchState = 'eligible'
    }

    return {
      number: issue.number,
      title: issue.title,
      labels: issue.labels,
      state: orchState,
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
      url: issue.url,
    }
  })

  const filtered = filter === 'all'
    ? enriched
    : enriched.filter((i) => i.state === filter)

  return {
    repo: args.repo,
    count: filtered.length,
    issues: filtered,
  }
}

export async function handleStreamEvents(
  args: { runId: string; since?: number; limit?: number },
  deps: MCPDependencies,
): Promise<unknown> {
  if (!args.runId) {
    throw new Error('runId is required')
  }

  const since = Math.max(0, Math.floor(args.since ?? 0))
  const requestedLimit = Math.floor(args.limit ?? 50)
  const limit = Math.min(200, Math.max(1, requestedLimit))

  // Flush buffered in-memory events to DB so callers can poll near-real-time.
  flushActiveAgentObservability()

  const rows = since > 0
    ? deps.db
      .prepare(
        `SELECT id, run_id, phase, role, event_type, data, created_at
         FROM agent_events
         WHERE run_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(args.runId, since, limit) as AgentEventRow[]
    : deps.db
      .prepare(
        `SELECT id, run_id, phase, role, event_type, data, created_at
         FROM agent_events
         WHERE run_id = ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(args.runId, limit) as AgentEventRow[]

  const lastEventId = rows.length > 0 ? rows[rows.length - 1]!.id : since

  return {
    runId: args.runId,
    events: rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      phase: row.phase,
      role: row.role,
      type: row.event_type,
      data: parseEventData(row.data),
      timestamp: row.created_at,
    })),
    lastEventId,
  }
}
