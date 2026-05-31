import type { MCPDependencies } from '../../mcp/server.js'
import { handleToolCall } from '../../mcp/tools/index.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { readPublicUpdateStatus, requestUpdateViaTriggerFile } from '../../supervisor/update-control.js'
import type { InteractiveAgentType } from '../agent-session.js'
import type { RouteHandler } from './context.js'
import {
  writeJson,
  readJsonBody,
  toBoundedInt,
  toNonEmptyString,
  toFiniteNumber,
  withMcpMutationAuth,
} from '../server.js'

export const handleOperationRoutes: RouteHandler = async (req, res, method, pathname, _searchParams, ctx) => {
  const { deps, security, agentSessionManager } = ctx
  const runtimeDeps = resolveRuntimeDeps(deps)

  if (method === 'GET' && pathname === '/api/agent/sessions') {
    writeJson(res, 200, agentSessionManager.listSessions())
    return true
  }

  if (method === 'GET') {
    const agentSessionEventsMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/events$/)
    if (agentSessionEventsMatch) {
      const sessionId = decodeURIComponent(agentSessionEventsMatch[1] ?? '')
      const since = toBoundedInt(_searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(_searchParams.get('limit'), 100, 1, 400)
      try {
        writeJson(res, 200, agentSessionManager.getEvents(sessionId, since, limit))
      } catch (err) {
        const message = (err as Error).message
        const statusCode = message.startsWith('Session not found:') ? 404 : 400
        writeJson(res, statusCode, { error: message })
      }
      return true
    }

    const agentSessionDetailMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/)
    if (agentSessionDetailMatch) {
      const sessionId = decodeURIComponent(agentSessionDetailMatch[1] ?? '')
      const session = agentSessionManager.getSession(sessionId)
      if (!session) {
        writeJson(res, 404, { error: `Session not found: ${sessionId}` })
        return true
      }
      writeJson(res, 200, { session })
      return true
    }

  }

  if (method === 'GET' && pathname === '/api/update-status') {
    writeJson(res, 200, await readPublicUpdateStatus())
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/poll') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-poll',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/sync') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-sync',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/cleanup') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-cleanup',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/labels-init') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])

    if (!repo) {
      writeJson(res, 400, { error: 'repo is required' })
      return true
    }

    const result = await handleToolCall(
      'night-orch-labels-init',
      withMcpMutationAuth(
        {
          repo,
          dryRun: Boolean(body['dryRun']),
        },
        security,
      ),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/retry') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)
    const strategy = parseUpdateStrategy(body['strategy'])

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return true
    }

    const result = await handleToolCall(
      'night-orch-retry',
      withMcpMutationAuth(
        {
          repo,
          issueNumber,
          resetPlan: Boolean(body['resetPlan']),
          fresh: Boolean(body['fresh']),
          ...(strategy ? { strategy } : {}),
        },
        security,
      ),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/rebase') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)
    const strategy = parseUpdateStrategy(body['strategy'])

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return true
    }

    const result = await handleToolCall(
      'night-orch-rebase',
      withMcpMutationAuth(
        {
          repo,
          issueNumber,
          check: body['check'] === undefined ? true : Boolean(body['check']),
          ...(strategy ? { strategy } : {}),
        },
        security,
      ),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/continue') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)
    const strategy = parseUpdateStrategy(body['strategy'])

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return true
    }

    const result = await handleToolCall(
      'night-orch-continue',
      withMcpMutationAuth(
        {
          repo,
          issueNumber,
          ...(strategy ? { strategy } : {}),
        },
        security,
      ),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/delete-entry') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return true
    }

    const result = await handleToolCall(
      'night-orch-delete-entry',
      withMcpMutationAuth(
        {
          repo,
          issueNumber,
          force: Boolean(body['force']),
          dryRun: Boolean(body['dryRun']),
        },
        security,
      ),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/daily-cost-override/set') {
    const body = await readJsonBody(req)
    const amountUsd = toFiniteNumber(body['amountUsd'])
    if (amountUsd === null || amountUsd <= 0) {
      writeJson(res, 400, { error: 'amountUsd must be a positive finite number' })
      return true
    }

    try {
      const result = await handleToolCall(
        'night-orch-daily-cost-override',
        withMcpMutationAuth({ amountUsd }, security),
        runtimeDeps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/daily-cost-override/clear') {
    try {
      const result = await handleToolCall(
        'night-orch-daily-cost-override',
        withMcpMutationAuth({ clear: true }, security),
        runtimeDeps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/cost-override/set') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)
    const amountUsd = toFiniteNumber(body['amountUsd'])

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return true
    }
    if (amountUsd === null || amountUsd <= 0) {
      writeJson(res, 400, { error: 'amountUsd must be a positive finite number' })
      return true
    }

    try {
      const result = await handleToolCall(
        'night-orch-cost-override',
        withMcpMutationAuth({ repo, issueNumber, amountUsd }, security),
        runtimeDeps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/cost-override/clear') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return true
    }

    try {
      const result = await handleToolCall(
        'night-orch-cost-override',
        withMcpMutationAuth({ repo, issueNumber, clear: true }, security),
        runtimeDeps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/cost-reset') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return true
    }

    try {
      const result = await handleToolCall(
        'night-orch-cost-reset',
        withMcpMutationAuth({ repo, issueNumber }, security),
        runtimeDeps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/daily-cost-reset') {
    try {
      const result = await handleToolCall(
        'night-orch-daily-cost-reset',
        withMcpMutationAuth({}, security),
        runtimeDeps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/operations/update') {
    if (typeof process.send === 'function') {
      process.send({ type: 'update-requested' })
      writeJson(res, 200, { accepted: true, method: 'ipc' })
      return true
    }

    writeJson(res, 200, await requestUpdateViaTriggerFile())
    return true
  }

  if (method === 'POST' && pathname === '/api/agent/sessions') {
    const body = await readJsonBody(req)
    const agentRaw = toNonEmptyString(body['agent'])
    const profileName = toNonEmptyString(body['profileName'])
    const cwd = toNonEmptyString(body['cwd'])

    if (agentRaw !== 'claude' && agentRaw !== 'codex') {
      writeJson(res, 400, { error: 'agent must be "claude" or "codex"' })
      return true
    }

    try {
      const session = agentSessionManager.createSession({
        agent: agentRaw as InteractiveAgentType,
        profileName,
        cwd,
      })
      writeJson(res, 200, { session })
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  const agentSessionMessageMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/)
  if (method === 'POST' && agentSessionMessageMatch) {
    const sessionId = decodeURIComponent(agentSessionMessageMatch[1] ?? '')
    const body = await readJsonBody(req)
    const prompt = toNonEmptyString(body['prompt'])
    if (!prompt) {
      writeJson(res, 400, { error: 'prompt is required' })
      return true
    }

    try {
      const result = agentSessionManager.sendPrompt(sessionId, prompt)
      writeJson(res, 200, result)
    } catch (err) {
      const message = (err as Error).message
      const statusCode = message.startsWith('Session not found:')
        ? 404
        : message.includes('running') || message.includes('closed')
          ? 409
          : 400
      writeJson(res, statusCode, { error: message })
    }
    return true
  }

  const agentSessionCloseMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/)
  if (method === 'DELETE' && agentSessionCloseMatch) {
    const sessionId = decodeURIComponent(agentSessionCloseMatch[1] ?? '')
    try {
      const session = agentSessionManager.closeSession(sessionId)
      writeJson(res, 200, { session })
    } catch (err) {
      const message = (err as Error).message
      const statusCode = message.startsWith('Session not found:')
        ? 404
        : message.includes('running')
          ? 409
          : 400
      writeJson(res, statusCode, { error: message })
    }
    return true
  }

  return false
}

function resolveRuntimeDeps(deps: MCPDependencies): MCPDependencies {
  return {
    ...deps,
    config: resolveConfigWithRuntimeSettings(deps.config, deps.db),
  }
}

function parseUpdateStrategy(value: unknown): 'merge' | 'rebase' | undefined {
  return value === 'merge' || value === 'rebase' ? value : undefined
}
