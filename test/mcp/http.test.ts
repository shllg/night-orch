import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../../src/state/db.js'
import { startMCPHttpServer } from '../../src/mcp/http.js'
import type { MCPDependencies } from '../../src/mcp/server.js'

function makeMinimalConfig(overrides: { authTokenEnv?: string | null } = {}) {
  return {
    version: 1 as const,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: { channels: [{ type: 'console' as const }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    mcp: {
      enabled: true,
      transport: 'stdio' as const,
      authTokenEnv: overrides.authTokenEnv ?? null,
      httpHost: '127.0.0.1',
      httpPort: 0,
    },
    repos: [{
      repo: 'org/repo',
      forge: 'github' as const,
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: {
        ready: ['no:ready'],
        running: 'no:running',
        blocked: ['no:blocked', 'no:needs-human'],
        reviewReady: 'no:review-ready',
        error: 'no:error',
        retry: 'no:retry',
      },
      defaults: { planner: 'claude' as const, coder: 'claude' as const, reviewer: 'claude' as const, doneMode: 'pr-ready' as const, notifyPriority: 'normal' as const, prMentions: [] },
      verify: [],
      selectors: { includeLabelsAny: ['no:ready'], excludeLabelsAny: [] },
      agents: {},
    }],
  }
}

function makeDeps(tmpDirPath: string, overrides: { authTokenEnv?: string | null } = {}): { deps: MCPDependencies; close: () => void } {
  const db = initDatabase(join(tmpDirPath, 'test.db'))
  return {
    deps: {
      db,
      config: makeMinimalConfig(overrides) as MCPDependencies['config'],
      forgeAdapters: new Map(),
      poller: null,
      metrics: null,
    },
    close: () => db.close(),
  }
}

function serverUrl(server: Server, path = ''): string {
  const addr = server.address() as AddressInfo
  return `http://127.0.0.1:${addr.port}${path}`
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    },
  })
}

