import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import type { MCPDependencies } from '../mcp/server.js'
import {
  InteractiveAgentSessionManager,
} from './agent-session.js'
import { logger } from '../utils/logger.js'
import { sanitizeError } from '../utils/sanitize-error.js'
import { nowUtcIso } from '../utils/time.js'
import { resolveConfigWithRuntimeSettings } from '../settings/runtime.js'
import {
  buildDashboardSnapshot,
} from './snapshots.js'
import {
  extractSessionCookie,
  requireCsrfToken,
  verifySessionCookie,
} from './auth.js'
import type { RouteContext } from './routes/context.js'
import { handleRunRoutes } from './routes/api-runs.js'
import { handleOperationRoutes } from './routes/api-operations.js'
import { handleSettingsRoutes } from './routes/api-settings.js'
import { handleAuthRoutes } from './routes/api-auth.js'
import { handlePushRoutes } from './routes/api-push.js'
import {
  handleWsMessage,
  publishIssueSubscriptions,
  publishRunSubscriptions,
  publishAgentSessionSubscriptions,
} from './routes/api-events.js'

export interface WebServerOptions {
  host: string
  port: number
  allowedHosts?: string[]
  frontendDistPath?: string
  snapshotIntervalMs?: number
  operationsEnabled?: boolean
  /** Phase 2a: when `false`, the mutation auth guard is bypassed
   * entirely — use only behind a trusted reverse proxy (Caddy with
   * basic-auth, Tailscale serve, etc.) that handles auth itself.
   * Defaults to `true`. */
  requireAuth?: boolean
  rawConfig?: unknown
}

export interface WsClientState {
  runSubscriptions: Map<string, number>
  issueSubscriptions: Map<string, { repo: string; issueNumber: number; since: number }>
  agentSessionSubscriptions: Map<string, number>
  isAlive: boolean
}

export interface WebSecurityContext {
  allowedHostnames: Set<string>
  webMutationToken: string
  mcpMutationAuthToken?: string
  operatorAuthMode: boolean
  /** Secret used to sign session cookies. Generated at startup and
   * kept in memory — restarts invalidate existing sessions. */
  sessionSecret: Buffer
  /** Phase 2a: when false, `validateMutationRequest` short-circuits
   * to success without checking cookies or headers. Intended for
   * deployments behind a trusted reverse proxy that handles auth. */
  authRequired: boolean
  trustedProxy: boolean
  loopbackTokenPath: string | null
}

export type WebSocketCommand =
  | { type: 'subscribe-run-events'; runId: string; since?: number }
  | { type: 'unsubscribe-run-events'; runId: string }
  | { type: 'subscribe-issue-events'; repo: string; issueNumber: number; since?: number }
  | { type: 'unsubscribe-issue-events'; repo: string; issueNumber: number }
  | { type: 'subscribe-agent-session-events'; sessionId: string; since?: number }
  | { type: 'unsubscribe-agent-session-events'; sessionId: string }
  | { type: 'refresh' }

