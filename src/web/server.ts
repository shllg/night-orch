import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import type { MCPDependencies } from '../mcp/server.js'
import type { RepoConfig, WorkerProfile } from '../config/schema.js'
import { handleToolCall } from '../mcp/tools/index.js'
import { handleResourceRead } from '../mcp/resources/index.js'
import {
  InteractiveAgentSessionManager,
  type InteractiveAgentSessionEventList,
  type InteractiveAgentType,
} from './agent-session.js'
import {
  ShellSessionManager,
  type ShellSessionEventList,
} from './shell-session.js'
import { loadTuiStats } from '../state/stats.js'
import { getBuildInfo } from '../utils/build-info.js'
import { logger } from '../utils/logger.js'
import { sanitizeError } from '../utils/sanitize-error.js'
import { nowUtcIso } from '../utils/time.js'
import {
  listRuntimeSettings,
  resolveConfigWithRuntimeSettings,
  type RuntimeSettingSnapshot,
  RuntimeSettingInputError,
} from '../settings/runtime.js'
import { getSettingDefinition, resolveSettingYamlValue, type SettingValue } from '../settings/registry.js'

export interface WebServerOptions {
  host: string
  port: number
  allowedHosts?: string[]
  frontendDistPath?: string
  snapshotIntervalMs?: number
  operationsEnabled?: boolean
  rawConfig?: unknown
}

interface WsClientState {
  isAuthenticated: boolean
  runSubscriptions: Map<string, number>
  agentSessionSubscriptions: Map<string, number>
  shellSessionSubscriptions: Map<string, number>
}

interface DashboardSnapshot {
  generatedAt: string
  status: unknown
  runs: unknown
  cost: unknown
  build: {
    version: string
    gitSha: string | null
  }
  config: {
    repos: string[]
    pollIntervalSeconds: number
  }
  stats: ReturnType<typeof loadTuiStats>
}

interface SettingsSnapshot {
  generatedAt: string
  settings: SettingsSnapshotEntry[]
}

interface SettingsSnapshotEntry extends RuntimeSettingSnapshot {
  hasYamlValue: boolean
  yamlValue: SettingValue | null
}

type CommandSpec = string | string[]
type CommandWhen = 'always' | 'dedicated' | 'shared'

interface ProjectsSnapshot {
  generatedAt: string
  githubDefaults: {
    tokenEnv: string
    apiBaseUrl: string
  }
  workerProfiles: Record<string, ProjectWorkerProfileSummary>
  repos: ProjectRepoSummary[]
}

interface ProjectWorkerProfileSummary {
  type: string
  command: string
  args: string[]
  workerTimeoutSeconds: number
  minimalEnv: boolean
  runtimeWrapper: string | null
  envKeys: string[]
}

interface ProjectLabels {
  ready: string[]
  running: string
  blocked: string
  needsHuman: string
  reviewReady: string
  error: string
  retry: string
  planning: string
  mergeQueued: string
  merging: string
  mergeFailed: string
}

interface ProjectRepoSummary {
  repo: string
  forge: 'github' | 'forgejo'
  linkedProjects: string[]
  apiBaseUrl?: string
  tokenEnv?: string
  maxConcurrentRuns: number
  localPath: string
  baseBranch: string
  branchPrefix: string
  labels: ProjectLabels
  kanban?: {
    triggerLabel: string
    labels: ProjectLabels
  }
  labelConfig: Record<string, { color?: string; description?: string }>
  defaults: {
    planner: 'claude' | 'codex' | 'opencode'
    coder: 'claude' | 'codex' | 'opencode'
    reviewer: 'claude' | 'codex' | 'opencode'
    doneMode: 'pr-ready' | 'manual-only'
    notifyPriority: 'normal' | 'high'
    prMentions: string[]
  }
  environment?: {
    defaultMode: 'shared' | 'dedicated'
    dedicated?: {
      compose: {
        file: string
        services: string[]
        projectName: string
      }
      env: {
        copyFrom: string
        overrideKeys: string[]
        overrideFiles: string[]
      }
      healthcheck?: CommandSpec
      teardownOnComplete: boolean
    }
    shared?: {
      requireRunning: boolean
      healthcheck?: CommandSpec
    }
    bootstrap: Array<{
      command: CommandSpec
      when: CommandWhen
      failureHints?: Array<{
        contains: string
        message: string
        output: 'combined' | 'stdout' | 'stderr'
      }>
    }>
    cleanup: Array<{
      command: CommandSpec
      when: CommandWhen
      failureHints?: Array<{
        contains: string
        message: string
        output: 'combined' | 'stdout' | 'stderr'
      }>
    }>
  }
  verify: CommandSpec[]
  prompts: {
    plannerSystem: boolean
    coderSystem: boolean
    reviewerSystem: boolean
  }
  planning: {
    prdDirectory: string
  }
  selectors: {
    includeLabelsAny: string[]
    excludeLabelsAny: string[]
  }
  agents: Record<string, string>
  workflow?: string
  workflowByTriage?: {
    trivial?: string
    standard?: string
  }
  mergeQueue: {
    enabled: boolean
    batchSize: number
    mergeMethod: 'merge' | 'squash' | 'rebase'
    retryFlakyOnce: boolean
    requireApproval: boolean
    stagingBranchPrefix: string
  }
}

interface WebSecurityContext {
  allowedHostnames: Set<string>
  webMutationToken: string
  mcpMutationAuthToken?: string
  /** True when the web server is bound to a non-loopback address and the
   *  mutation token is operator-supplied rather than random-per-process. In
   *  this mode, GET /api/session must NOT disclose the token — the client
   *  must provide it out-of-band. */
  operatorAuthMode: boolean
}

type WebSocketCommand =
  | { type: 'subscribe-run-events'; runId: string; since?: number }
  | { type: 'unsubscribe-run-events'; runId: string }
  | { type: 'subscribe-agent-session-events'; sessionId: string; since?: number }
  | { type: 'unsubscribe-agent-session-events'; sessionId: string }
  | { type: 'subscribe-shell-session-events'; sessionId: string; since?: number }
  | { type: 'unsubscribe-shell-session-events'; sessionId: string }
  | { type: 'shell-input'; sessionId: string; data: string }
  | { type: 'shell-resize'; sessionId: string; cols: number; rows: number }
  | { type: 'refresh' }

