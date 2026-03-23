import { createServer, type Server } from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createMCPServer, type MCPDependencies } from './server.js'
import { logger } from '../utils/logger.js'

const MCP_PATH = '/mcp'

/**
 * Start an embedded MCP server over SSE on the given port.
 * Claude Code / Codex connect to this as an SSE MCP endpoint.
 */
export function startMCPHttpServer(
  deps: MCPDependencies,
  host: string,
  port: number,
): Promise<Server> {
  const transports = new Map<string, SSEServerTransport>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname === '/sse' && req.method === 'GET') {
      // SSE connection — create a new transport + MCP server per session
      const transport = new SSEServerTransport(MCP_PATH, res)
      const server = createMCPServer(deps)

      transports.set(transport.sessionId, transport)
      logger.info({ sessionId: transport.sessionId }, 'MCP SSE client connected')

      res.on('close', () => {
        transports.delete(transport.sessionId)
        logger.info({ sessionId: transport.sessionId }, 'MCP SSE client disconnected')
      })

      await server.connect(transport)
    } else if (url.pathname === MCP_PATH && req.method === 'POST') {
      // JSON-RPC message from client
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }))
        return
      }

      const transport = transports.get(sessionId)!
      await transport.handlePostMessage(req, res)
    } else if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', sessions: transports.size }))
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  return new Promise<Server>((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, host, () => {
      logger.info({ host, port }, 'MCP HTTP/SSE server started')
      resolve(httpServer)
    })
  })
}
