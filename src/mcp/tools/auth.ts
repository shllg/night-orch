import { createHash, timingSafeEqual } from 'node:crypto'
import type { MCPDependencies } from '../server.js'

export function assertMcpMutationAuth(providedToken: string | undefined, deps: MCPDependencies): void {
  const tokenEnv = deps.config.mcp.authTokenEnv
  if (!tokenEnv) return
  const expectedToken = process.env[tokenEnv]
  if (!expectedToken) {
    throw new Error(`MCP auth token env var ${tokenEnv} is configured but not set`)
  }
  if (!providedToken || !isMatchingMcpToken(providedToken, expectedToken)) {
    throw new Error('Unauthorized: missing or invalid MCP auth token')
  }
}

function isMatchingMcpToken(providedToken: string, expectedToken: string): boolean {
  const providedHash = createHash('sha256').update(providedToken).digest()
  const expectedHash = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(providedHash, expectedHash)
}