const ONE_MEGABYTE = 1024 * 1024
const DEFAULT_SNAPSHOT_INTERVAL_MS = 3000
const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'
const BUILD_INFO = getBuildInfo()
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

export function resolveWebFrontendDistPath(explicitPath?: string): string {
  if (explicitPath) {
    return resolve(explicitPath)
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return resolve(moduleDir, '../../web/dist')
}

export async function startWebServer(
  deps: MCPDependencies,
  options: WebServerOptions,
): Promise<Server> {
  // Hard gate on non-loopback binds: the web server hands out a mutation
  // token via `/api/session` to any same-origin caller and offers
  // destructive endpoints (retry/cleanup/sync/etc) under that token. When
  // bound to a non-loopback address, require an operator-supplied auth
  // token env (`NIGHT_ORCH_WEB_AUTH_TOKEN`) so any single-origin XSS or
  // local process cannot trivially escalate to full write access.
  const bindHostName = normalizeHostname(options.host) ?? options.host
  const isLoopbackBind =
    bindHostName === '127.0.0.1'
    || bindHostName === '::1'
    || bindHostName === 'localhost'
    || bindHostName === ''
  if (!isLoopbackBind && !process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']) {
    throw new Error(
      `night-orch web refuses to bind to non-loopback host "${options.host}" without NIGHT_ORCH_WEB_AUTH_TOKEN set. `
      + 'Either bind to 127.0.0.1 / ::1 or provide an out-of-band auth token via that env var.',
    )
  }

  const security = createWebSecurityContext(deps, options)
  const operationsEnabled = options.operationsEnabled ?? true
  const agentSessionManager = new InteractiveAgentSessionManager(deps.config, {
    workspacePath: resolveAgentSessionWorkspacePath(deps),
  })
  const shellSessionManager = new ShellSessionManager()
  const frontendDistPath = resolveWebFrontendDistPath(options.frontendDistPath)
  const hasFrontendAssets = existsSync(resolve(frontendDistPath, 'index.html'))

  if (!hasFrontendAssets) {
    logger.warn(
      { frontendDistPath },
      'Web frontend assets not found. Build with `pnpm web:build` before starting `night-orch web`.',
    )
  }

  const wsServer = new WebSocketServer({ noServer: true })
  const clients = new Map<WebSocket, WsClientState>()

  const httpServer = createServer(async (req, res) => {
    try {
      const requestUrl = getRequestUrl(req)

      if (requestUrl.pathname.startsWith('/api/')) {
        if (!isAllowedRequestHost(req, security)) {
          writeJson(res, 403, { error: 'Forbidden host' })
          return
        }
        await handleApiRequest(
          req,
          res,
          requestUrl,
          deps,
          security,
          operationsEnabled,
          options.rawConfig,
          agentSessionManager,
          shellSessionManager,
        )
        return
      }

      if (requestUrl.pathname === '/ws') {
        writeJson(res, 426, { error: 'Upgrade Required' })
        return
      }

      await serveFrontend(req, res, requestUrl.pathname, frontendDistPath, hasFrontendAssets)
    } catch (err) {
      if (res.headersSent) {
        return
      }

      const sanitized = sanitizeError(err)
      const status = isClientRequestError(sanitized.message)
        ? 400
        : isAuthorizationError(sanitized.message)
          ? 403
          : 500
      if (status >= 500) {
        logger.warn({ err: sanitized }, 'Web request failed')
      }
      writeJson(res, status, { error: sanitized.message })
    }
  })

  httpServer.on('upgrade', (req, socket, head) => {
    let requestUrl: URL
    try {
      requestUrl = getRequestUrl(req)
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }

    if (requestUrl.pathname !== '/ws') {
      socket.destroy()
      return
    }

    if (!isAllowedRequestHost(req, security)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }

    if (!hasAllowedOrigin(req, security, false)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }

    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit('connection', ws, req)
    })
  })

  wsServer.on('connection', (ws, req) => {
    const isAuthenticated = resolveWebSocketAuthenticationState(req, security)
    const state: WsClientState = {
      isAuthenticated,
      runSubscriptions: new Map(),
      agentSessionSubscriptions: new Map(),
      shellSessionSubscriptions: new Map(),
    }
    clients.set(ws, state)

    sendWebsocket(ws, {
      type: 'connected',
      payload: { timestamp: nowUtcIso() },
    })

    ws.on('message', (raw) => {
      const decoded = decodeWsMessage(raw)
      if (decoded === null) {
        sendWebsocket(ws, { type: 'error', error: 'Unsupported websocket payload type' })
        return
      }
      void handleWsMessage(ws, state, decoded, deps, agentSessionManager, shellSessionManager)
    })

    ws.on('close', () => {
      clients.delete(ws)
    })
  })

  const snapshotIntervalMs = Math.max(1000, Math.floor(options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS))
  let tickInFlight = false

  const publishTick = async (): Promise<void> => {
    if (tickInFlight) return
    tickInFlight = true
    try {
      const snapshot = await buildDashboardSnapshot(deps)
      const snapshotMessage = JSON.stringify({ type: 'snapshot', payload: snapshot })

      for (const ws of clients.keys()) {
        if (ws.readyState !== WebSocket.OPEN) continue
        ws.send(snapshotMessage)
      }

      for (const [ws, state] of clients.entries()) {
        if (ws.readyState !== WebSocket.OPEN) continue
        await publishRunSubscriptions(ws, state, deps)
        publishAgentSessionSubscriptions(ws, state, agentSessionManager)
        publishShellSessionSubscriptions(ws, state, shellSessionManager)
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to publish websocket snapshot tick')
    } finally {
      tickInFlight = false
    }
  }

  const interval = setInterval(() => {
    void publishTick()
  }, snapshotIntervalMs)
  interval.unref()

  const stopAgentSessionStreaming = agentSessionManager.onSessionEvent((sessionId) => {
    for (const [ws, state] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (!state.agentSessionSubscriptions.has(sessionId)) continue
      publishAgentSessionSubscriptions(ws, state, agentSessionManager)
    }
  })
  const stopShellSessionStreaming = shellSessionManager.onSessionEvent((sessionId) => {
    for (const [ws, state] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (!state.shellSessionSubscriptions.has(sessionId)) continue
      publishShellSessionSubscriptions(ws, state, shellSessionManager)
    }
  })

  httpServer.on('close', () => {
    stopAgentSessionStreaming()
    stopShellSessionStreaming()
    shellSessionManager.closeAll()
    clearInterval(interval)
    for (const ws of wsServer.clients) {
      ws.close()
    }
    wsServer.close()
  })

  await new Promise<void>((resolveStart, rejectStart) => {
    httpServer.once('error', rejectStart)
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', rejectStart)
      logger.info({ host: options.host, port: options.port }, 'Web server started')
      resolveStart()
    })
  })

  await publishTick()

  return httpServer
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  deps: MCPDependencies,
  security: WebSecurityContext,
  operationsEnabled: boolean,
  rawConfig: unknown,
  agentSessionManager: InteractiveAgentSessionManager,
  shellSessionManager: ShellSessionManager,
): Promise<void> {
  const method = req.method ?? 'GET'
  const { pathname, searchParams } = requestUrl
  const runtimeDeps: MCPDependencies = {
    ...deps,
    config: resolveConfigWithRuntimeSettings(deps.config, deps.db),
  }

  if (method === 'GET' && pathname.startsWith('/api/shell/')) {
    const shellReadGuardFailure = validateShellReadRequest(req, security)
    if (shellReadGuardFailure) {
      writeJson(res, shellReadGuardFailure.statusCode, { error: shellReadGuardFailure.error })
      return
    }
  }

  if ((method === 'POST' || method === 'DELETE')
    && (pathname.startsWith('/api/operations/')
      || pathname.startsWith('/api/agent/')
      || pathname.startsWith('/api/shell/'))) {
    // Update is a supervisor operation — always allowed regardless of attach/standalone mode.
    if (!operationsEnabled && pathname !== '/api/operations/update') {
      writeJson(res, 409, { error: 'Web operations are disabled by server policy.' })
      return
    }

    const guardFailure = validateMutationRequest(req, security)
    if (guardFailure) {
      writeJson(res, guardFailure.statusCode, { error: guardFailure.error })
      return
    }
  }

  if (method === 'GET' && pathname === '/api/health') {
    writeJson(res, 200, { status: 'ok', now: nowUtcIso() })
    return
  }

  if (method === 'GET' && pathname === '/api/dashboard') {
    const snapshot = await buildDashboardSnapshot(runtimeDeps)
    writeJson(res, 200, snapshot)
    return
  }

  if (method === 'GET' && pathname === '/api/projects') {
    const snapshot = buildProjectsSnapshot(runtimeDeps)
    writeJson(res, 200, snapshot)
    return
  }

  if (method === 'GET' && pathname === '/api/settings') {
    const snapshot = buildSettingsSnapshot(deps, rawConfig)
    writeJson(res, 200, snapshot)
    return
  }

  if (method === 'GET' && pathname === '/api/session') {
    // When the server is bound to a non-loopback address with an operator-
    // supplied auth token, we must NOT hand it out via HTTP — the client
    // must provide it out-of-band. For loopback, disclosure is low-risk.
    writeJson(res, 200, {
      mutationToken: security.operatorAuthMode ? null : security.webMutationToken,
      operationsEnabled,
      requiresExternalAuth: security.operatorAuthMode,
    })
    return
  }

  if (method === 'GET' && pathname === '/api/agent/sessions') {
    writeJson(res, 200, agentSessionManager.listSessions())
    return
  }

  if (method === 'GET' && pathname === '/api/shell/sessions') {
    writeJson(res, 200, shellSessionManager.listSessions())
    return
  }

  if (method === 'GET' && pathname === '/api/status') {
    const repo = searchParams.get('repo') ?? undefined
    const result = await handleToolCall('night-orch-status', { repo }, runtimeDeps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET' && pathname === '/api/runs') {
    const repo = searchParams.get('repo') ?? undefined
    const status = searchParams.get('status') ?? undefined
    const limit = toBoundedInt(searchParams.get('limit'), 50, 1, 500)
    const result = await handleToolCall('night-orch-list-runs', { repo, status, limit }, runtimeDeps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET' && pathname === '/api/cost') {
    const days = toBoundedInt(searchParams.get('days'), 7, 1, 30)
    const result = await handleToolCall('night-orch-cost-report', { days }, runtimeDeps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET' && pathname === '/api/stats') {
    writeJson(res, 200, loadTuiStats(runtimeDeps.db, { costModel: runtimeDeps.config.cost.model }))
    return
  }

  if (method === 'GET' && pathname === '/api/config') {
    const result = await handleResourceRead('night-orch://config', runtimeDeps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET') {
    const agentSessionEventsMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/events$/)
    if (agentSessionEventsMatch) {
      const sessionId = decodeURIComponent(agentSessionEventsMatch[1] ?? '')
      const since = toBoundedInt(searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(searchParams.get('limit'), 100, 1, 400)
      try {
        writeJson(res, 200, agentSessionManager.getEvents(sessionId, since, limit))
      } catch (err) {
        const message = (err as Error).message
        const statusCode = message.startsWith('Session not found:') ? 404 : 400
        writeJson(res, statusCode, { error: message })
      }
      return
    }

    const agentSessionDetailMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/)
    if (agentSessionDetailMatch) {
      const sessionId = decodeURIComponent(agentSessionDetailMatch[1] ?? '')
      const session = agentSessionManager.getSession(sessionId)
      if (!session) {
        writeJson(res, 404, { error: `Session not found: ${sessionId}` })
        return
      }
      writeJson(res, 200, { session })
      return
    }

    const shellSessionEventsMatch = pathname.match(/^\/api\/shell\/sessions\/([^/]+)\/events$/)
    if (shellSessionEventsMatch) {
      const sessionId = decodeURIComponent(shellSessionEventsMatch[1] ?? '')
      const since = toBoundedInt(searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(searchParams.get('limit'), 200, 1, 1_000)
      try {
        writeJson(res, 200, shellSessionManager.getEvents(sessionId, since, limit))
      } catch (err) {
        const message = (err as Error).message
        const statusCode = message.startsWith('Session not found:') ? 404 : 400
        writeJson(res, statusCode, { error: message })
      }
      return
    }

    const shellSessionDetailMatch = pathname.match(/^\/api\/shell\/sessions\/([^/]+)$/)
    if (shellSessionDetailMatch) {
      const sessionId = decodeURIComponent(shellSessionDetailMatch[1] ?? '')
      const session = shellSessionManager.getSession(sessionId)
      if (!session) {
        writeJson(res, 404, { error: `Session not found: ${sessionId}` })
        return
      }
      writeJson(res, 200, { session })
      return
    }

    const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
    if (runDetailMatch) {
      const runId = decodeURIComponent(runDetailMatch[1] ?? '')
      const result = await handleToolCall('night-orch-run-detail', { runId }, runtimeDeps)
      writeJson(res, 200, result)
      return
    }

    const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
    if (runEventsMatch) {
      const runId = decodeURIComponent(runEventsMatch[1] ?? '')
      const since = toBoundedInt(searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(searchParams.get('limit'), 100, 1, 200)
      const result = await handleToolCall('night-orch-stream-events', { runId, since, limit }, runtimeDeps)
      writeJson(res, 200, result)
      return
    }

    const repoIssuesMatch = pathname.match(/^\/api\/repos\/([^/]+)\/issues$/)
    if (repoIssuesMatch) {
      const repo = decodeURIComponent(repoIssuesMatch[1] ?? '')
      const filter = searchParams.get('filter') ?? 'all'
      const result = await handleToolCall('night-orch-list-issues', { repo, filter }, runtimeDeps)
      writeJson(res, 200, result)
      return
    }
  }

  if (method === 'POST' && pathname === '/api/operations/poll') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-poll',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return
  }

  if (method === 'POST' && pathname === '/api/operations/sync') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-sync',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return
  }

  if (method === 'POST' && pathname === '/api/operations/cleanup') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-cleanup',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      runtimeDeps,
    )
    writeJson(res, 200, result)
    return
  }

  if (method === 'POST' && pathname === '/api/operations/labels-init') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])

    if (!repo) {
      writeJson(res, 400, { error: 'repo is required' })
      return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/retry') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/rebase') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/continue') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/delete-entry') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/daily-cost-override/set') {
    const body = await readJsonBody(req)
    const amountUsd = toFiniteNumber(body['amountUsd'])
    if (amountUsd === null || amountUsd <= 0) {
      writeJson(res, 400, { error: 'amountUsd must be a positive finite number' })
      return
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
    return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/cost-override/set') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)
    const amountUsd = toFiniteNumber(body['amountUsd'])

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return
    }
    if (amountUsd === null || amountUsd <= 0) {
      writeJson(res, 400, { error: 'amountUsd must be a positive finite number' })
      return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/cost-override/clear') {
    const body = await readJsonBody(req)
    const repo = toNonEmptyString(body['repo'])
    const issueNumber = toBoundedInt(body['issueNumber'], NaN, 1, Number.MAX_SAFE_INTEGER)

    if (!repo || Number.isNaN(issueNumber)) {
      writeJson(res, 400, { error: 'repo and issueNumber are required' })
      return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/settings/set') {
    const body = await readJsonBody(req)
    const key = toNonEmptyString(body['key'])
    const value = body['value']

    if (!key || value === undefined) {
      writeJson(res, 400, { error: 'key and value are required' })
      return
    }

    try {
      const result = await handleToolCall(
        'night-orch-set-setting',
        withMcpMutationAuth({ key, value }, security),
        deps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      if (isRuntimeSettingInputError(err)) {
        writeJson(res, 400, { error: (err as Error).message })
        return
      }
      throw err
    }
    return
  }

  if (method === 'POST' && pathname === '/api/operations/settings/clear') {
    const body = await readJsonBody(req)
    const key = toNonEmptyString(body['key'])

    if (!key) {
      writeJson(res, 400, { error: 'key is required' })
      return
    }

    try {
      const result = await handleToolCall(
        'night-orch-clear-setting',
        withMcpMutationAuth({ key }, security),
        deps,
      )
      writeJson(res, 200, result)
    } catch (err) {
      if (isRuntimeSettingInputError(err)) {
        writeJson(res, 400, { error: (err as Error).message })
        return
      }
      throw err
    }
    return
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
    return
  }

  if (method === 'POST' && pathname === '/api/operations/update') {
    // Try IPC first (running under supervisor)
    if (typeof process.send === 'function') {
      process.send({ type: 'update-requested' })
      writeJson(res, 200, { accepted: true, method: 'ipc' })
      return
    }

    // Fallback: trigger file
    const dataDir = resolve(homedir(), '.config', 'night-orch')
    const triggerPath = resolve(dataDir, 'update-requested')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(triggerPath, nowUtcIso())
    writeJson(res, 200, { accepted: true, method: 'trigger-file' })
    return
  }

  if (method === 'POST' && pathname === '/api/agent/sessions') {
    const body = await readJsonBody(req)
    const agentRaw = toNonEmptyString(body['agent'])
    const profileName = toNonEmptyString(body['profileName'])
    const cwd = toNonEmptyString(body['cwd'])

    if (agentRaw !== 'claude' && agentRaw !== 'codex') {
      writeJson(res, 400, { error: 'agent must be "claude" or "codex"' })
      return
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
    return
  }

  const agentSessionMessageMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/)
  if (method === 'POST' && agentSessionMessageMatch) {
    const sessionId = decodeURIComponent(agentSessionMessageMatch[1] ?? '')
    const body = await readJsonBody(req)
    const prompt = toNonEmptyString(body['prompt'])
    if (!prompt) {
      writeJson(res, 400, { error: 'prompt is required' })
      return
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
    return
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
    return
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
    return
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
    return
  }

  writeJson(res, 404, { error: `Unknown API route: ${method} ${pathname}` })
}

async function serveFrontend(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  frontendDistPath: string,
  hasFrontendAssets: boolean,
): Promise<void> {
  const method = req.method ?? 'GET'

  if (method !== 'GET' && method !== 'HEAD') {
    writeJson(res, 405, { error: 'Method not allowed' })
    return
  }

  if (!hasFrontendAssets) {
    writeJson(res, 503, {
      error: 'Frontend assets not available',
      hint: 'Run `pnpm web:build` to build the frontend assets.',
    })
    return
  }

  const relativePath = pathname === '/' ? '/index.html' : pathname
  const targetPath = resolve(frontendDistPath, `.${relativePath}`)

  // Path-traversal guard: `targetPath.startsWith(frontendDistPath)` alone
  // is insufficient — a sibling directory such as `frontendDistPath` +
  // "-stash" would pass. Require exact match or a true subdirectory path.
  if (targetPath !== frontendDistPath && !targetPath.startsWith(frontendDistPath + sep)) {
    writeJson(res, 403, { error: 'Forbidden path' })
    return
  }

  const candidatePath = await pickExistingFile(targetPath)
  if (!candidatePath && extname(relativePath) !== '') {
    writeJson(res, 404, { error: 'Not found' })
    return
  }

  const filePath = candidatePath ?? resolve(frontendDistPath, 'index.html')

  try {
    const body = await readFile(filePath)
    const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
    const isIndex = filePath.endsWith('/index.html')
    const cacheControl = isIndex ? 'no-cache' : 'public, max-age=31536000, immutable'

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    })

    if (method === 'HEAD') {
      res.end()
      return
    }

    res.end(body)
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to serve frontend asset')
    writeJson(res, 500, { error: 'Failed to read frontend asset' })
  }
}

