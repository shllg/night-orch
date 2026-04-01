import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { MetricsService } from '../metrics/service.js'
import type { PollerControl } from '../poller/control.js'
import { registerTools, handleToolCall } from './tools/index.js'
import { registerResources, handleResourceRead } from './resources/index.js'
import { createLogger } from '../utils/logger.js'

export interface MCPDependencies {
  db: Database.Database
  config: Config
  forgeAdapters: Map<string, ForgeAdapter>
  poller: PollerControl | null
  metrics: MetricsService | null
}

const mcpLogger = createLogger(process.env['LOG_LEVEL'] ?? 'info', {
  destination: 'stderr',
  pretty: false,
})

export function createMCPServer(deps: MCPDependencies): Server {
  const server = new Server(
    { name: 'night-orch', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  )

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: registerTools() }
  })

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = await handleToolCall(name, args ?? {}, deps)
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  })

  // List resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: registerResources() }
  })

  // Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    try {
      const content = await handleResourceRead(uri, deps)
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(content, null, 2) }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { contents: [{ uri, mimeType: 'text/plain', text: `Error: ${message}` }] }
    }
  })

  return server
}

export async function startMCPStdio(deps: MCPDependencies): Promise<void> {
  const server = createMCPServer(deps)
  const transport = new StdioServerTransport()

  // When using stdio, all logging must go to stderr
  mcpLogger.info('Starting MCP server with stdio transport')

  await server.connect(transport)
}
