import type { MCPDependencies } from '../server.js'
import type { ForgeIssue } from '../../forge/types.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, mkdirSync } from 'node:fs'
import { RunManager } from '../../state/runs.js'
import { CostTracker } from '../../loop/cost.js'
import { SyncEngine } from '../../ops/sync.js'
import { CleanupEngine } from '../../ops/cleanup.js'
import { RetryEngine } from '../../ops/retry.js'
import { setIssueCostOverride } from '../../ops/cost-override.js'
import { setDailyCostCapOverride } from '../../ops/daily-cost-override.js'
import { LabelsInitEngine, formatLabelsInitSummary } from '../../ops/labels-init.js'
import { queueContinue } from '../../ops/continue.js'
import { DeleteIssueEntryEngine } from '../../ops/delete-entry.js'
import { isIssueEligibleForRepo } from '../../discovery/discover.js'
import { pollOnce } from '../../runner/poller.js'
import { flushActiveAgentObservability } from '../../events/observability.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { nowUtcIso } from '../../utils/time.js'
import { loadRuns } from '../../cli/tui/data.js'
import {
  clearRuntimeSettingOverride,
  listRuntimeSettings,
  resolveConfigWithRuntimeSettings,
  setRuntimeSettingOverride,
} from '../../settings/runtime.js'

interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string; default?: unknown; enum?: string[] }>
    required?: string[]
  }
}