async function pickExistingFile(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path)
    if (metadata.isFile()) {
      return path
    }
  } catch {
    // not found
  }
  return null
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > ONE_MEGABYTE) {
      throw new Error('Request body too large')
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) {
    return {}
  }

  const body = Buffer.concat(chunks).toString('utf-8').trim()
  if (!body) {
    return {}
  }

  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    throw new Error(`Invalid JSON body: ${(err as Error).message}`)
  }
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost')
}

function validateMutationRequest(
  req: IncomingMessage,
  security: WebSecurityContext,
): { statusCode: number; error: string } | null {
  if (!isAllowedRequestHost(req, security)) {
    return { statusCode: 403, error: 'Forbidden host' }
  }

  if (!hasAllowedOrigin(req, security, true)) {
    return { statusCode: 403, error: 'Forbidden origin' }
  }

  const intent = getSingleHeaderValue(req.headers[MUTATION_INTENT_HEADER])
  if (intent !== MUTATION_INTENT_VALUE) {
    return { statusCode: 403, error: `Missing required header: ${MUTATION_INTENT_HEADER}` }
  }

  const contentType = getSingleHeaderValue(req.headers['content-type'])
  if (!contentType || !isJsonContentType(contentType)) {
    return { statusCode: 415, error: 'Content-Type must be application/json' }
  }

  const webToken = getSingleHeaderValue(req.headers[WEB_AUTH_TOKEN_HEADER])
  if (!webToken) {
    return { statusCode: 401, error: `Missing required header: ${WEB_AUTH_TOKEN_HEADER}` }
  }

  if (!isMatchingToken(webToken, security.webMutationToken)) {
    return { statusCode: 403, error: 'Invalid web auth token' }
  }

  return null
}

