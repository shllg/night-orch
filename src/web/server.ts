import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import type { MCPDependencies } from '../mcp/server.js'
import { handleToolCall } from '../mcp/tools/index.js'
import { handleResourceRead } from '../mcp/resources/index.js'
import { loadTuiStats } from '../state/stats.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'

export interface WebServerOptions {
  host: string
  port: number
  allowedHosts?: string[]
  frontendDistPath?: string
  snapshotIntervalMs?: number
  operationsEnabled?: boolean
}

interface WsClientState {
  runSubscriptions: Map<string, number>
}

interface DashboardSnapshot {
  generatedAt: string
  status: unknown
  runs: unknown
  cost: unknown
  config: {
    repos: string[]
    pollIntervalSeconds: number
  }
  stats: ReturnType<typeof loadTuiStats>
}

interface WebSecurityContext {
  allowedHostnames: Set<string>
  webMutationToken: string
  mcpMutationAuthToken?: string
}

type WebSocketCommand =
  | { type: 'subscribe-run-events'; runId: string; since?: number }
  | { type: 'unsubscribe-run-events'; runId: string }
  | { type: 'refresh' }

const ONE_MEGABYTE = 1024 * 1024
const DEFAULT_SNAPSHOT_INTERVAL_MS = 3000
const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'
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
  const security = createWebSecurityContext(deps, options)
  const operationsEnabled = options.operationsEnabled ?? true
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
        await handleApiRequest(req, res, requestUrl, deps, security, operationsEnabled)
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

      const message = (err as Error).message
      const status = isClientRequestError(message)
        ? 400
        : isAuthorizationError(message)
          ? 403
          : 500
      if (status >= 500) {
        logger.warn({ err }, 'Web request failed')
      }
      writeJson(res, status, { error: message })
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
      wsServer.emit('connection', ws)
    })
  })

  wsServer.on('connection', (ws) => {
    const state: WsClientState = { runSubscriptions: new Map() }
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
      void handleWsMessage(ws, state, decoded, deps)
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

  httpServer.on('close', () => {
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
): Promise<void> {
  const method = req.method ?? 'GET'
  const { pathname, searchParams } = requestUrl

  if (method === 'POST' && pathname.startsWith('/api/operations/')) {
    // Update is a supervisor operation — always allowed regardless of attach/standalone mode
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
    const snapshot = await buildDashboardSnapshot(deps)
    writeJson(res, 200, snapshot)
    return
  }

  if (method === 'GET' && pathname === '/api/session') {
    writeJson(res, 200, {
      mutationToken: security.webMutationToken,
      operationsEnabled,
    })
    return
  }

  if (method === 'GET' && pathname === '/api/status') {
    const repo = searchParams.get('repo') ?? undefined
    const result = await handleToolCall('night-orch-status', { repo }, deps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET' && pathname === '/api/runs') {
    const repo = searchParams.get('repo') ?? undefined
    const status = searchParams.get('status') ?? undefined
    const limit = toBoundedInt(searchParams.get('limit'), 50, 1, 500)
    const result = await handleToolCall('night-orch-list-runs', { repo, status, limit }, deps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET' && pathname === '/api/cost') {
    const days = toBoundedInt(searchParams.get('days'), 7, 1, 30)
    const result = await handleToolCall('night-orch-cost-report', { days }, deps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET' && pathname === '/api/stats') {
    writeJson(res, 200, loadTuiStats(deps.db))
    return
  }

  if (method === 'GET' && pathname === '/api/config') {
    const result = await handleResourceRead('night-orch://config', deps)
    writeJson(res, 200, result)
    return
  }

  if (method === 'GET') {
    const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
    if (runDetailMatch) {
      const runId = decodeURIComponent(runDetailMatch[1] ?? '')
      const result = await handleToolCall('night-orch-run-detail', { runId }, deps)
      writeJson(res, 200, result)
      return
    }

    const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
    if (runEventsMatch) {
      const runId = decodeURIComponent(runEventsMatch[1] ?? '')
      const since = toBoundedInt(searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = toBoundedInt(searchParams.get('limit'), 100, 1, 200)
      const result = await handleToolCall('night-orch-stream-events', { runId, since, limit }, deps)
      writeJson(res, 200, result)
      return
    }

    const repoIssuesMatch = pathname.match(/^\/api\/repos\/([^/]+)\/issues$/)
    if (repoIssuesMatch) {
      const repo = decodeURIComponent(repoIssuesMatch[1] ?? '')
      const filter = searchParams.get('filter') ?? 'all'
      const result = await handleToolCall('night-orch-list-issues', { repo, filter }, deps)
      writeJson(res, 200, result)
      return
    }
  }

  if (method === 'POST' && pathname === '/api/operations/poll') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-poll',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      deps,
    )
    writeJson(res, 200, result)
    return
  }

  if (method === 'POST' && pathname === '/api/operations/sync') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-sync',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      deps,
    )
    writeJson(res, 200, result)
    return
  }

  if (method === 'POST' && pathname === '/api/operations/cleanup') {
    const body = await readJsonBody(req)
    const result = await handleToolCall(
      'night-orch-cleanup',
      withMcpMutationAuth({ dryRun: Boolean(body['dryRun']) }, security),
      deps,
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
      deps,
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
      deps,
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
      deps,
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
      deps,
    )
    writeJson(res, 200, result)
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

  if (!targetPath.startsWith(frontendDistPath)) {
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
  return {
    allowedHostnames: resolveAllowedHostnames(options.host, options.allowedHosts ?? []),
    webMutationToken: randomBytes(24).toString('base64url'),
    mcpMutationAuthToken: resolveMcpMutationAuthToken(deps),
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

async function buildDashboardSnapshot(deps: MCPDependencies): Promise<DashboardSnapshot> {
  const [status, runs, cost] = await Promise.all([
    handleToolCall('night-orch-status', {}, deps),
    handleToolCall('night-orch-list-runs', { limit: 100 }, deps),
    handleToolCall('night-orch-cost-report', { days: 7 }, deps),
  ])

  return {
    generatedAt: nowUtcIso(),
    status,
    runs,
    cost,
    config: {
      repos: deps.config.repos.map((repo) => repo.repo),
      pollIntervalSeconds: deps.config.github.pollIntervalSeconds,
    },
    stats: loadTuiStats(deps.db),
  }
}

async function handleWsMessage(
  ws: WebSocket,
  state: WsClientState,
  rawMessage: string,
  deps: MCPDependencies,
): Promise<void> {
  let command: WebSocketCommand
  try {
    command = JSON.parse(rawMessage) as WebSocketCommand
  } catch {
    sendWebsocket(ws, { type: 'error', error: 'Invalid JSON message' })
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
