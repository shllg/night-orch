import type { MCPDependencies } from '../server.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { handleListSettings, handleSetSetting, handleClearSetting } from './settings.js'
import { handleStatus, handleRunDetail, handleListRuns, handleListInbox, handleCostReport, handleListIssues, handleStreamEvents } from './status.js'
import { handleRetry, handleSync, handleCleanup, handlePoll, handleRebase, handleContinue } from './operations.js'
import { handleCostOverride, handleCostReset, handleDailyCostOverride, handleDailyCostReset, handleLabelsInit, handleDeleteEntry, handleUpdate } from './admin.js'
import { handleFileLoop } from './file-loop.js'
import { handleHandoffs } from './handoffs.js'
import { handleTimeline } from './timeline.js'
import {
  handleRetroRun,
  handleRetroListSuggestions,
  handleRetroViewSuggestion,
} from './retro.js'
import { z } from 'zod'

interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description: string
      default?: unknown
      enum?: string[]
      items?: { type: string; enum?: string[] }
    }>
    required?: string[]
  }
}

const RUN_STATUS_VALUES = ['queued', 'running', 'blocked', 'review_ready', 'error', 'completed'] as const
const RUN_VIEW_VALUES = ['active', 'completed', 'failed', 'all'] as const
const INBOX_TRIAGE_VALUES = ['needs_human', 'review_ready', 'blocked', 'error', 'all'] as const
const UPDATE_STRATEGY_VALUES = ['merge', 'rebase'] as const
// Surface that initiated a user action, recorded in run_log_events telemetry.
// Defaults to 'mcp' when omitted; the web UI passes 'web' so its actions are not
// mislabeled as raw MCP calls (both share the same tool handler).
const USER_ACTION_ACTOR_VALUES = ['mcp', 'web', 'cli', 'tui'] as const
const LIST_ISSUES_FILTER_VALUES = ['eligible', 'running', 'blocked', 'all'] as const
const FILE_LOOP_ACTION_VALUES = ['start', 'stop', 'status'] as const

const EmptyArgsSchema = z.object({}).passthrough()
const AuthTokenArgsSchema = z.object({ authToken: z.string().optional() }).passthrough()
const SetSettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
])