function validateShellReadRequest(
  req: IncomingMessage,
  security: WebSecurityContext,
): { statusCode: number; error: string } | null {
  const webToken = getSingleHeaderValue(req.headers[WEB_AUTH_TOKEN_HEADER])
  if (!webToken) {
    return { statusCode: 401, error: `Missing required header: ${WEB_AUTH_TOKEN_HEADER}` }
  }

  if (!isMatchingToken(webToken, security.webMutationToken)) {
    return { statusCode: 403, error: 'Invalid web auth token' }
  }

  return null
}

function hasAllowedOrigin(req: IncomingMessage, security: WebSecurityContext, allowMissingOrigin: boolean): boolean {
  const originHeader = getSingleHeaderValue(req.headers.origin)
  if (!originHeader) {
    return allowMissingOrigin
  }

  let originUrl: URL
  try {
    originUrl = new URL(originHeader)
  } catch {
    return false
  }

  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return false
  }

  return security.allowedHostnames.has(originUrl.hostname.toLowerCase())
}

function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase()
  return normalized === 'application/json'
}

function getSingleHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

function withMcpMutationAuth(
  args: Record<string, unknown>,
  security: WebSecurityContext,
): Record<string, unknown> {
  if (!security.mcpMutationAuthToken) {
    return args
  }
  return {
    ...args,
    authToken: security.mcpMutationAuthToken,
  }
}

