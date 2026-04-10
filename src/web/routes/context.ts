import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MCPDependencies } from '../../mcp/server.js'
import type { InteractiveAgentSessionManager } from '../agent-session.js'
import type { WebSecurityContext } from '../server.js'

export interface RouteContext {
  deps: MCPDependencies
  security: WebSecurityContext
  operationsEnabled: boolean
  rawConfig: unknown
  agentSessionManager: InteractiveAgentSessionManager
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  ctx: RouteContext,
) => Promise<boolean>
