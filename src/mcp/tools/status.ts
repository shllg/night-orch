import type { MCPDependencies } from '../server.js'
import type { ForgeIssue } from '../../forge/types.js'
import { RunManager } from '../../state/runs.js'
import { loadIssueLogEvents, loadRunLogEvents } from '../../state/run-log-events.js'
import { CostTracker } from '../../loop/cost.js'
import { isIssueEligibleForRepo } from '../../discovery/discover.js'
import { flushActiveAgentObservability } from '../../events/observability.js'
import { loadRuns } from '../../cli/tui/data.js'

interface RunTimingRow {
  id: string
  started_at: string | null
  ended_at: string | null
}

type RunListView = 'active' | 'completed' | 'failed' | 'all'

const RUN_LIST_VIEWS: readonly RunListView[] = ['active', 'completed', 'failed', 'all']

interface HistoryRunRow extends RunTimingRow {
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

interface QueryRunHistoryPageOptions {
  repo?: string
  statuses?: string[]
  limit: number
  offset: number
}

interface RunPage<T> {
  rows: T[]
  hasMore: boolean
}

function queryRunHistoryPage(
  deps: MCPDependencies,
  options: QueryRunHistoryPageOptions,
): RunPage<HistoryRunRow> {
  const params: unknown[] = []
  const conditions: string[] = []

  if (options.repo) {
    conditions.push('r.repo = ?')
    params.push(options.repo)
  }

  if (options.statuses && options.statuses.length > 0) {
    const placeholders = options.statuses.map(() => '?').join(', ')
    conditions.push(`r.status IN (${placeholders})`)
    params.push(...options.statuses)
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : ''

  params.push(options.limit + 1, options.offset)

  const rows = deps.db
    .prepare(
      `SELECT
         r.id,
         r.repo,
         r.issue_number,
         r.status,
         COALESCE(
           NULLIF(TRIM(r.issue_title), ''),
           (
             SELECT NULLIF(TRIM(r2.issue_title), '')
             FROM runs r2
             WHERE r2.repo = r.repo
               AND r2.issue_number = r.issue_number
               AND r2.issue_title IS NOT NULL
               AND TRIM(r2.issue_title) != ''
             ORDER BY
               COALESCE(julianday(r2.created_at), 0) DESC,
               COALESCE(julianday(r2.updated_at), 0) DESC,
               r2.rowid DESC,
               r2.id DESC
             LIMIT 1
           )
         ) AS issue_title,
         r.pr_number,
         r.current_phase,
         r.iteration_count,
         r.estimated_cost_usd,
         r.last_error,
         r.started_at,
         r.ended_at
       FROM runs r
       ${whereClause}
       ORDER BY
         COALESCE(julianday(r.created_at), 0) DESC,
         COALESCE(julianday(r.updated_at), 0) DESC,
         r.rowid DESC,
         r.id DESC
       LIMIT ?
       OFFSET ?`,
    )
    .all(...params) as HistoryRunRow[]

  const hasMore = rows.length > options.limit
  return {
    rows: hasMore ? rows.slice(0, options.limit) : rows,
    hasMore,
  }
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

function normalizeListRunsOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    return 0
  }

  return Math.max(0, Math.floor(offset))
}

function normalizeRunListView(view: string | undefined): RunListView | null {
  if (!view) return null
  return RUN_LIST_VIEWS.includes(view as RunListView)
    ? (view as RunListView)
    : null
}

function mapRunRow(
  row: HistoryRunRow,
): {
  runId: string
  hasRun: boolean
  repo: string
  issue: number
  status: string
  issueTitle: string | null
  prNumber: number | null
  phase: string | null
  iterations: number
  costUsd: number
  lastError: string | null
  startedAt: string | null
  endedAt: string | null
} {
  return {
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
  }
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

  const events = loadRunLogEvents(deps.db, args.runId, 0, 50).slice().reverse()

  return {
    ...run,
    events: events.map((e) => ({
      source: e.source,
      type: e.type,
      phase: e.phase,
      role: e.role,
      data: e.data,
      at: e.timestamp,
    })),
  }
}

export async function handleListRuns(
  args: { repo?: string; status?: string; limit?: number; offset?: number; view?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  const limit = normalizeListRunsLimit(args.limit)
  const offset = normalizeListRunsOffset(args.offset)
  const view = normalizeRunListView(args.view)

  const historyStatuses = view === 'completed'
    ? ['completed']
    : view === 'failed'
      ? ['blocked', 'error']
      : view === 'all'
        ? undefined
        : args.status === 'completed'
          ? ['completed']
          : undefined

  if (historyStatuses || view === 'all') {
    const page = queryRunHistoryPage(deps, {
      repo: args.repo,
      statuses: historyStatuses,
      limit,
      offset,
    })

    return {
      count: page.rows.length,
      runs: page.rows.map((row) => mapRunRow(row)),
      limit,
      offset,
      hasMore: page.hasMore,
      nextOffset: page.hasMore ? offset + page.rows.length : null,
      view: view ?? null,
    }
  }

  // Active view: exclude terminated attempts so Continue/Retry
  // predecessors stay in the history panel instead of surfacing as
  // duplicate rows for the same issue in the dashboard's "Active" tab.
  const filteredRows = loadRuns(deps.db, {
    limit: limit + 1,
    offset,
    repo: args.repo,
    status: args.status,
    includeTerminated: false,
  })
  const hasMore = filteredRows.length > limit
  const pageRows = hasMore ? filteredRows.slice(0, limit) : filteredRows
  const runTimings = loadRunTimingsByRunId(
    deps,
    pageRows
      .map((row) => row.id)
      .filter((runId) => !runId.startsWith('issue:')),
  )

  return {
    count: pageRows.length,
    runs: pageRows.map((row) => {
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
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + pageRows.length : null,
    view: view ?? null,
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
  args: { runId?: string; repo?: string; issueNumber?: number; since?: number; limit?: number },
  deps: MCPDependencies,
): Promise<unknown> {
  if (!args.runId && (!args.repo || typeof args.issueNumber !== 'number')) {
    throw new Error('runId or repo+issueNumber is required')
  }

  const since = Math.max(0, Math.floor(args.since ?? 0))
  const requestedLimit = Math.floor(args.limit ?? 50)
  const limit = Math.min(200, Math.max(1, requestedLimit))

  // Flush buffered in-memory events to DB so callers can poll near-real-time.
  flushActiveAgentObservability()

  const rows = args.runId
    ? loadRunLogEvents(deps.db, args.runId, since, limit)
    : loadIssueLogEvents(deps.db, args.repo!, args.issueNumber!, since, limit)
  const lastEventId = rows.length > 0 ? rows[rows.length - 1]!.id : since

  return {
    ...(args.runId ? { runId: args.runId } : { repo: args.repo, issueNumber: args.issueNumber }),
    events: rows,
    lastEventId,
  }
}