function createWebSecurityContext(deps: MCPDependencies, options: WebServerOptions): WebSecurityContext {
  // When bound to a non-loopback address, the operator-supplied env var
  // IS the mutation token. The startup guard in startWebServer() ensures
  // the env var is set before we get here. Using it directly means the
  // /api/session endpoint can refuse to disclose it — the operator gives
  // the token to trusted clients out-of-band (browser extension, curl
  // header, etc).
  //
  // For loopback binds, keep the random-per-process token and disclose it
  // via /api/session as before — the risk is low when only local processes
  // can reach the server.
  const operatorToken = process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
  const bindHostName = normalizeHostname(options.host) ?? options.host
  const isLoopback =
    bindHostName === '127.0.0.1'
    || bindHostName === '::1'
    || bindHostName === 'localhost'
    || bindHostName === ''
  const operatorAuthMode = !isLoopback && !!operatorToken

  return {
    allowedHostnames: resolveAllowedHostnames(options.host, options.allowedHosts ?? []),
    webMutationToken: operatorAuthMode ? operatorToken : randomBytes(24).toString('base64url'),
    mcpMutationAuthToken: resolveMcpMutationAuthToken(deps),
    operatorAuthMode,
  }
}

function resolveAllowedHostnames(bindHost: string, configuredAllowedHosts: string[]): Set<string> {
  const hostnames = new Set<string>()

  const bindHostName = normalizeHostname(bindHost)
  if (bindHostName && bindHostName !== '0.0.0.0' && bindHostName !== '::') {
    addAllowedHostname(hostnames, bindHostName)
  }

  for (const rawHost of configuredAllowedHosts) {
    const normalized = normalizeHostname(rawHost)
    if (!normalized) continue
    addAllowedHostname(hostnames, normalized)
  }

  if (hostnames.size === 0) {
    throw new Error(
      'No allowed web hosts configured. Use a concrete --host or provide one or more --allowed-host values.',
    )
  }

  return hostnames
}

function addAllowedHostname(allowedHostnames: Set<string>, hostname: string): void {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    allowedHostnames.add('localhost')
    allowedHostnames.add('127.0.0.1')
    allowedHostnames.add('::1')
    return
  }
  allowedHostnames.add(hostname)
}

function normalizeHostname(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const candidates = trimmed.includes('://')
    ? [trimmed]
    : [
        `http://${trimmed}`,
        ...(trimmed.includes(':') && !trimmed.startsWith('[') ? [`http://[${trimmed}]`] : []),
      ]

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      const hostname = parsed.hostname.toLowerCase()
      if (hostname.length > 0) {
        return hostname
      }
    } catch {
      // try next parse candidate
    }
  }

  return null
}