const SetSettingArgsSchema = z.object({
  key: z.string(),
  value: SetSettingValueSchema,
  authToken: z.string().optional(),
}).passthrough()
const ClearSettingArgsSchema = z.object({
  key: z.string(),
  authToken: z.string().optional(),
}).passthrough()
const StatusArgsSchema = z.object({
  repo: z.string().optional(),
}).passthrough()
const RunDetailArgsSchema = z.object({
  runId: z.string(),
}).passthrough()
const HandoffsArgsSchema = z.object({
  runId: z.string(),
}).passthrough()
const TimelineArgsSchema = z.object({
  runId: z.string(),
  sources: z.array(z.enum(['system', 'agent', 'user'])).optional(),
  kinds: z.array(z.enum(['phase', 'handoff', 'event', 'cost', 'prompt'])).optional(),
  sinceMs: z.number().optional(),
  limit: z.number().optional(),
}).passthrough()
const RetroRunArgsSchema = z.object({
  sinceMs: z.number().optional(),
  classifier: z.string().optional(),
  dryRun: z.boolean().optional(),
}).passthrough()
const RetroListSuggestionsArgsSchema = z.object({
  limit: z.number().optional(),
}).passthrough()
const RetroViewSuggestionArgsSchema = z.object({
  id: z.number(),
}).passthrough()
const ListRunsArgsSchema = z.object({
  repo: z.string().optional(),
  status: z.enum(RUN_STATUS_VALUES).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  view: z.enum(RUN_VIEW_VALUES).optional(),
}).passthrough()
const ListInboxArgsSchema = z.object({
  repo: z.string().optional(),
  triage: z.enum(INBOX_TRIAGE_VALUES).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
}).passthrough()
const CostReportArgsSchema = z.object({
  days: z.number().optional(),
}).passthrough()
const RetryArgsSchema = z.object({
  repo: z.string(),
  issueNumber: z.number(),
  resetPlan: z.boolean().optional(),
  fresh: z.boolean().optional(),
  strategy: z.enum(UPDATE_STRATEGY_VALUES).optional(),
  actor: z.enum(USER_ACTION_ACTOR_VALUES).optional(),
  authToken: z.string().optional(),
}).passthrough()
const CostOverrideArgsSchema = z.object({
  repo: z.string(),
  issueNumber: z.number(),
  amountUsd: z.number().optional(),
  clear: z.boolean().optional(),
  authToken: z.string().optional(),
}).passthrough()
const CostResetArgsSchema = z.object({
  repo: z.string(),
  issueNumber: z.number(),
  authToken: z.string().optional(),
}).passthrough()
const DailyCostOverrideArgsSchema = z.object({
  amountUsd: z.number().optional(),
  clear: z.boolean().optional(),
  authToken: z.string().optional(),
}).passthrough()
const ToggleDryRunArgsSchema = z.object({
  dryRun: z.boolean().optional(),
  authToken: z.string().optional(),
}).passthrough()
const LabelsInitArgsSchema = z.object({
  repo: z.string(),
  dryRun: z.boolean().optional(),
  authToken: z.string().optional(),
}).passthrough()
const DeleteEntryArgsSchema = z.object({
  repo: z.string(),
  issueNumber: z.number(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  authToken: z.string().optional(),
}).passthrough()
const ListIssuesArgsSchema = z.object({
  repo: z.string(),
  filter: z.enum(LIST_ISSUES_FILTER_VALUES).optional(),
}).passthrough()
const StreamEventsArgsSchema = z.object({
  runId: z.string().optional(),
  repo: z.string().optional(),
  issueNumber: z.number().optional(),
  since: z.number().optional(),
  limit: z.number().optional(),
}).passthrough()
const RebaseArgsSchema = z.object({
  repo: z.string(),
  issueNumber: z.number(),
  check: z.boolean().optional(),
  strategy: z.enum(UPDATE_STRATEGY_VALUES).optional(),
  authToken: z.string().optional(),
}).passthrough()
const ContinueArgsSchema = z.object({
  repo: z.string(),
  issueNumber: z.number(),
  strategy: z.enum(UPDATE_STRATEGY_VALUES).optional(),
  actor: z.enum(USER_ACTION_ACTOR_VALUES).optional(),
  authToken: z.string().optional(),
}).passthrough()
const FileLoopArgsSchema = z.object({
  action: z.enum(FILE_LOOP_ACTION_VALUES),
  repo: z.string().optional(),
  maxMinutes: z.number().optional(),
  authToken: z.string().optional(),
}).passthrough()

function parseToolArgs<T>(
  toolName: string,
  schema: z.ZodType<T>,
  args: unknown,
): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const path = firstIssue?.path.join('.') || 'root'
    throw new Error(`Invalid arguments for ${toolName} at ${path}: ${firstIssue?.message ?? 'validation failed'}`)
  }
  return parsed.data
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
      name: 'night-orch-handoffs',
      description: 'List persisted agent handoffs for a run, ordered oldest to newest with summaries and markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID (e.g., run-abc123)' },
        },
        required: ['runId'],
      },
    },
    {
      name: 'night-orch-retro-run',
      description: 'Cluster recent failure classifiers and emit prompt-improvement suggestions. Use dryRun=true to inspect without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          sinceMs: { type: 'number', description: 'Earliest classifier ts (epoch ms). Default: 7d ago' },
          classifier: { type: 'string', description: 'Restrict to one classifier label' },
          dryRun: { type: 'string', description: 'Set to true to skip suggestion writes' },
        },
      },
    },
    {
      name: 'night-orch-retro-list-suggestions',
      description: 'List recent retro suggestions newest-first.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max suggestions (default 20)', default: 20 },
        },
      },
    },
    {
      name: 'night-orch-retro-view-suggestion',
      description: 'Fetch the full markdown body of a single retro suggestion.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Suggestion id' },
        },
        required: ['id'],
      },
    },
    {
      name: 'night-orch-timeline',
      description: 'Chronological timeline merging phases, handoffs, events, and cost entries for a run.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID (e.g., run-abc123)' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['system', 'agent', 'user'] },
            description: 'Filter by source(s)',
          },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: ['phase', 'handoff', 'event', 'cost', 'prompt'] },
            description: 'Filter by entry kind(s)',
          },
          sinceMs: { type: 'number', description: 'Earliest entry to include, epoch ms' },
          limit: { type: 'number', description: 'Max entries (default: 500, max: 2000)', default: 500 },
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
          view: { type: 'string', description: 'Preset list view for web/history browsing', enum: ['active', 'completed', 'failed', 'all'] },
          limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
          offset: { type: 'number', description: 'Result offset for pagination (default: 0)', default: 0 },
        },
      },
    },
    {
      name: 'night-orch-list-inbox',
      description: 'List active issues that need operator attention, triaged into needs_human/review_ready/blocked/error buckets.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Filter by repo (owner/name)' },
          triage: { type: 'string', description: 'Filter by triage bucket', enum: ['needs_human', 'review_ready', 'blocked', 'error', 'all'], default: 'all' },
          limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
          offset: { type: 'number', description: 'Result offset for pagination (default: 0)', default: 0 },
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
      description: 'Start a fresh retry of a blocked or errored issue from the latest base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number to retry' },
          resetPlan: { type: 'boolean', description: 'Deprecated compatibility field. Retry already starts fresh.', default: false },
          fresh: { type: 'boolean', description: 'Deprecated compatibility field. Retry already starts fresh.', default: false },
          strategy: { type: 'string', description: 'Override strategy for this action', enum: ['merge', 'rebase'] },
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
      name: 'night-orch-cost-reset',
      description:
        'Reset accumulated costs for the latest run of an issue. ' +
        'Subtracts the run\'s cost from the daily total and zeros the per-run cost accumulator. ' +
        'If the run was cost-blocked, it will be re-queued.',
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
      name: 'night-orch-daily-cost-reset',
      description:
        "Reset today's accumulated daily cost counters (UTC). " +
        'Zeros the daily totals while preserving any cap override. ' +
        'Automatically scans for and resumes any cost-blocked runs.',
      inputSchema: {
        type: 'object',
        properties: {
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
      description: 'Get recent run log events for a run or issue, including system, user, and agent messages.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Run ID (e.g., run-abc123)' },
          repo: { type: 'string', description: 'Repository (owner/name). Use with issueNumber for issue-scoped event history.' },
          issueNumber: { type: 'number', description: 'Issue number. Use with repo for issue-scoped event history.' },
          since: { type: 'number', description: 'Only return events with id > since' },
          limit: { type: 'number', description: 'Max events (default: 50, max: 200)', default: 50 },
        },
      },
    },
    {
      name: 'night-orch-rebase',
      description: 'Queue an explicit git rebase onto the latest base branch and verify afterward. If conflicts occur, the run blocks for continue or retry.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number' },
          check: { type: 'boolean', description: 'Run verify commands after rebase (default: true)', default: true },
          strategy: { type: 'string', description: 'Override strategy for this action', enum: ['merge', 'rebase'] },
          authToken: { type: 'string', description: 'Required when mcp.authTokenEnv is configured' },
        },
        required: ['repo', 'issueNumber'],
      },
    },
    {
      name: 'night-orch-continue',
      description: 'Resume the existing branch for a blocked/review_ready/error issue using fresh PR context. After a rebase conflict, continue keeps the branch and resolves it instead of starting over.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          issueNumber: { type: 'number', description: 'Issue number' },
          strategy: { type: 'string', description: 'Override strategy for this action', enum: ['merge', 'rebase'] },
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
    {
      name: 'night-orch-file-loop',
      description: 'Start, stop, or inspect repo-scoped file-loop sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform', enum: ['start', 'stop', 'status'] },
          repo: { type: 'string', description: 'Repository (owner/name). Required when multiple repos are configured.' },
          maxMinutes: { type: 'number', description: 'Optional duration override for start.', default: 0 },
          authToken: { type: 'string', description: 'Required for start/stop when mcp.authTokenEnv is configured' },
        },
        required: ['action'],
      },
    },
  ]
}

