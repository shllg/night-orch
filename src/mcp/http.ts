import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMCPServer, type MCPDependencies } from './server.js'
import { logger } from '../utils/logger.js'

const MCP_PATH = '/mcp'
const SSE_PATH = '/sse'
const HEALTH_PATH = '/health'

/**
 * Start an embedded MCP server exposing two transports on the same port:
 *
 * 1. **Streamable HTTP** (modern, `@modelcontextprotocol/sdk`'s
 *    `StreamableHTTPServerTransport`) on `POST /mcp`, with
 *    `Mcp-Session-Id` header-based session routing plus optional
 *    `GET /mcp` (server-initiated SSE) and `DELETE /mcp` (session
 *    termination). This is the transport `claude-code`'s `type: "http"`
 *    client uses and it is what new integrations should target.
 *
 * 2. **Legacy SSE** (`SSEServerTransport`) on `GET /sse` for the
 *    session handshake plus `POST /mcp?sessionId=…` for follow-up JSON-RPC
 *    messages. Kept for back-compat with existing proxies and clients that
 *    speak the pre-streamable-HTTP spec.
 *
 * Binding rules:
 *
 * - Loopback host + any auth setting → allowed (existing dev default).
 * - Non-loopback host + `mcp.authTokenEnv` set to an env var with a
 *   non-empty value → allowed, with `Authorization: Bearer <token>`
 *   enforced on every request.
 * - Non-loopback host without auth → rejected at startup. Exposing
 *   mutation tools to an unauthenticated network listener is never safe.
 */
export function startMCPHttpServer(
  deps: MCPDependencies,
  host: string,
  port: number,
): Promise<Server> {
  const authTokenEnv = deps.config.mcp.authTokenEnv
  const authToken = authTokenEnv ? (process.env[authTokenEnv] ?? '').trim() : ''
  const authRequired = Boolean(authTokenEnv) && authToken.length > 0

  if (!isLoopbackHost(host) && !authRequired) {
    return Promise.reject(new Error(
      `MCP HTTP server binding to non-loopback host "${host}" requires mcp.authTokenEnv to name a populated env var`,
    ))
  }

  if (!authRequired) {
    logger.warn(
      { transport: 'http', host, port },
      'MCP HTTP server running without authentication — mutation tools are unauthenticated',
    )
  }

  // Legacy SSE transports keyed by the sessionId the SDK assigns at
  // `GET /sse` handshake. Subsequent `POST /mcp?sessionId=X` messages
  // look up their transport in this map.
  const sseTransports = new Map<string, SSEServerTransport>()

  // Streamable HTTP transports keyed by the session id returned to the
  // client in the `Mcp-Session-Id` response header. Follow-up requests
  // present the same id via the `Mcp-Session-Id` *request* header and we
  // route them back to the owning transport instance.
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>()

  const checkAuth = (req: IncomingMessage): boolean => {
    if (!authRequired) return true
    // `authorization` is a single-valued header in the Node types; multiple
    // values are not expected but we collapse defensively via readHeader.
    const header = readHeader(req, 'authorization')
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const token = header.slice('Bearer '.length).trim()
    return token === authToken
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

      // --- Legacy SSE: GET /sse establishes a session ---
      if (url.pathname === SSE_PATH && req.method === 'GET') {
        if (!checkAuth(req)) return sendUnauthorized(res)

        const transport = new SSEServerTransport(MCP_PATH, res)
        const server = createMCPServer(deps)

        sseTransports.set(transport.sessionId, transport)
        logger.info({ sessionId: transport.sessionId, transport: 'sse' }, 'MCP SSE client connected')

        res.on('close', () => {
          sseTransports.delete(transport.sessionId)
          logger.info({ sessionId: transport.sessionId, transport: 'sse' }, 'MCP SSE client disconnected')
        })

        await server.connect(transport)
        return
      }

      // --- POST /mcp: two shapes, disambiguated by the `sessionId` query param ---
      if (url.pathname === MCP_PATH && req.method === 'POST') {
        if (!checkAuth(req)) return sendUnauthorized(res)

        // 1. Legacy SSE follow-up: `POST /mcp?sessionId=X` pushes a JSON-RPC
        //    message into an existing SSE session.
        const legacySessionId = url.searchParams.get('sessionId')
        if (legacySessionId !== null) {
          const transport = sseTransports.get(legacySessionId)
          if (!transport) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }))
            return
          }
          await transport.handlePostMessage(req, res)
          return
        }

        // 2. Streamable HTTP: route via `Mcp-Session-Id` header. If the
        //    header identifies an existing session we reuse its transport;
        //    otherwise the request must be an `initialize` and we mint a
        //    new transport + session.
        const sessionIdHeader = readHeader(req, 'mcp-session-id')
        if (sessionIdHeader && streamableTransports.has(sessionIdHeader)) {
          await streamableTransports.get(sessionIdHeader)!.handleRequest(req, res)
          return
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // JSON responses are simpler for stateless HTTP clients and
          // avoid the flushing pitfalls of chunked SSE streams when a
          // downstream proxy is in front of us.
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            streamableTransports.set(sid, transport)
            logger.info(
              { sessionId: sid, transport: 'streamable-http' },
              'MCP streamable HTTP session initialized',
            )
          },
          onsessionclosed: (sid) => {
            streamableTransports.delete(sid)
            logger.info(
              { sessionId: sid, transport: 'streamable-http' },
              'MCP streamable HTTP session closed',
            )
          },
        })
        const server = createMCPServer(deps)
        await server.connect(transport)
        await transport.handleRequest(req, res)
        return
      }

      // --- GET /mcp with Mcp-Session-Id: server-initiated SSE stream for
      //     notifications / server-pushed messages, per streamable HTTP spec. ---
      if (url.pathname === MCP_PATH && req.method === 'GET') {
        if (!checkAuth(req)) return sendUnauthorized(res)

        const sessionIdHeader = readHeader(req, 'mcp-session-id')
        if (!sessionIdHeader || !streamableTransports.has(sessionIdHeader)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing or unknown Mcp-Session-Id' }))
          return
        }
        await streamableTransports.get(sessionIdHeader)!.handleRequest(req, res)
        return
      }

      // --- DELETE /mcp with Mcp-Session-Id: client-initiated session teardown. ---
      if (url.pathname === MCP_PATH && req.method === 'DELETE') {
        if (!checkAuth(req)) return sendUnauthorized(res)

        const sessionIdHeader = readHeader(req, 'mcp-session-id')
        if (!sessionIdHeader || !streamableTransports.has(sessionIdHeader)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing or unknown Mcp-Session-Id' }))
          return
        }
        await streamableTransports.get(sessionIdHeader)!.handleRequest(req, res)
        return
      }

      // --- /health: cheap liveness probe with session counts ---
      if (url.pathname === HEALTH_PATH && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          sseSessions: sseTransports.size,
          streamableSessions: streamableTransports.size,
        }))
        return
      }

      res.writeHead(404)
      res.end('Not found')
    } catch (err) {
      logger.warn({ err, method: req.method, url: req.url }, 'MCP HTTP request handler error')
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  })

  return new Promise<Server>((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, host, () => {
      logger.info(
        { host, port, authRequired },
        'MCP HTTP server started (dual transport: streamable HTTP + legacy SSE)',
      )
      resolve(httpServer)
    })
  })
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="night-orch"',
  })
  res.end(JSON.stringify({ error: 'Unauthorized' }))
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}