function isAllowedRequestHost(req: IncomingMessage, security: WebSecurityContext): boolean {
  const hostHeader = getSingleHeaderValue(req.headers.host)
  if (!hostHeader) {
    return false
  }

  const hostname = normalizeHostname(hostHeader)
  if (!hostname) {
    return false
  }

  return security.allowedHostnames.has(hostname)
}

function resolveMcpMutationAuthToken(deps: MCPDependencies): string | undefined {
  const tokenEnv = deps.config.mcp.authTokenEnv
  if (!tokenEnv) {
    return undefined
  }

  const token = process.env[tokenEnv]
  if (!token) {
    throw new Error(`MCP auth token env var ${tokenEnv} is configured but not set`)
  }

  return token
}

function resolveAgentSessionWorkspacePath(deps: MCPDependencies): string {
  const configuredRoot = deps.config.storage.worktreeRoot
  if (configuredRoot.trim().length === 0) {
    return process.cwd()
  }
  return resolve(configuredRoot)
}

function isMatchingToken(providedToken: string, expectedToken: string): boolean {
  const providedHash = createHash('sha256').update(providedToken).digest()
  const expectedHash = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

function rejectUpgrade(
  socket: { write: (chunk: string) => unknown; destroy: () => void },
  statusCode: number,
  message: string,
): void {
  const payload = `${message}\n`
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      '\r\n' +
      payload,
  )
  socket.destroy()
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function toBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : NaN

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

async function buildDashboardSnapshot(deps: MCPDependencies): Promise<DashboardSnapshot> {
  const runtimeConfig = resolveConfigWithRuntimeSettings(deps.config, deps.db)
  const runtimeDeps: MCPDependencies = {
    ...deps,
    config: runtimeConfig,
  }
  const [status, runs, cost] = await Promise.all([
    handleToolCall('night-orch-status', {}, runtimeDeps),
    handleToolCall('night-orch-list-runs', { limit: 100 }, runtimeDeps),
    handleToolCall('night-orch-cost-report', { days: 7 }, runtimeDeps),
  ])

  return {
    generatedAt: nowUtcIso(),
    status,
    runs,
    cost,
    build: BUILD_INFO,
    config: {
      repos: runtimeConfig.repos.map((repo) => repo.repo),
      pollIntervalSeconds: runtimeConfig.github.pollIntervalSeconds,
    },
    stats: loadTuiStats(runtimeDeps.db, { costModel: runtimeConfig.cost.model }),
  }
}

function buildProjectsSnapshot(deps: MCPDependencies): ProjectsSnapshot {
  return {
    generatedAt: nowUtcIso(),
    githubDefaults: {
      tokenEnv: deps.config.github.tokenEnv,
      apiBaseUrl: deps.config.github.apiBaseUrl,
    },
    workerProfiles: Object.fromEntries(
      Object.entries(deps.config.workerProfiles).map(([name, profile]) => [
        name,
        sanitizeWorkerProfile(profile),
      ]),
    ),
    repos: deps.config.repos.map((repo) => sanitizeProjectRepo(repo)),
  }
}

function buildSettingsSnapshot(deps: MCPDependencies, rawConfig: unknown): SettingsSnapshot {
  const runtimeSettings = listRuntimeSettings(deps.config, deps.db)

  return {
    generatedAt: nowUtcIso(),
    settings: runtimeSettings.map((setting) => {
      const definition = getSettingDefinition(setting.key)
      if (!definition) {
        return {
          ...setting,
          hasYamlValue: false,
          yamlValue: null,
        }
      }

      const { hasYamlValue, yamlValue } = resolveSettingYamlValue(definition, rawConfig, deps.config)
      return {
        ...setting,
        hasYamlValue,
        yamlValue,
      }
    }),
  }
}

function sanitizeWorkerProfile(profile: WorkerProfile): ProjectWorkerProfileSummary {
  return {
    type: profile.type,
    command: profile.command,
    args: [...profile.args],
    workerTimeoutSeconds: profile.workerTimeoutSeconds,
    minimalEnv: profile.minimalEnv,
    runtimeWrapper: profile.runtimeWrapper,
    envKeys: Object.keys(profile.env),
  }
}

function sanitizeProjectRepo(repo: RepoConfig): ProjectRepoSummary {
  return {
    repo: repo.repo,
    forge: repo.forge,
    linkedProjects: [...repo.linkedProjects],
    apiBaseUrl: repo.apiBaseUrl,
    tokenEnv: repo.tokenEnv,
    maxConcurrentRuns: repo.maxConcurrentRuns,
    localPath: repo.localPath,
    baseBranch: repo.baseBranch,
    branchPrefix: repo.branchPrefix,
    labels: sanitizeLabels(repo.labels),
    ...(repo.kanban
      ? {
          kanban: {
            triggerLabel: repo.kanban.triggerLabel,
            labels: sanitizeLabels(repo.kanban.labels),
          },
        }
      : {}),
    labelConfig: Object.fromEntries(
      Object.entries(repo.labelConfig).map(([label, config]) => [
        label,
        {
          ...(config.color ? { color: config.color } : {}),
          ...(config.description ? { description: config.description } : {}),
        },
      ]),
    ),
    defaults: {
      planner: repo.defaults.planner,
      coder: repo.defaults.coder,
      reviewer: repo.defaults.reviewer,
      doneMode: repo.defaults.doneMode,
      notifyPriority: repo.defaults.notifyPriority,
      prMentions: [...repo.defaults.prMentions],
    },
    ...(repo.environment ? { environment: sanitizeEnvironment(repo.environment) } : {}),
    verify: repo.verify.map((command) => copyCommandSpec(command)),
    prompts: {
      plannerSystem: Boolean(repo.prompts?.plannerSystem),
      coderSystem: Boolean(repo.prompts?.coderSystem),
      reviewerSystem: Boolean(repo.prompts?.reviewerSystem),
    },
    planning: {
      prdDirectory: repo.planning.prdDirectory,
    },
    selectors: {
      includeLabelsAny: [...repo.selectors.includeLabelsAny],
      excludeLabelsAny: [...repo.selectors.excludeLabelsAny],
    },
    agents: { ...repo.agents },
    ...(repo.workflow ? { workflow: repo.workflow } : {}),
    ...(repo.workflowByTriage ? { workflowByTriage: { ...repo.workflowByTriage } } : {}),
    mergeQueue: {
      enabled: repo.mergeQueue.enabled,
      batchSize: repo.mergeQueue.batchSize,
      mergeMethod: repo.mergeQueue.mergeMethod,
      retryFlakyOnce: repo.mergeQueue.retryFlakyOnce,
      requireApproval: repo.mergeQueue.requireApproval,
      stagingBranchPrefix: repo.mergeQueue.stagingBranchPrefix,
    },
  }
}

function sanitizeEnvironment(environment: NonNullable<RepoConfig['environment']>): NonNullable<ProjectRepoSummary['environment']> {
  return {
    defaultMode: environment.defaultMode,
    ...(environment.dedicated
      ? {
          dedicated: {
            compose: {
              file: environment.dedicated.compose.file,
              services: [...environment.dedicated.compose.services],
              projectName: environment.dedicated.compose.projectName,
            },
            env: {
              copyFrom: environment.dedicated.env.copyFrom,
              overrideKeys: Object.keys(environment.dedicated.env.overrides),
              overrideFiles: [...environment.dedicated.env.overrideFiles],
            },
            ...(environment.dedicated.healthcheck
              ? { healthcheck: copyCommandSpec(environment.dedicated.healthcheck) }
              : {}),
            teardownOnComplete: environment.dedicated.teardownOnComplete,
          },
        }
      : {}),
    ...(environment.shared
      ? {
          shared: {
            requireRunning: environment.shared.requireRunning,
            ...(environment.shared.healthcheck
              ? { healthcheck: copyCommandSpec(environment.shared.healthcheck) }
              : {}),
          },
        }
      : {}),
    bootstrap: environment.bootstrap.map((step) => ({
      when: step.when,
      command: copyCommandSpec(step.command),
      ...(step.failureHints && step.failureHints.length > 0
        ? {
            failureHints: step.failureHints.map((hint) => ({
              contains: hint.contains,
              message: hint.message,
              output: hint.output,
            })),
          }
        : {}),
    })),
    cleanup: environment.cleanup.map((step) => ({
      when: step.when,
      command: copyCommandSpec(step.command),
      ...(step.failureHints && step.failureHints.length > 0
        ? {
            failureHints: step.failureHints.map((hint) => ({
              contains: hint.contains,
              message: hint.message,
              output: hint.output,
            })),
          }
        : {}),
    })),
  }
}

function sanitizeLabels(labels: RepoConfig['labels']): ProjectLabels {
  return {
    ready: [...labels.ready],
    running: labels.running,
    blocked: normalizeLabelValue(labels.blocked),
    needsHuman: labels.needsHuman,
    reviewReady: labels.reviewReady,
    error: labels.error,
    retry: labels.retry,
    planning: labels.planning,
    mergeQueued: labels.mergeQueued,
    merging: labels.merging,
    mergeFailed: labels.mergeFailed,
  }
}

function normalizeLabelValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === 'string') ?? ''
  }
  return ''
}