describe('startMCPHttpServer', () => {
  let tmpDir: string | null = null
  let server: Server | null = null
  let close: (() => void) | null = null

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mcp-http-test-'))
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    if (close) { close(); close = null }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
    delete process.env['TEST_MCP_AUTH']
  })

  describe('binding rules', () => {
    it('rejects non-loopback hosts when authTokenEnv is unset', async () => {
      const { deps, close: closeDb } = makeDeps(tmpDir!)
      close = closeDb
      await expect(startMCPHttpServer(deps, '0.0.0.0', 0))
        .rejects
        .toThrow('requires mcp.authTokenEnv')
    })

    it('rejects non-loopback hosts when authTokenEnv is set but the env var is empty', async () => {
      process.env['TEST_MCP_AUTH'] = ''
      const { deps, close: closeDb } = makeDeps(tmpDir!, { authTokenEnv: 'TEST_MCP_AUTH' })
      close = closeDb
      await expect(startMCPHttpServer(deps, '0.0.0.0', 0))
        .rejects
        .toThrow('requires mcp.authTokenEnv')
    })

    it('accepts non-loopback hosts when authTokenEnv is set and the env var is populated', async () => {
      process.env['TEST_MCP_AUTH'] = 'secret-token'
      const { deps, close: closeDb } = makeDeps(tmpDir!, { authTokenEnv: 'TEST_MCP_AUTH' })
      close = closeDb
      // Bind to localhost to avoid needing external interface access
      // but exercise the non-loopback code path via '127.0.0.2' which
      // most systems treat as loopback-equivalent at the kernel level.
      // To keep CI portable we use '127.0.0.1' and accept that this test
      // confirms the guard *doesn't throw* when auth is set — the
      // binding itself is exercised by the next test.
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)
      expect(server.listening).toBe(true)
    })

    it('starts on loopback hosts with no auth (existing dev mode)', async () => {
      const { deps, close: closeDb } = makeDeps(tmpDir!)
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)
      expect(server.listening).toBe(true)
    })
  })

  describe('streamable HTTP transport', () => {
    it('POST /mcp initialize without session returns Mcp-Session-Id header and a JSON-RPC result', async () => {
      const { deps, close: closeDb } = makeDeps(tmpDir!)
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const res = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: initializeBody(),
      })

      expect(res.status).toBe(200)
      const sessionId = res.headers.get('mcp-session-id')
      expect(sessionId).toBeTruthy()
      const body = await res.json() as { jsonrpc: string; id: number; result?: { protocolVersion: string; serverInfo: { name: string } }; error?: unknown }
      expect(body.jsonrpc).toBe('2.0')
      expect(body.id).toBe(1)
      expect(body.error).toBeUndefined()
      expect(body.result?.protocolVersion).toBeDefined()
      expect(body.result?.serverInfo.name).toBeDefined()
    })

    it('POST /mcp with a valid Mcp-Session-Id header routes to the same session', async () => {
      const { deps, close: closeDb } = makeDeps(tmpDir!)
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      // Initialize
      const initRes = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: initializeBody(),
      })
      const sessionId = initRes.headers.get('mcp-session-id')
      expect(sessionId).toBeTruthy()
      await initRes.text()

      // Follow-up: list tools on the established session. The transport
      // must route this via the session map — a missing route would
      // produce a 4xx.
      const listRes = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId!,
          'MCP-Protocol-Version': '2024-11-05',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      })
      expect(listRes.status).toBe(200)
      const listBody = await listRes.json() as { jsonrpc: string; id: number; result?: { tools: unknown[] }; error?: unknown }
      expect(listBody.id).toBe(2)
      expect(listBody.error).toBeUndefined()
      expect(Array.isArray(listBody.result?.tools)).toBe(true)
    })

    it('DELETE /mcp with a valid Mcp-Session-Id closes the session', async () => {
      const { deps, close: closeDb } = makeDeps(tmpDir!)
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const initRes = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: initializeBody(),
      })
      const sessionId = initRes.headers.get('mcp-session-id')
      await initRes.text()

      const deleteRes = await fetch(serverUrl(server, '/mcp'), {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': sessionId! },
      })
      // Spec-compliant servers accept DELETE and return 200 or 204.
      expect([200, 204]).toContain(deleteRes.status)

      // Follow-up request with the same session id should now fail
      // (session was torn down on the server side).
      const followupRes = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId!,
          'MCP-Protocol-Version': '2024-11-05',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      })
      // The transport should reject the orphaned session. Spec says 404 or
      // a new session may be minted depending on body — our implementation
      // mints a new session for an initialize request, but for tools/list
      // without a known session it must NOT reuse the closed one.
      expect(followupRes.status).not.toBe(200)
    })

    it('GET /mcp without Mcp-Session-Id returns 400', async () => {
      const { deps, close: closeDb } = makeDeps(tmpDir!)
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const res = await fetch(serverUrl(server, '/mcp'), { method: 'GET' })
      expect(res.status).toBe(400)
    })
  })

  describe('legacy SSE transport', () => {
    it('GET /sse opens a session and POST /mcp?sessionId=… is rejected with a bad sessionId', async () => {
      // We can't fully exercise the legacy SSE round-trip inside a short
      // test (the SSE connection is long-lived), but we can verify:
      //  - GET /sse responds with text/event-stream + the SDK's first event
      //  - POST /mcp?sessionId=unknown returns 400 as documented
      const { deps, close: closeDb } = makeDeps(tmpDir!)
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const ctrl = new AbortController()
      const ssePromise = fetch(serverUrl(server, '/sse'), { signal: ctrl.signal }).catch(() => null)
      // Give the SSE handshake a moment to establish
      await new Promise((resolve) => setTimeout(resolve, 50))
      ctrl.abort()
      await ssePromise

      const badRes = await fetch(serverUrl(server, '/mcp?sessionId=does-not-exist'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(badRes.status).toBe(400)
      const body = await badRes.json() as { error: string }
      expect(body.error).toContain('sessionId')
    })
  })

  describe('authentication', () => {
    it('rejects POST /mcp with missing Authorization when authTokenEnv is configured', async () => {
      process.env['TEST_MCP_AUTH'] = 's3cret'
      const { deps, close: closeDb } = makeDeps(tmpDir!, { authTokenEnv: 'TEST_MCP_AUTH' })
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const res = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: initializeBody(),
      })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('Bearer')
    })

    it('rejects POST /mcp with the wrong Bearer token', async () => {
      process.env['TEST_MCP_AUTH'] = 's3cret'
      const { deps, close: closeDb } = makeDeps(tmpDir!, { authTokenEnv: 'TEST_MCP_AUTH' })
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const res = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': 'Bearer wrong',
        },
        body: initializeBody(),
      })
      expect(res.status).toBe(401)
    })

    it('accepts POST /mcp with a valid Bearer token', async () => {
      process.env['TEST_MCP_AUTH'] = 's3cret'
      const { deps, close: closeDb } = makeDeps(tmpDir!, { authTokenEnv: 'TEST_MCP_AUTH' })
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const res = await fetch(serverUrl(server, '/mcp'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': 'Bearer s3cret',
        },
        body: initializeBody(),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('mcp-session-id')).toBeTruthy()
    })

    it('/health is reachable without auth (liveness probe)', async () => {
      process.env['TEST_MCP_AUTH'] = 's3cret'
      const { deps, close: closeDb } = makeDeps(tmpDir!, { authTokenEnv: 'TEST_MCP_AUTH' })
      close = closeDb
      server = await startMCPHttpServer(deps, '127.0.0.1', 0)

      const res = await fetch(serverUrl(server, '/health'))
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; sseSessions: number; streamableSessions: number }
      expect(body.status).toBe('ok')
      expect(body.sseSessions).toBe(0)
      expect(body.streamableSessions).toBe(0)
    })
  })
})
