import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { MCPDependencies } from '../../mcp/server.js'
import { handleToolCall } from '../../mcp/tools/index.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { nowUtcIso } from '../../utils/time.js'
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
  const { deps, security, agentSessionManager, shellSessionManager } = ctx
  const runtimeDeps = resolveRuntimeDeps(deps)

  if (method === 'GET' && pathname === '/api/agent/sessions') {
    writeJson(res, 200, agentSessionManager.listSessions())
    return true
  }

  if (method === 'GET' && pathname === '/api/shell/sessions') {
    writeJson(res, 200, shellSessionManager.listSessions())
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

    const shellSessionEventsMatch = pathname.match(/^\/api\/shell\/sessions\/([^/]+)\/events$/)
    if (shellSessionEventsMatch) {
      const sessionId = decodeURIComponent(shellSessionEventsMatch[1] ?? '')
      const since = toBoundedInt(_searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(_searchParams.get('limit'), 200, 1, 1_000)
      try {
        writeJson(res, 200, shellSessionManager.getEvents(sessionId, since, limit))
      } catch (err) {
        const message = (err as Error).message
        const statusCode = message.startsWith('Session not found:') ? 404 : 400
        writeJson(res, statusCode, { error: message })
      }
      return true
    }

    const shellSessionDetailMatch = pathname.match(/^\/api\/shell\/sessions\/([^/]+)$/)
    if (shellSessionDetailMatch) {
      const sessionId = decodeURIComponent(shellSessionDetailMatch[1] ?? '')
      const session = shellSessionManager.getSession(sessionId)
      if (!session) {
        writeJson(res, 404, { error: `Session not found: ${sessionId}` })
        return true
      }
      writeJson(res, 200, { session })
      return true
    }
  }

  if (method === 'GET' && pathname === '/api/update-status') {
    const statusPath = resolve(homedir(), '.config', 'night-orch', 'update-status.json')
    try {
      const parsed = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>
      const status = {
        state: typeof parsed['state'] === 'string' ? parsed['state'] : 'idle',
        ...(typeof parsed['error'] === 'string' ? { error: parsed['error'] } : {}),
      }
      writeJson(res, 200, status)
    } catch {
      writeJson(res, 200, { state: 'idle' })
    }
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

  if (method === 'POST' && pathname === '/api/operations/update') {
    if (typeof process.send === 'function') {
      process.send({ type: 'update-requested' })
      writeJson(res, 200, { accepted: true, method: 'ipc' })
      return true
    }

    const dataDir = resolve(homedir(), '.config', 'night-orch')
    const triggerPath = resolve(dataDir, 'update-requested')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(triggerPath, nowUtcIso())
    writeJson(res, 200, { accepted: true, method: 'trigger-file' })
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

  if (method === 'POST' && pathname === '/api/shell/sessions') {
    const body = await readJsonBody(req)
    const cwd = toNonEmptyString(body['cwd'])
    const cols = toBoundedInt(body['cols'], NaN, 40, 400)
    const rows = toBoundedInt(body['rows'], NaN, 10, 240)

    try {
      const session = shellSessionManager.createSession({
        cwd,
        cols: Number.isNaN(cols) ? undefined : cols,
        rows: Number.isNaN(rows) ? undefined : rows,
      })
      writeJson(res, 200, { session })
    } catch (err) {
      writeJson(res, 400, { error: (err as Error).message })
    }
    return true
  }

  const shellSessionCloseMatch = pathname.match(/^\/api\/shell\/sessions\/([^/]+)$/)
  if (method === 'DELETE' && shellSessionCloseMatch) {
    const sessionId = decodeURIComponent(shellSessionCloseMatch[1] ?? '')
    try {
      const session = shellSessionManager.closeSession(sessionId)
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