export function registerTools(): ToolDefinition[] {
  return [
    {
      name: 'night-orch-list-settings',
      description: 'List runtime-configurable settings with base values, DB overrides, and effective values.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'night-orch-set-setting',
      description: 'Set one runtime setting override in DB.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key (for example github.pollIntervalSeconds)' },
          value: { type: 'string', description: 'Setting value as text (for booleans use true/false)' },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'night-orch-clear-setting',
      description: 'Clear one runtime setting override (revert to YAML/default).',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key' },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['key'],
      },
    },
    {
      name: 'night-orch-status',
      description: 'Get current night-orch operational status including active runs, eligible issues, and recent activity.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Optional: filter to a specific repo (owner/name)' },
        },
      },
    },
    {
      name: 'night-orch-run-detail',
      description: 'Get detailed information about a specific run including phase history and artifacts.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID (e.g., run-abc123)' },
        },
        required: ['runId'],
      },
    },
    {
      name: 'night-orch-list-runs',
      description: 'List runs with optional filters by repo, status, and limit.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Filter by repo (owner/name)' },
          status: { type: 'string', description: 'Filter by status', enum: ['queued', 'running', 'blocked', 'review_ready', 'error', 'completed'] },
          limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        },
      },
    },
    {
      name: 'night-orch-cost-report',
      description: 'Get cost breakdown for recent days, including daily totals and budget utilization.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days to include (default: 7)', default: 7 },
        },
      },
    },
    {
      name: 'night-orch-retry',
      description: 'Force a re-run of a blocked or errored issue. Resets state and re-queues for processing.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number to retry' },
          resetPlan: { type: 'boolean', description: 'Re-run planner instead of reusing existing plan', default: false },
          fresh: { type: 'boolean', description: 'Reset branch to base and re-implement from scratch (use after merge conflicts)', default: false },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['repo', 'issueNumber'],
      },
    },
    {
      name: 'night-orch-cost-override',
      description:
        'Grant a per-run cost budget override on the latest run for an issue. ' +
        'When set, the override replaces the per-run cap and exempts the run from the daily cap. ' +
        'Pass clear:true to remove an existing override.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number' },
          amountUsd: {
            type: 'number',
            description: 'Override budget in USD (positive number). Omit when clearing.',
          },
          clear: {
            type: 'boolean',
            description: 'Remove any existing cost override from the latest run for this issue.',
            default: false,
          },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['repo', 'issueNumber'],
      },
    },
    {
      name: 'night-orch-daily-cost-override',
      description:
        "Raise today's daily cost cap (UTC). Auto-expires at 00:00 UTC. " +
        'Use when the whole day is blocked and granting per-run overrides to each queued issue would be impractical. ' +
        'Pass clear:true to remove the override and fall back to the base cap.',
      inputSchema: {
        type: 'object',
        properties: {
          amountUsd: {
            type: 'number',
            description: "Override budget in USD (positive number) for today's daily cap. Omit when clearing.",
          },
          clear: {
            type: 'boolean',
            description: "Remove today's daily cost cap override.",
            default: false,
          },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
      },
    },
    {
      name: 'night-orch-sync',
      description: 'Reconcile local state with GitHub. Cleans stale runs, fixes label mismatches, detects orphaned worktrees.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'Preview changes without applying', default: false },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
      },
    },
    {
      name: 'night-orch-cleanup',
      description: 'Clean stale worktrees, expired leases, and old logs.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'Preview changes without applying', default: false },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
      },
    },
    {
      name: 'night-orch-labels-init',
      description: 'Create or update orchestration labels for a configured GitHub repository.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          dryRun: { type: 'boolean', description: 'Preview labels without creating/updating them', default: false },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'night-orch-delete-entry',
      description: 'Delete local orchestrator state for an issue (runs, leases, worktree pointers) so it can be rediscovered fresh.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number' },
          force: { type: 'boolean', description: 'Delete even if a run is currently in running status', default: false },
          dryRun: { type: 'boolean', description: 'Preview deletion counts without applying changes', default: false },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['repo', 'issueNumber'],
      },
    },
    {
      name: 'night-orch-poll',
      description: 'Manually trigger a single poll cycle — discovers eligible issues and processes them immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'Preview what would be processed without doing it', default: false },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
      },
    },
    {
      name: 'night-orch-list-issues',
      description: 'List issues from a repo with their orchestrator state (eligible, running, blocked).',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          filter: { type: 'string', description: 'Filter by state', enum: ['eligible', 'running', 'blocked', 'all'], default: 'all' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'night-orch-stream-events',
      description: 'Get recent in-flight agent events for a run.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID (e.g., run-abc123)' },
          since: { type: 'number', description: 'Only return events with id > since' },
          limit: { type: 'number', description: 'Max events (default: 50, max: 200)', default: 50 },
        },
        required: ['runId'],
      },
    },
    {
      name: 'night-orch-rebase',
      description: 'Rebase a PR branch onto latest base and verify. Re-queues issue if verify fails post-rebase.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number' },
          check: { type: 'boolean', description: 'Run verify commands after rebase (default: true)', default: true },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['repo', 'issueNumber'],
      },
    },
    {
      name: 'night-orch-continue',
      description: 'Queue a second-pass continuation for a blocked/review_ready/error issue using fresh PR context (comments, CI, mergeability).',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number' },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['repo', 'issueNumber'],
      },
    },
    {
      name: 'night-orch-update',
      description: 'Trigger a self-update: pulls latest code, rebuilds, and restarts all services.',
      inputSchema: {
        type: 'object',
        properties: {
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
      },
    },
  ]
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  deps: MCPDependencies,
): Promise<unknown> {
  const runtimeDeps: MCPDependencies = {
    ...deps,
    config: resolveConfigWithRuntimeSettings(deps.config, deps.db),
  }

  switch (name) {
    case 'night-orch-list-settings':
      return handleListSettings(deps)
    case 'night-orch-set-setting':
      return handleSetSetting(args as { key: string; value: unknown; authToken?: string }, deps)
    case 'night-orch-clear-setting':
      return handleClearSetting(args as { key: string; authToken?: string }, deps)
    case 'night-orch-status':
      return handleStatus(args as { repo?: string }, runtimeDeps)
    case 'night-orch-run-detail':
      return handleRunDetail(args as { runId: string }, runtimeDeps)
    case 'night-orch-list-runs':
      return handleListRuns(args as { repo?: string; status?: string; limit?: number }, runtimeDeps)
    case 'night-orch-cost-report':
      return handleCostReport(args as { days?: number }, runtimeDeps)
    case 'night-orch-retry':
      return handleRetry(args as { repo: string; issueNumber: number; resetPlan?: boolean; fresh?: boolean; authToken?: string }, runtimeDeps)
    case 'night-orch-cost-override':
      return handleCostOverride(
        args as { repo: string; issueNumber: number; amountUsd?: number; clear?: boolean; authToken?: string },
        runtimeDeps,
      )
    case 'night-orch-daily-cost-override':
      return handleDailyCostOverride(
        args as { amountUsd?: number; clear?: boolean; authToken?: string },
        runtimeDeps,
      )
    case 'night-orch-sync':
      return handleSync(args as { dryRun?: boolean; authToken?: string }, runtimeDeps)
    case 'night-orch-cleanup':
      return handleCleanup(args as { dryRun?: boolean; authToken?: string }, runtimeDeps)
    case 'night-orch-labels-init':
      return handleLabelsInit(args as { repo: string; dryRun?: boolean; authToken?: string }, runtimeDeps)
    case 'night-orch-delete-entry':
      return handleDeleteEntry(args as { repo: string; issueNumber: number; force?: boolean; dryRun?: boolean; authToken?: string }, runtimeDeps)
    case 'night-orch-poll':
      return handlePoll(args as { dryRun?: boolean; authToken?: string }, runtimeDeps)
    case 'night-orch-list-issues':
      return handleListIssues(args as { repo: string; filter?: string }, runtimeDeps)
    case 'night-orch-stream-events':
      return handleStreamEvents(args as { runId: string; since?: number; limit?: number }, runtimeDeps)
    case 'night-orch-rebase':
      return handleRebase(args as { repo: string; issueNumber: number; check?: boolean; authToken?: string }, runtimeDeps)
    case 'night-orch-continue':
      return handleContinue(args as { repo: string; issueNumber: number; authToken?: string }, runtimeDeps)
    case 'night-orch-update':
      return handleUpdate(args as { authToken?: string }, runtimeDeps)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function handleListSettings(deps: MCPDependencies): Promise<unknown> {
  return {
    settings: listRuntimeSettings(deps.config, deps.db),
  }
}

async function handleSetSetting(
  args: { key: string; value: unknown; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  if (typeof args.key !== 'string' || args.key.trim().length === 0) {
    throw new Error('key is required')
  }

  const result = setRuntimeSettingOverride(
    deps.config,
    deps.db,
    args.key.trim(),
    args.value,
    'mcp',
  )

  return {
    changed: result.changed,
    setting: result.setting,
    message: result.changed
      ? `Updated ${result.setting.key} to ${formatRuntimeSettingValue(result.setting.effectiveValue)}`
      : `${result.setting.key} unchanged`,
  }
}

async function handleClearSetting(
  args: { key: string; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  if (typeof args.key !== 'string' || args.key.trim().length === 0) {
    throw new Error('key is required')
  }

  const result = clearRuntimeSettingOverride(deps.config, deps.db, args.key.trim())
  return {
    changed: result.changed,
    setting: result.setting,
    message: result.changed
      ? `Cleared override for ${result.setting.key}`
      : `No override found for ${result.setting.key}`,
  }
}

function formatRuntimeSettingValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[function]'
  return JSON.stringify(value)
}

async function handleStatus(args: { repo?: string }, deps: MCPDependencies): Promise<unknown> {
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
    dailyTotalTokens: dailyTokens.totalTokens,
    configuredRepos: deps.config.repos.map((r) => r.repo),
  }
}

async function handleRunDetail(args: { runId: string }, deps: MCPDependencies): Promise<unknown> {
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

async function handleListRuns(
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

async function handleCostReport(args: { days?: number }, deps: MCPDependencies): Promise<unknown> {
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
         total_completion_tokens
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
    }>

  const totalCost = rows.reduce((sum, r) => sum + r.total_cost_usd, 0)
  const totalRuns = rows.reduce((sum, r) => sum + r.run_count, 0)
  const totalPromptTokens = rows.reduce((sum, r) => sum + r.total_prompt_tokens, 0)
  const totalCompletionTokens = rows.reduce((sum, r) => sum + r.total_completion_tokens, 0)

  return {
    model: costModel,
    period: `Last ${days} days`,
    totalCostUsd: Math.round(totalCost * 100) / 100,
    totalRuns,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
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
      totalTokens: row.total_prompt_tokens + row.total_completion_tokens,
    })),
  }
}

