import type { MCPDependencies } from '../server.js'
import { RunManager } from '../../state/runs.js'
import { CostTracker } from '../../loop/cost.js'

interface ResourceDefinition {
  uri: string
  name: string
  description: string
  mimeType: string
}

export function registerResources(): ResourceDefinition[] {
  return [
    {
      uri: 'night-orch://status',
      name: 'Operational Status',
      description: 'Current night-orch operational status, active runs, and recent activity.',
      mimeType: 'application/json',
    },
    {
      uri: 'night-orch://config',
      name: 'Configuration',
      description: 'Sanitized night-orch configuration (tokens redacted).',
      mimeType: 'application/json',
    },
    {
      uri: 'night-orch://metrics',
      name: 'Metrics',
      description: 'Current Prometheus metric values (if metrics enabled).',
      mimeType: 'application/json',
    },
  ]
}

export async function handleResourceRead(
  uri: string,
  deps: MCPDependencies,
): Promise<unknown> {
  // Handle parameterized URIs
  const runsMatch = uri.match(/^night-orch:\/\/runs\/(.+)$/)
  if (runsMatch) {
    return readRunResource(runsMatch[1]!, deps)
  }

  const logsMatch = uri.match(/^night-orch:\/\/logs\/(.+)$/)
  if (logsMatch) {
    return readLogsResource(logsMatch[1]!, deps)
  }

  switch (uri) {
    case 'night-orch://status':
      return readStatusResource(deps)
    case 'night-orch://config':
      return readConfigResource(deps)
    case 'night-orch://metrics':
      return readMetricsResource(deps)
    default:
      throw new Error(`Unknown resource: ${uri}`)
  }
}

async function readStatusResource(deps: MCPDependencies): Promise<unknown> {
  const runManager = new RunManager(deps.db)
  const costTracker = new CostTracker(deps.db)
  const active = runManager.getActive()

  const statusCounts = deps.db
    .prepare("SELECT status, COUNT(*) as count FROM runs GROUP BY status")
    .all() as Array<{ status: string; count: number }>

  return {
    activeRuns: active.length,
    statusCounts: Object.fromEntries(statusCounts.map((r) => [r.status, r.count])),
    dailyCostUsd: costTracker.getDailyCost(),
    repos: deps.config.repos.map((r) => r.repo),
    metricsEnabled: deps.config.metrics.enabled,
  }
}

async function readRunResource(runId: string, deps: MCPDependencies): Promise<unknown> {
  const runManager = new RunManager(deps.db)
  const run = runManager.getById(runId)
  if (!run) throw new Error(`Run not found: ${runId}`)
  return run
}

async function readLogsResource(runId: string, deps: MCPDependencies): Promise<unknown> {
  const events = deps.db
    .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(runId) as Array<{ id: number; event_type: string; phase: string | null; data: string | null; created_at: string }>

  return {
    runId,
    events: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      phase: e.phase,
      data: parseEventData(e.data),
      at: e.created_at,
    })),
  }
}

function readConfigResource(deps: MCPDependencies): unknown {
  // Sanitize: show env var names, not values
  return {
    version: deps.config.version,
    github: {
      tokenEnv: deps.config.github.tokenEnv,
      apiBaseUrl: deps.config.github.apiBaseUrl,
      pollIntervalSeconds: deps.config.github.pollIntervalSeconds,
    },
    storage: deps.config.storage,
    loop: deps.config.loop,
    security: deps.config.security,
    metrics: deps.config.metrics,
    mcp: deps.config.mcp,
    workerProfiles: Object.fromEntries(
      Object.entries(deps.config.workerProfiles).map(([name, profile]) => [
        name,
        { type: profile.type, command: profile.command, timeout: profile.workerTimeoutSeconds },
      ]),
    ),
    repos: deps.config.repos.map((r) => ({
      repo: r.repo,
      forge: r.forge,
      baseBranch: r.baseBranch,
      branchPrefix: r.branchPrefix,
    })),
  }
}

async function readMetricsResource(deps: MCPDependencies): Promise<unknown> {
  if (!deps.metrics) {
    return { enabled: false, message: 'Metrics not enabled' }
  }

  const registry = deps.metrics.getRegistry()
  const metricsJson = await registry.getMetricsAsJSON()
  return { enabled: true, metrics: metricsJson }
}

function parseEventData(data: string | null): unknown {
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return { raw: data, parseError: 'Invalid JSON in stored event payload' }
  }
}
