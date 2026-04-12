import type { MCPDependencies } from '../server.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { handleListSettings, handleSetSetting, handleClearSetting } from './settings.js'
import { handleStatus, handleRunDetail, handleListRuns, handleCostReport, handleListIssues, handleStreamEvents } from './status.js'
import { handleRetry, handleSync, handleCleanup, handlePoll, handleRebase, handleContinue } from './operations.js'
import { handleCostOverride, handleCostReset, handleDailyCostOverride, handleDailyCostReset, handleLabelsInit, handleDeleteEntry, handleUpdate } from './admin.js'

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
          view: { type: 'string', description: 'Preset list view for web/history browsing', enum: ['active', 'completed', 'failed', 'all'] },
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
      return handleListRuns(args as { repo?: string; status?: string; limit?: number; offset?: number; view?: string }, runtimeDeps)
    case 'night-orch-cost-report':
      return handleCostReport(args as { days?: number }, runtimeDeps)
    case 'night-orch-retry':
      return handleRetry(args as { repo: string; issueNumber: number; resetPlan?: boolean; fresh?: boolean; strategy?: 'merge' | 'rebase'; authToken?: string }, runtimeDeps)
    case 'night-orch-cost-override':
      return handleCostOverride(
        args as { repo: string; issueNumber: number; amountUsd?: number; clear?: boolean; authToken?: string },
        runtimeDeps,
      )
    case 'night-orch-cost-reset':
      return handleCostReset(
        args as { repo: string; issueNumber: number; authToken?: string },
        runtimeDeps,
      )
    case 'night-orch-daily-cost-override':
      return handleDailyCostOverride(
        args as { amountUsd?: number; clear?: boolean; authToken?: string },
        runtimeDeps,
      )
    case 'night-orch-daily-cost-reset':
      return handleDailyCostReset(
        args as { authToken?: string },
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
      return handleStreamEvents(args as { runId?: string; repo?: string; issueNumber?: number; since?: number; limit?: number }, runtimeDeps)
    case 'night-orch-rebase':
      return handleRebase(args as { repo: string; issueNumber: number; check?: boolean; strategy?: 'merge' | 'rebase'; authToken?: string }, runtimeDeps)
    case 'night-orch-continue':
      return handleContinue(args as { repo: string; issueNumber: number; strategy?: 'merge' | 'rebase'; authToken?: string }, runtimeDeps)
    case 'night-orch-update':
      return handleUpdate(args as { authToken?: string }, runtimeDeps)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