function copyCommandSpec(command: CommandSpec): CommandSpec {
  if (Array.isArray(command)) {
    return [...command]
  }
  return command
}

async function handleWsMessage(
  ws: WebSocket,
  state: WsClientState,
  rawMessage: string,
  deps: MCPDependencies,
  agentSessionManager: InteractiveAgentSessionManager,
  shellSessionManager: ShellSessionManager,
): Promise<void> {
  let command: WebSocketCommand
  try {
    command = JSON.parse(rawMessage) as WebSocketCommand
  } catch {
    sendWebsocket(ws, { type: 'error', error: 'Invalid JSON message' })
    return
  }

  if (!ensureWebSocketShellAuthorized(ws, state, command.type)) {
    return
  }

  if (command.type === 'subscribe-run-events') {
    const runId = typeof command.runId === 'string' ? command.runId : ''
    if (!runId) {
      sendWebsocket(ws, { type: 'error', error: 'runId is required for subscribe-run-events' })
      return
    }

    const cursor = Number.isFinite(command.since) ? Math.max(0, Math.floor(command.since ?? 0)) : 0
    state.runSubscriptions.set(runId, cursor)
    sendWebsocket(ws, { type: 'subscribed', payload: { runId, since: cursor } })
    return
  }

  if (command.type === 'unsubscribe-run-events') {
    const runId = typeof command.runId === 'string' ? command.runId : ''
    if (!runId) {
      sendWebsocket(ws, { type: 'error', error: 'runId is required for unsubscribe-run-events' })
      return
    }

    state.runSubscriptions.delete(runId)
    sendWebsocket(ws, { type: 'unsubscribed', payload: { runId } })
    return
  }

  if (command.type === 'subscribe-agent-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for subscribe-agent-session-events' })
      return
    }

    const cursor = Number.isFinite(command.since) ? Math.max(0, Math.floor(command.since ?? 0)) : 0
    state.agentSessionSubscriptions.set(sessionId, cursor)
    sendWebsocket(ws, { type: 'subscribed', payload: { sessionId, since: cursor } })
    publishAgentSessionSubscriptions(ws, state, agentSessionManager)
    return
  }

  if (command.type === 'unsubscribe-agent-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for unsubscribe-agent-session-events' })
      return
    }

    state.agentSessionSubscriptions.delete(sessionId)
    sendWebsocket(ws, { type: 'unsubscribed', payload: { sessionId } })
    return
  }

  if (command.type === 'subscribe-shell-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for subscribe-shell-session-events' })
      return
    }

    const cursor = Number.isFinite(command.since) ? Math.max(0, Math.floor(command.since ?? 0)) : 0
    state.shellSessionSubscriptions.set(sessionId, cursor)
    sendWebsocket(ws, { type: 'subscribed', payload: { sessionId, since: cursor } })
    publishShellSessionSubscriptions(ws, state, shellSessionManager)
    return
  }

  if (command.type === 'unsubscribe-shell-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for unsubscribe-shell-session-events' })
      return
    }

    state.shellSessionSubscriptions.delete(sessionId)
    sendWebsocket(ws, { type: 'unsubscribed', payload: { sessionId } })
    return
  }

  if (command.type === 'shell-input') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    const data = typeof command.data === 'string' ? command.data : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for shell-input' })
      return
    }
    if (!data) {
      sendWebsocket(ws, { type: 'error', error: 'data is required for shell-input' })
      return
    }
    try {
      shellSessionManager.writeInput(sessionId, data)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to write shell input for ${sessionId}: ${(err as Error).message}`,
      })
    }
    return
  }

  if (command.type === 'shell-resize') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for shell-resize' })
      return
    }

    const cols = typeof command.cols === 'number' ? command.cols : NaN
    const rows = typeof command.rows === 'number' ? command.rows : NaN
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      sendWebsocket(ws, { type: 'error', error: 'cols and rows are required for shell-resize' })
      return
    }
    try {
      shellSessionManager.resize(sessionId, cols, rows)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to resize shell session ${sessionId}: ${(err as Error).message}`,
      })
    }
    return
  }

  if (command.type === 'refresh') {
    const snapshot = await buildDashboardSnapshot(deps)
    sendWebsocket(ws, { type: 'snapshot', payload: snapshot })
    return
  }

  sendWebsocket(ws, { type: 'error', error: 'Unknown command type' })
}

