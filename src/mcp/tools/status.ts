import type { MCPDependencies } from '../server.js'
import type { ForgeIssue } from '../../forge/types.js'
import { RunManager } from '../../state/runs.js'
import { loadIssueLogEvents, loadRunLogEvents } from '../../state/run-log-events.js'
import { loadRuns } from '../../state/run-list.js'
import { CostTracker } from '../../loop/cost.js'
import { isIssueEligibleForRepo } from '../../discovery/discover.js'
import { flushActiveAgentObservability } from '../../events/observability.js'
import {
  classifyInboxTriage,
  deriveInboxCommandHints,
  type InboxTriage,
} from '../../discovery/triage.js'
import {
  loadDailyCostRows,
  loadRecentCompletedRuns,
  loadRunTimingsByRunId,
  queryRunHistoryPage,
} from '../../state/run-queries.js'
import { loadInboxIssueRows } from '../../state/inbox-queries.js'
import {
  countInboxTriages,
  mapActiveRunRow,
  mapHistoryRunRow,
  mapInboxIssueRow,
  sortInboxItems,
} from '../../state/run-mapper.js'

type RunListView = 'active' | 'completed' | 'failed' | 'all'

const RUN_LIST_VIEWS: readonly RunListView[] = ['active', 'completed', 'failed', 'all']
const INBOX_TRIAGE_VALUES: readonly InboxTriage[] = ['needs_human', 'review_ready', 'blocked', 'error']

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

function normalizeInboxTriage(value: string | undefined): InboxTriage | 'all' | null {
  if (!value) return 'all'
  if (value === 'all') return 'all'
  return INBOX_TRIAGE_VALUES.includes(value as InboxTriage)
    ? (value as InboxTriage)
    : null
}

export async function handleStatus(args: { repo?: string }, deps: MCPDependencies): Promise<unknown> {
  const runManager = new RunManager(deps.db)
  const costTracker = new CostTracker(deps.db)

  const active = runManager.getActive()
  const filtered = args.repo ? active.filter((r) => r.repo === args.repo) : active
  const dailyTokens = costTracker.getDailyTokenUsage()

  const recentRows = loadRecentCompletedRuns(deps.db, args.repo)

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
    recentCompleted: recentRows.map((r) => ({
      runId: r.id,
      repo: r.repo,
      issue: r.issue_number,
      status: r.status,
      endedAt: r.ended_at,
    })),
    dailyCostUsd: costTracker.getDailyCost(),
    dailyTheoreticalCostUsd: costTracker.getDailyTheoreticalCost(),
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
    const page = queryRunHistoryPage(deps.db, {
      repo: args.repo,
      statuses: historyStatuses,
      limit,
      offset,
    })

    return {
      count: page.rows.length,
      runs: page.rows.map((row) => mapHistoryRunRow(row)),
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
    deps.db,
    pageRows
      .map((row) => row.run_id)
      .filter((runId): runId is string => runId !== null),
  )

  return {
    count: pageRows.length,
    runs: pageRows.map((row) => mapActiveRunRow(row, row.run_id ? runTimings.get(row.run_id) : undefined)),
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + pageRows.length : null,
    view: view ?? null,
  }
}

export async function handleListInbox(
  args: { repo?: string; triage?: string; limit?: number; offset?: number },
  deps: MCPDependencies,
): Promise<unknown> {
  const limit = normalizeListRunsLimit(args.limit)
  const offset = normalizeListRunsOffset(args.offset)
  const triageFilter = normalizeInboxTriage(args.triage)
  if (triageFilter === null) {
    throw new Error(`Invalid triage filter: ${args.triage}`)
  }

  const rows = loadInboxIssueRows(deps.db, args.repo)
  const triaged = rows.map((row) => {
    const triage = classifyInboxTriage(row)
    const commandHints = deriveInboxCommandHints(row)
    return mapInboxIssueRow(row, triage, commandHints)
  })
  const triageCounts = countInboxTriages(triaged)

  const filtered = triageFilter === 'all'
    ? triaged
    : triaged.filter((item) => item.triage === triageFilter)
  const sorted = sortInboxItems(filtered)

  const page = sorted.slice(offset, offset + limit)
  const hasMore = offset + limit < sorted.length

  return {
    count: page.length,
    total: sorted.length,
    items: page,
    triageCounts,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + page.length : null,
    triage: triageFilter,
  }
}

export async function handleCostReport(args: { days?: number }, deps: MCPDependencies): Promise<unknown> {
  const days = args.days ?? 7
  const costModel = deps.config.cost?.model ?? 'pay-per-use'
  const costTracker = new CostTracker(deps.db)
  const dailyBudgetOverrideUsd = costTracker.getDailyCapOverride()
  const effectiveDailyBudgetUsd = dailyBudgetOverrideUsd ?? deps.config.security.maxDailyCostUsd
  const rows = loadDailyCostRows(deps.db, days)

  const totalCost = rows.reduce((sum, r) => sum + r.total_cost_usd, 0)
  const totalTheoreticalCost = rows.reduce((sum, r) => sum + r.total_theoretical_cost_usd, 0)
  const totalRuns = rows.reduce((sum, r) => sum + r.run_count, 0)
  const totalPromptTokens = rows.reduce((sum, r) => sum + r.total_prompt_tokens, 0)
  const totalCompletionTokens = rows.reduce((sum, r) => sum + r.total_completion_tokens, 0)
  const totalCacheReadTokens = rows.reduce((sum, r) => sum + r.total_cache_read_tokens, 0)

  return {
    model: costModel,
    period: `Last ${days} days`,
    totalCostUsd: Math.round(totalCost * 100) / 100,
    totalTheoreticalCostUsd: Math.round(totalTheoreticalCost * 100) / 100,
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
      totalTheoreticalCostUsd: row.total_theoretical_cost_usd,
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