async function handleRetry(
  args: { repo: string; issueNumber: number; resetPlan?: boolean; fresh?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const fresh = args.fresh ?? false
  const engine = new RetryEngine(deps.db, deps.config)
  await engine.retry(args.repo, args.issueNumber, {
    resetPlan: args.resetPlan ?? fresh,
    resetBranch: fresh,
    dryRun: false,
    immediate: false,
  })
  const suffix = fresh ? ' (fresh start — branch will be reset)' : ''
  return { success: true, message: `Retry queued for ${args.repo}#${args.issueNumber}${suffix}` }
}

async function handleCostOverride(
  args: { repo: string; issueNumber: number; amountUsd?: number; clear?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const clear = args.clear ?? false
  if (clear && args.amountUsd !== undefined) {
    throw new Error('cost-override: cannot pass amountUsd together with clear:true')
  }
  if (!clear && (typeof args.amountUsd !== 'number' || !Number.isFinite(args.amountUsd) || args.amountUsd <= 0)) {
    throw new Error('cost-override: amountUsd must be a positive finite number (or set clear:true to remove)')
  }
  const overrideUsd = clear ? null : (args.amountUsd as number)
  const result = setIssueCostOverride(deps.db, args.repo, args.issueNumber, overrideUsd)
  return {
    success: true,
    runId: result.runId,
    previousOverrideUsd: result.previousOverrideUsd,
    overrideUsd: result.overrideUsd,
    message:
      overrideUsd === null
        ? `Cleared cost override for ${args.repo}#${args.issueNumber} (run ${result.runId})`
        : `Set cost override for ${args.repo}#${args.issueNumber} (run ${result.runId}) to $${overrideUsd.toFixed(2)}; daily cap bypassed for this run.`,
  }
}

async function handleDailyCostOverride(
  args: { amountUsd?: number; clear?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const clear = args.clear ?? false
  if (clear && args.amountUsd !== undefined) {
    throw new Error('daily-cost-override: cannot pass amountUsd together with clear:true')
  }
  if (!clear && (typeof args.amountUsd !== 'number' || !Number.isFinite(args.amountUsd) || args.amountUsd <= 0)) {
    throw new Error('daily-cost-override: amountUsd must be a positive finite number (or set clear:true to remove)')
  }
  const overrideUsd = clear ? null : (args.amountUsd as number)
  const result = setDailyCostCapOverride(deps.db, overrideUsd)
  return {
    success: true,
    date: result.date,
    previousUsd: result.previousUsd,
    overrideUsd: result.overrideUsd,
    message:
      overrideUsd === null
        ? `Cleared daily cost cap override for ${result.date}; base cap applies.`
        : `Set daily cost cap override for ${result.date} to $${overrideUsd.toFixed(2)}; auto-expires at 00:00 UTC.`,
  }
}

async function handleSync(args: { dryRun?: boolean; authToken?: string }, deps: MCPDependencies): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const engine = new SyncEngine(deps.db, deps.config)
  return engine.reconcile(args.dryRun ?? false)
}

async function handleCleanup(args: { dryRun?: boolean; authToken?: string }, deps: MCPDependencies): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const engine = new CleanupEngine(deps.db, deps.config)
  return engine.run({ dryRun: args.dryRun ?? false })
}

async function handleLabelsInit(
  args: { repo: string; dryRun?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  if (!args.repo) {
    throw new Error('repo is required')
  }

  const engine = new LabelsInitEngine(deps.config)
  const result = await engine.run({
    targetRepo: args.repo,
    dryRun: args.dryRun ?? false,
  })

  return {
    ...result,
    message: formatLabelsInitSummary(result),
  }
}

async function handleDeleteEntry(
  args: { repo: string; issueNumber: number; force?: boolean; dryRun?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const engine = new DeleteIssueEntryEngine(deps.db, deps.config)
  return engine.deleteEntry(args.repo, args.issueNumber, {
    dryRun: args.dryRun ?? false,
    force: args.force ?? false,
  })
}

async function handlePoll(
  args: { dryRun?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  if (deps.poller && !(args.dryRun ?? false)) {
    const trigger = deps.poller.triggerPollCycle()
    return {
      success: true,
      queued: true,
      state: trigger.state,
      processed: null,
      errors: null,
      message: trigger.state === 'woke-sleeper'
        ? 'Triggered immediate poll cycle on running headless poller'
        : trigger.state === 'queued-next-cycle'
          ? 'Queued immediate poll cycle after current run finishes'
          : 'Manual poll already pending; no additional cycle queued',
    }
  }

  const result = await pollOnce(deps.config, deps.db, args.dryRun ?? false)
  return {
    success: true,
    processed: result.processed,
    errors: result.errors,
    message: result.processed === 0
      ? 'No eligible issues found'
      : `Processed ${result.processed} issue(s), ${result.errors} error(s)`,
  }
}

async function handleListIssues(
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

function parseEventData(data: string | null): unknown {
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return { raw: data, parseError: 'Invalid JSON in stored event payload' }
  }
}

async function handleStreamEvents(
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

interface AgentEventRow {
  id: number
  run_id: string
  phase: string
  role: string
  event_type: string
  data: string | null
  created_at: string
}

async function handleRebase(
  args: { repo: string; issueNumber: number; check?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  const repoConfig = deps.config.repos.find((r) => r.repo === args.repo)
  if (!repoConfig) throw new Error(`Repository not found: ${args.repo}`)

  const forge = createForgeAdapter(repoConfig, deps.config)
  let botUser = ''
  try {
    const auth = await forge.validateAuth()
    botUser = auth.user
  } catch { /* best effort */ }

  const { queueRebase } = await import('../../ops/rebase-and-check.js')
  const result = await queueRebase(deps.db, forge, repoConfig, args.issueNumber, botUser)

  return {
    queued: result.queued,
    reason: result.reason,
  }
}

async function handleContinue(
  args: { repo: string; issueNumber: number; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  const repoConfig = deps.config.repos.find((r) => r.repo === args.repo)
  if (!repoConfig) throw new Error(`Repository not found: ${args.repo}`)

  const forge = createForgeAdapter(repoConfig, deps.config)
  let botUser = ''
  try {
    const auth = await forge.validateAuth()
    botUser = auth.user
  } catch { /* best effort */ }

  const result = await queueContinue(deps.db, forge, repoConfig, args.issueNumber, botUser)

  return {
    queued: result.queued,
    reason: result.reason,
  }
}

async function handleUpdate(
  args: { authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  // Try IPC first (running under supervisor)
  if (typeof process.send === 'function') {
    process.send({ type: 'update-requested' })
    return { accepted: true, method: 'ipc' }
  }

  // Fallback: trigger file
  const dataDir = resolve(homedir(), '.config', 'night-orch')
  const triggerPath = resolve(dataDir, 'update-requested')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(triggerPath, nowUtcIso())
  return { accepted: true, method: 'trigger-file' }
}

function assertMcpMutationAuth(providedToken: string | undefined, deps: MCPDependencies): void {
  const tokenEnv = deps.config.mcp.authTokenEnv
  if (!tokenEnv) return
  const expectedToken = process.env[tokenEnv]
  if (!expectedToken) {
    throw new Error(`MCP auth token env var ${tokenEnv} is configured but not set`)
  }
  if (!providedToken || !isMatchingMcpToken(providedToken, expectedToken)) {
    throw new Error('Unauthorized: missing or invalid MCP auth token')
  }
}

function isMatchingMcpToken(providedToken: string, expectedToken: string): boolean {
  const providedHash = createHash('sha256').update(providedToken).digest()
  const expectedHash = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(providedHash, expectedHash)
}