const ONE_MEGABYTE = 1024 * 1024
const DEFAULT_SNAPSHOT_INTERVAL_MS = 3000
const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'
let loopbackTokenPrinted = false
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

  const routeContext: RouteContext = {
    deps,
    security,
    operationsEnabled,
    rawConfig: options.rawConfig,
    agentSessionManager,
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const requestUrl = getRequestUrl(req)

      if (requestUrl.pathname === '/healthz') {
        const runtimeConfig = resolveConfigWithRuntimeSettings(deps.config, deps.db)
        writeJson(res, 200, {
          ok: true,
          metrics: {
            enabled: runtimeConfig.metrics.enabled,
            ready: deps.metrics?.ready ?? false,
            endpoint: runtimeConfig.metrics.enabled
              ? (deps.metrics?.endpoint ?? {
                host: runtimeConfig.metrics.host,
                port: runtimeConfig.metrics.port,
              })
              : null,
          },
        })
        return
      }

      if (requestUrl.pathname.startsWith('/api/')) {
        if (!isAllowedRequestHost(req, security)) {
          writeJson(res, 403, { error: 'Forbidden host' })
          return
        }
        await handleApiRequest(req, res, requestUrl, routeContext)
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

  wsServer.on('connection', (ws) => {
    const state: WsClientState = {
      runSubscriptions: new Map(),
      issueSubscriptions: new Map(),
      agentSessionSubscriptions: new Map(),
      isAlive: true,
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
      void handleWsMessage(ws, state, decoded, deps, agentSessionManager)
    })

    ws.on('pong', () => {
      state.isAlive = true
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
        await publishIssueSubscriptions(ws, state, deps)
        publishAgentSessionSubscriptions(ws, state, agentSessionManager)
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

  const heartbeatInterval = setInterval(() => {
    for (const [ws, state] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (!state.isAlive) {
        ws.terminate()
        clients.delete(ws)
        continue
      }
      state.isAlive = false
      ws.ping()
    }
  }, 15_000)
  heartbeatInterval.unref()

  const stopAgentSessionStreaming = agentSessionManager.onSessionEvent((sessionId) => {
    for (const [ws, state] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (!state.agentSessionSubscriptions.has(sessionId)) continue
      publishAgentSessionSubscriptions(ws, state, agentSessionManager)
    }
  })
  httpServer.on('close', () => {
    stopAgentSessionStreaming()
    clearInterval(interval)
    clearInterval(heartbeatInterval)
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
  ctx: RouteContext,
): Promise<void> {
  const method = req.method ?? 'GET'
  const { pathname, searchParams } = requestUrl
  const { security, operationsEnabled } = ctx

  if ((method === 'POST' || method === 'DELETE')
    && (pathname.startsWith('/api/operations/')
      || pathname.startsWith('/api/agent/')
      || pathname.startsWith('/api/push/'))) {
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

  if (await handleAuthRoutes(req, res, method, pathname, searchParams, ctx)) return
  if (await handlePushRoutes(req, res, method, pathname, searchParams, ctx)) return
  if (await handleRunRoutes(req, res, method, pathname, searchParams, ctx)) return
  if (await handleSettingsRoutes(req, res, method, pathname, searchParams, ctx)) return
  if (await handleOperationRoutes(req, res, method, pathname, searchParams, ctx)) return

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

export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export function toBoundedInt(
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

export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function withMcpMutationAuth(
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

export function sendWebsocket(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(payload))
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost')
}

export function validateMutationRequest(
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

  // Phase 2a: `web --skip-auth` / `requireAuth:false` bypasses the
  // cookie+header check entirely. The host, origin, intent, and
  // content-type guards above still apply so trivial drive-by
  // CSRF is still blocked — but the caller doesn't need to present
  // a session cookie or bearer token. Intended for deployments
  // behind a trusted reverse proxy (Caddy, Tailscale) that handles
  // authentication at its own layer.
  if (!security.authRequired) {
    return null
  }

  // Phase 2a: accept either a valid session cookie OR the legacy
  // header token. The cookie path lets mobile browsers authenticate
  // once via POST /api/auth/session and then present credentials
  // automatically on subsequent mutations. The header path stays in
  // place so CLI tools and integrations that speak the original
  // contract continue to work unchanged.
  const cookieSession = verifySessionCookie(
    extractSessionCookie(req),
    security.sessionSecret,
  )
  if (cookieSession !== null) {
    if (!requireCsrfToken(req)) {
      return { statusCode: 403, error: 'Invalid CSRF token' }
    }
    return null
  }

  const webToken = getSingleHeaderValue(req.headers[WEB_AUTH_TOKEN_HEADER])
  if (!webToken) {
    return { statusCode: 401, error: `Missing session cookie or required header: ${WEB_AUTH_TOKEN_HEADER}` }
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

function createWebSecurityContext(deps: MCPDependencies, options: WebServerOptions): WebSecurityContext {
  const operatorToken = process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
  const bindHostName = normalizeHostname(options.host) ?? options.host
  const isLoopback =
    bindHostName === '127.0.0.1'
    || bindHostName === '::1'
    || bindHostName === 'localhost'
    || bindHostName === ''
  const authRequired = options.requireAuth !== false
  const operatorAuthMode = authRequired && !isLoopback && !!operatorToken
  const generatedLoopbackToken = randomBytes(24).toString('base64url')
  const webMutationToken = operatorAuthMode ? operatorToken : generatedLoopbackToken
  const loopbackTokenPath = authRequired && !operatorAuthMode
    ? writeLoopbackTokenSidecar(generatedLoopbackToken)
    : null

  if (authRequired && !operatorAuthMode && !loopbackTokenPrinted) {
    process.stdout.write(
      `\n[night-orch] Loopback web token (also at ${loopbackTokenPath ?? 'sidecar file'}):\n  ${generatedLoopbackToken}\n\n`,
    )
    loopbackTokenPrinted = true
  }

  return {
    allowedHostnames: resolveAllowedHostnames(options.host, options.allowedHosts ?? []),
    webMutationToken,
    mcpMutationAuthToken: resolveMcpMutationAuthToken(deps),
    operatorAuthMode,
    sessionSecret: randomBytes(32),
    authRequired,
    trustedProxy: deps.config.web?.trustedProxy === true,
    loopbackTokenPath,
  }
}

function writeLoopbackTokenSidecar(token: string): string | null {
  const runtimeDir = process.env['XDG_RUNTIME_DIR'] ?? '/tmp'
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    const tokenPath = join(runtimeDir, 'night-orch-web.token')
    writeFileSync(tokenPath, token, { mode: 0o600 })
    chmodSync(tokenPath, 0o600)
    logger.info({ path: tokenPath }, 'Loopback web token written to sidecar file (mode 0600)')
    return tokenPath
  } catch (err) {
    logger.warn({ err }, 'Failed to write loopback token sidecar file')
    return null
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
    throw new Error('storage.worktreeRoot must be configured before using web agent sessions')
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
