import type { MCPDependencies } from '../../mcp/server.js'
import { handleToolCall } from '../../mcp/tools/index.js'
import { handleResourceRead } from '../../mcp/resources/index.js'
import { loadTuiStats } from '../../state/stats.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { nowUtcIso } from '../../utils/time.js'
import type { RouteHandler } from './context.js'
import { writeJson, toBoundedInt } from '../server.js'
import { buildDashboardSnapshot, buildProjectsSnapshot } from '../snapshots.js'

export const handleRunRoutes: RouteHandler = async (_req, res, method, pathname, searchParams, ctx) => {
  const { deps, security } = ctx
  const runtimeDeps = resolveRuntimeDeps(deps)

  if (method === 'GET' && pathname === '/api/health') {
    writeJson(res, 200, { status: 'ok', now: nowUtcIso() })
    return true
  }

  if (method === 'GET' && pathname === '/api/dashboard') {
    const snapshot = await buildDashboardSnapshot(runtimeDeps)
    writeJson(res, 200, snapshot)
    return true
  }

  if (method === 'GET' && pathname === '/api/projects') {
    const snapshot = buildProjectsSnapshot(runtimeDeps)
    writeJson(res, 200, snapshot)
    return true
  }

  if (method === 'GET' && pathname === '/api/session') {
    writeJson(res, 200, {
      mutationToken: security.operatorAuthMode ? null : security.webMutationToken,
      operationsEnabled: ctx.operationsEnabled,
      requiresExternalAuth: security.operatorAuthMode,
      // Phase 2a: advertise the cookie-auth bootstrap endpoint so the
      // frontend can choose between auto-handed token (loopback mode)
      // and the token-entry dialog (operator auth mode).
      supportsSessionCookie: true,
    })
    return true
  }

  if (method === 'GET' && pathname === '/api/status') {
    const repo = searchParams.get('repo') ?? undefined
    const result = await handleToolCall('night-orch-status', { repo }, runtimeDeps)
    writeJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/api/runs') {
    const repo = searchParams.get('repo') ?? undefined
    const status = searchParams.get('status') ?? undefined
    const view = searchParams.get('view') ?? undefined
    const limit = toBoundedInt(searchParams.get('limit'), 20, 1, 500)
    const offset = toBoundedInt(searchParams.get('offset'), 0, 0, 100_000)
    const result = await handleToolCall('night-orch-list-runs', { repo, status, view, limit, offset }, runtimeDeps)
    writeJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/api/cost') {
    const days = toBoundedInt(searchParams.get('days'), 7, 1, 30)
    const result = await handleToolCall('night-orch-cost-report', { days }, runtimeDeps)
    writeJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/api/cost/health') {
    writeJson(res, 200, buildCostHealthReport(runtimeDeps.db))
    return true
  }

  if (method === 'GET' && pathname === '/api/stats') {
    writeJson(res, 200, loadTuiStats(runtimeDeps.db, { costModel: runtimeDeps.config.cost.model }))
    return true
  }

  if (method === 'GET' && pathname === '/api/config') {
    const result = await handleResourceRead('night-orch://config', runtimeDeps)
    writeJson(res, 200, result)
    return true
  }

  if (method === 'GET') {
    const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
    if (runDetailMatch) {
      const runId = decodeURIComponent(runDetailMatch[1] ?? '')
      const result = await handleToolCall('night-orch-run-detail', { runId }, runtimeDeps)
      writeJson(res, 200, result)
      return true
    }

    const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
    if (runEventsMatch) {
      const runId = decodeURIComponent(runEventsMatch[1] ?? '')
      const since = toBoundedInt(searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(searchParams.get('limit'), 100, 1, 200)
      const result = await handleToolCall('night-orch-stream-events', { runId, since, limit }, runtimeDeps)
      writeJson(res, 200, result)
      return true
    }

    const issueEventsMatch = pathname.match(/^\/api\/repos\/([^/]+)\/issues\/(\d+)\/events$/)
    if (issueEventsMatch) {
      const repo = decodeURIComponent(issueEventsMatch[1] ?? '')
      const issueNumber = Number.parseInt(issueEventsMatch[2] ?? '', 10)
      const since = toBoundedInt(searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(searchParams.get('limit'), 100, 1, 200)
      const result = await handleToolCall('night-orch-stream-events', { repo, issueNumber, since, limit }, runtimeDeps)
      writeJson(res, 200, result)
      return true
    }

    const repoIssuesMatch = pathname.match(/^\/api\/repos\/([^/]+)\/issues$/)
    if (repoIssuesMatch) {
      const repo = decodeURIComponent(repoIssuesMatch[1] ?? '')
      const filter = searchParams.get('filter') ?? 'all'
      const result = await handleToolCall('night-orch-list-issues', { repo, filter }, runtimeDeps)
      writeJson(res, 200, result)
      return true
    }
  }

  return false
}

function resolveRuntimeDeps(deps: MCPDependencies): MCPDependencies {
  return {
    ...deps,
    config: resolveConfigWithRuntimeSettings(deps.config, deps.db),
  }
}

/**
 * R4f: Cost-health report for the `/api/cost/health` endpoint.
 *
 * Returns per-source counts from the `run_cost_entries` ledger plus
 * the 24h fallback rate. Operators should see 100% `reported_cli`
 * (and maybe some `measured_api` once Phase 3 direct-LLM lands) in
 * the default configuration. Any non-zero `estimated_duration` count
 * means someone has flipped `cost.allowEstimatedDuration: true`
 * and the reported dollar amounts have degraded confidence for
 * those rows. The TUI/web UI should render an amber badge when
 * `fallbackRate24h > 0`.
 */
function buildCostHealthReport(db: MCPDependencies['db']): {
  reportedCli: number
  measuredApi: number
  estimatedDuration: number
  fallbackZero: number
  totalEntries: number
  last24h: {
    reportedCli: number
    measuredApi: number
    estimatedDuration: number
    fallbackZero: number
    totalEntries: number
    fallbackRate: number
  }
} {
  const allTimeRows = db
    .prepare(
      `SELECT token_source, COUNT(*) AS count
       FROM run_cost_entries
       GROUP BY token_source`,
    )
    .all() as Array<{ token_source: string; count: number }>

  const last24hRows = db
    .prepare(
      `SELECT token_source, COUNT(*) AS count
       FROM run_cost_entries
       WHERE datetime(created_at) >= datetime('now', '-1 day')
       GROUP BY token_source`,
    )
    .all() as Array<{ token_source: string; count: number }>

  const emptyBreakdown = () => ({
    reportedCli: 0,
    measuredApi: 0,
    estimatedDuration: 0,
    fallbackZero: 0,
    totalEntries: 0,
  })

  const applyRows = (
    rows: Array<{ token_source: string; count: number }>,
    target: ReturnType<typeof emptyBreakdown>,
  ) => {
    for (const row of rows) {
      target.totalEntries += row.count
      switch (row.token_source) {
        case 'reported_cli':
          target.reportedCli += row.count
          break
        case 'measured_api':
          target.measuredApi += row.count
          break
        case 'estimated_duration':
          target.estimatedDuration += row.count
          break
        case 'fallback_zero':
          target.fallbackZero += row.count
          break
        // Unknown tags are still counted toward totalEntries so the
        // operator sees that something unexpected is in the ledger.
      }
    }
  }

  const allTime = emptyBreakdown()
  applyRows(allTimeRows, allTime)

  const last24h = { ...emptyBreakdown(), fallbackRate: 0 }
  applyRows(last24hRows, last24h)
  const degraded24h = last24h.estimatedDuration + last24h.fallbackZero
  last24h.fallbackRate = last24h.totalEntries > 0 ? degraded24h / last24h.totalEntries : 0

  return { ...allTime, last24h }
}