async function publishRunSubscriptions(
  ws: WebSocket,
  state: WsClientState,
  deps: MCPDependencies,
): Promise<void> {
  for (const [runId, since] of state.runSubscriptions.entries()) {
    try {
      const result = await handleToolCall(
        'night-orch-stream-events',
        { runId, since, limit: 200 },
        deps,
      )

      const eventPayload = toRunEventPayload(result)
      if (!eventPayload) {
        continue
      }

      state.runSubscriptions.set(runId, eventPayload.lastEventId)

      if (eventPayload.events.length === 0) {
        continue
      }

      sendWebsocket(ws, {
        type: 'run-events',
        payload: {
          runId,
          events: eventPayload.events,
          lastEventId: eventPayload.lastEventId,
        },
      })
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to stream events for ${runId}: ${(err as Error).message}`,
      })
    }
  }
}

function publishAgentSessionSubscriptions(
  ws: WebSocket,
  state: WsClientState,
  manager: InteractiveAgentSessionManager,
): void {
  for (const [sessionId, since] of state.agentSessionSubscriptions.entries()) {
    let result: InteractiveAgentSessionEventList
    try {
      result = manager.getEvents(sessionId, since, 200)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to stream agent-session events for ${sessionId}: ${(err as Error).message}`,
      })
      continue
    }

    state.agentSessionSubscriptions.set(sessionId, result.lastEventId)

    if (result.events.length === 0) {
      continue
    }

    sendWebsocket(ws, {
      type: 'agent-session-events',
      payload: {
        sessionId,
        status: result.status,
        events: result.events,
        lastEventId: result.lastEventId,
      },
    })
  }
}

function publishShellSessionSubscriptions(
  ws: WebSocket,
  state: WsClientState,
  manager: ShellSessionManager,
): void {
  for (const [sessionId, since] of state.shellSessionSubscriptions.entries()) {
    let result: ShellSessionEventList
    try {
      result = manager.getEvents(sessionId, since, 500)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to stream shell-session events for ${sessionId}: ${(err as Error).message}`,
      })
      continue
    }

    state.shellSessionSubscriptions.set(sessionId, result.lastEventId)

    if (result.events.length === 0) {
      continue
    }

    sendWebsocket(ws, {
      type: 'shell-session-events',
      payload: {
        sessionId,
        status: result.status,
        events: result.events,
        lastEventId: result.lastEventId,
      },
    })
  }
}

function toRunEventPayload(input: unknown): { events: unknown[]; lastEventId: number } | null {
  if (!input || typeof input !== 'object') return null

  const maybeEvents = (input as { events?: unknown }).events
  const maybeLastEventId = (input as { lastEventId?: unknown }).lastEventId

  if (!Array.isArray(maybeEvents)) return null
  if (typeof maybeLastEventId !== 'number' || !Number.isFinite(maybeLastEventId)) return null

  return {
    events: maybeEvents,
    lastEventId: Math.max(0, Math.floor(maybeLastEventId)),
  }
}

function resolveWebSocketAuthenticationState(request: IncomingMessage, security: WebSecurityContext): boolean {
  let requestUrl: URL
  try {
    requestUrl = getRequestUrl(request)
  } catch {
    return false
  }

  const queryToken = requestUrl.searchParams.get('token')
  const headerToken = getSingleHeaderValue(request.headers[WEB_AUTH_TOKEN_HEADER])
  const providedToken = toNonEmptyString(queryToken) ?? headerToken
  if (!providedToken) {
    return false
  }

  return isMatchingToken(providedToken, security.webMutationToken)
}

function requiresWebSocketShellAuth(commandType: WebSocketCommand['type']): boolean {
  return commandType === 'subscribe-shell-session-events'
    || commandType === 'unsubscribe-shell-session-events'
    || commandType === 'shell-input'
    || commandType === 'shell-resize'
}

function ensureWebSocketShellAuthorized(
  ws: WebSocket,
  state: WsClientState,
  commandType: WebSocketCommand['type'],
): boolean {
  if (!requiresWebSocketShellAuth(commandType)) {
    return true
  }

  if (state.isAuthenticated) {
    return true
  }

  sendWebsocket(ws, {
    type: 'error',
    error: `Unauthorized websocket command: ${commandType}`,
  })
  return false
}

function sendWebsocket(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(payload))
}

function isClientRequestError(message: string): boolean {
  return message.startsWith('Invalid JSON body') || message === 'Request body too large'
}

function isAuthorizationError(message: string): boolean {
  return message.startsWith('Unauthorized:')
}

function isRuntimeSettingInputError(err: unknown): err is RuntimeSettingInputError {
  if (err instanceof RuntimeSettingInputError) {
    return true
  }
  return err instanceof Error && err.name === 'RuntimeSettingInputError'
}

function decodeWsMessage(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw
  }

  if (raw instanceof Buffer) {
    return raw.toString('utf-8')
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf-8')
  }

  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf-8')
  }

  if (Array.isArray(raw)) {
    const buffers = raw
      .map((item) => {
        if (item instanceof Buffer) return item
        if (item instanceof ArrayBuffer) return Buffer.from(item)
        if (ArrayBuffer.isView(item)) return Buffer.from(item.buffer, item.byteOffset, item.byteLength)
        return null
      })
      .filter((item): item is Buffer => item !== null)

    if (buffers.length === 0) return null
    return Buffer.concat(buffers).toString('utf-8')
  }

  return null
}