export async function handleToolCall(
  name: string,
  args: unknown,
  deps: MCPDependencies,
): Promise<unknown> {
  const runtimeDeps: MCPDependencies = {
    ...deps,
    config: resolveConfigWithRuntimeSettings(deps.config, deps.db),
  }

  switch (name) {
    case 'night-orch-list-settings':
      parseToolArgs(name, EmptyArgsSchema, args)
      return handleListSettings(deps)
    case 'night-orch-set-setting':
      return handleSetSetting(parseToolArgs(name, SetSettingArgsSchema, args), deps)
    case 'night-orch-clear-setting':
      return handleClearSetting(parseToolArgs(name, ClearSettingArgsSchema, args), deps)
    case 'night-orch-status':
      return handleStatus(parseToolArgs(name, StatusArgsSchema, args), runtimeDeps)
    case 'night-orch-run-detail':
      return handleRunDetail(parseToolArgs(name, RunDetailArgsSchema, args), runtimeDeps)
    case 'night-orch-handoffs':
      return handleHandoffs(parseToolArgs(name, HandoffsArgsSchema, args), runtimeDeps)
    case 'night-orch-timeline':
      return handleTimeline(parseToolArgs(name, TimelineArgsSchema, args), runtimeDeps)
    case 'night-orch-retro-run':
      return handleRetroRun(parseToolArgs(name, RetroRunArgsSchema, args), runtimeDeps)
    case 'night-orch-retro-list-suggestions':
      return handleRetroListSuggestions(parseToolArgs(name, RetroListSuggestionsArgsSchema, args), runtimeDeps)
    case 'night-orch-retro-view-suggestion':
      return handleRetroViewSuggestion(parseToolArgs(name, RetroViewSuggestionArgsSchema, args), runtimeDeps)
    case 'night-orch-list-runs':
      return handleListRuns(parseToolArgs(name, ListRunsArgsSchema, args), runtimeDeps)
    case 'night-orch-list-inbox':
      return handleListInbox(parseToolArgs(name, ListInboxArgsSchema, args), runtimeDeps)
    case 'night-orch-cost-report':
      return handleCostReport(parseToolArgs(name, CostReportArgsSchema, args), runtimeDeps)
    case 'night-orch-retry':
      return handleRetry(parseToolArgs(name, RetryArgsSchema, args), runtimeDeps)
    case 'night-orch-cost-override':
      return handleCostOverride(
        parseToolArgs(name, CostOverrideArgsSchema, args),
        runtimeDeps,
      )
    case 'night-orch-cost-reset':
      return handleCostReset(
        parseToolArgs(name, CostResetArgsSchema, args),
        runtimeDeps,
      )
    case 'night-orch-daily-cost-override':
      return handleDailyCostOverride(
        parseToolArgs(name, DailyCostOverrideArgsSchema, args),
        runtimeDeps,
      )
    case 'night-orch-daily-cost-reset':
      return handleDailyCostReset(
        parseToolArgs(name, AuthTokenArgsSchema, args),
        runtimeDeps,
      )
    case 'night-orch-sync':
      return handleSync(parseToolArgs(name, ToggleDryRunArgsSchema, args), runtimeDeps)
    case 'night-orch-cleanup':
      return handleCleanup(parseToolArgs(name, ToggleDryRunArgsSchema, args), runtimeDeps)
    case 'night-orch-labels-init':
      return handleLabelsInit(parseToolArgs(name, LabelsInitArgsSchema, args), runtimeDeps)
    case 'night-orch-delete-entry':
      return handleDeleteEntry(parseToolArgs(name, DeleteEntryArgsSchema, args), runtimeDeps)
    case 'night-orch-poll':
      return handlePoll(parseToolArgs(name, ToggleDryRunArgsSchema, args), runtimeDeps)
    case 'night-orch-list-issues':
      return handleListIssues(parseToolArgs(name, ListIssuesArgsSchema, args), runtimeDeps)
    case 'night-orch-stream-events':
      return handleStreamEvents(parseToolArgs(name, StreamEventsArgsSchema, args), runtimeDeps)
    case 'night-orch-rebase':
      return handleRebase(parseToolArgs(name, RebaseArgsSchema, args), runtimeDeps)
    case 'night-orch-continue':
      return handleContinue(parseToolArgs(name, ContinueArgsSchema, args), runtimeDeps)
    case 'night-orch-update':
      return handleUpdate(parseToolArgs(name, AuthTokenArgsSchema, args), runtimeDeps)
    case 'night-orch-file-loop':
      return handleFileLoop(parseToolArgs(name, FileLoopArgsSchema, args), runtimeDeps)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
