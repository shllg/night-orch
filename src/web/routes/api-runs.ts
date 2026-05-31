import type { MCPDependencies } from '../../mcp/server.js'
import { handleToolCall } from '../../mcp/tools/index.js'
import { handleResourceRead } from '../../mcp/resources/index.js'
import { loadTuiStats } from '../../state/stats.js'
import { loadCostHealthReport } from '../../state/cost-health.js'
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

  if (method === 'GET' && pathname === '/api/inbox') {
    const repo = searchParams.get('repo') ?? undefined
    const triage = searchParams.get('triage') ?? undefined
    const limit = toBoundedInt(searchParams.get('limit'), 20, 1, 500)
    const offset = toBoundedInt(searchParams.get('offset'), 0, 0, 100_000)
    const result = await handleToolCall('night-orch-list-inbox', { repo, triage, limit, offset }, runtimeDeps)
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
    writeJson(res, 200, loadCostHealthReport(runtimeDeps.db))
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
