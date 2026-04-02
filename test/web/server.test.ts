import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest, type OutgoingHttpHeaders, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { startWebServer } from '../../src/web/server.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import type Database from 'better-sqlite3'

const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'

function makeMinimalConfig() {
  return {
    version: 1 as const,
    github: {
      tokenEnv: 'GITHUB_TOKEN',
      apiBaseUrl: 'https://api.github.com',
      pollIntervalSeconds: 300,
      appMentions: {},
    },
    storage: { dbPath: '', worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: {
      channels: [{ type: 'console' as const }],
      events: {
        onRunStarted: false,
        onBlocked: true,
        onPrReady: true,
        onError: true,
        onRetryExhausted: true,
      },
    },
    loop: {
      maxReviewIterations: 4,
      maxTotalAgentPasses: 10,
      stopOnPlannerFailure: true,
      requireVerificationPass: true,
      reviewApprovalKeyword: 'APPROVED',
      reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
      blockOnAmbiguousReview: true,
      maxAutoRetries: 3,
      decompose: false,
      maxSubtasks: 5,
      maxConcurrentSubtasks: 3,
    },
    security: {
      maxChangedFiles: 50,
      maxChangedLines: 5000,
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
    },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    observability: {
      agentStreaming: true,
      eventRetention: 1000,
      sessionLogs: false,
      sessionLogRetention: 7,
    },
    mcp: {
      enabled: true,
      transport: 'stdio' as const,
      authTokenEnv: null,
      httpHost: '127.0.0.1',
      httpPort: 0,
    },
    commentCommands: {
      enabled: true,
      requireCollaborator: false,
    },
    repos: [{
      repo: 'org/repo',
      forge: 'github' as const,
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: {
        ready: ['orch:ready'],
        running: 'orch:running',
        blocked: ['orch:blocked', 'orch:needs-human'],
        needsHuman: 'orch:needs-human',
        reviewReady: 'orch:review-ready',
        error: 'orch:error',
        retry: 'orch:retry',
        planning: 'orch:planning',
        mergeQueued: 'orch:merge-queued',
        merging: 'orch:merging',
        mergeFailed: 'orch:merge-failed',
      },
      defaults: {
        planner: 'claude' as const,
        coder: 'claude' as const,
        reviewer: 'claude' as const,
        doneMode: 'pr-ready' as const,
        notifyPriority: 'normal' as const,
        prMentions: [],
      },
      planning: {
        prdDirectory: 'docs/prd',
      },
      selectors: {
        includeLabelsAny: ['orch:ready'],
        excludeLabelsAny: ['orch:blocked', 'orch:error', 'orch:needs-human'],
      },
      verify: [],
      agents: {},
      linkedProjects: [],
      labelConfig: {},
      mergeQueue: {
        enabled: false,
        batchSize: 5,
        mergeMethod: 'merge' as const,
        retryFlakyOnce: true,
        requireApproval: true,
        stagingBranchPrefix: 'orch/staging',
      },
    }],
    workflows: {},
  }
}

describe('startWebServer', () => {
  let tmpDir: string
  let frontendDir: string
  let db: Database.Database
  let server: Server | null = null
  let baseUrl = ''
  let deps: MCPDependencies

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-web-test-'))
    frontendDir = join(tmpDir, 'frontend')
    mkdirSync(frontendDir, { recursive: true })
    writeFileSync(join(frontendDir, 'index.html'), '<!doctype html><html><body>ok</body></html>')

    db = initDatabase(join(tmpDir, 'test.db'))
    deps = {
      db,
      config: makeMinimalConfig() as MCPDependencies['config'],
      forgeAdapters: new Map(),
      poller: null,
      metrics: null,
    }
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = null
    }
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('serves API + static frontend', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        snapshotIntervalMs: 50,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const health = await fetch(`${baseUrl}/api/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({ status: 'ok' })
    const mutationToken = await getMutationToken(baseUrl)

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({}),
    })
    expect(poll.status).toBe(200)
    const pollPayload = await poll.json() as { queued: boolean; state: string }
    expect(pollPayload.queued).toBe(true)
    expect(pollPayload.state).toBe('woke-sleeper')
    expect(triggerPollCycle).toHaveBeenCalledTimes(1)

    const deleteEntry = await fetch(`${baseUrl}/api/operations/delete-entry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({ repo: 'org/repo', issueNumber: 999 }),
    })
    expect(deleteEntry.status).toBe(200)
    await expect(deleteEntry.json()).resolves.toMatchObject({ found: false })

    const index = await fetch(`${baseUrl}/`)
    expect(index.status).toBe(200)
    await expect(index.text()).resolves.toContain('<!doctype html>')
  })

  it('rejects mutating API requests without explicit mutation intent header', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(poll.status).toBe(403)
    await expect(poll.json()).resolves.toMatchObject({
      error: 'Missing required header: x-night-orch-intent',
    })
  })

  it('disables web operations when operationsEnabled is false', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        operationsEnabled: false,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const session = await fetch(`${baseUrl}/api/session`)
    expect(session.status).toBe(200)
    await expect(session.json()).resolves.toMatchObject({ operationsEnabled: false })

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(poll.status).toBe(409)
    await expect(poll.json()).resolves.toMatchObject({
      error: 'Web operations are disabled by server policy.',
    })
  })

  it('requires application/json for mutating API requests', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: '{}',
    })

    expect(poll.status).toBe(415)
    await expect(poll.json()).resolves.toMatchObject({
      error: 'Content-Type must be application/json',
    })
  })

  it('rejects forged Host/Origin pairs even when they match each other', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }

    baseUrl = `http://127.0.0.1:${address.port}`
    const mutationToken = await getMutationToken(baseUrl)

    const forged = await sendRawHttpRequest(address.port, '/api/operations/poll', {
      method: 'POST',
      headers: {
        Host: `evil.test:${address.port}`,
        Origin: `http://evil.test:${address.port}`,
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: '{}',
    })

    expect(forged.statusCode).toBe(403)
    expect(JSON.parse(forged.body) as { error: string }).toMatchObject({ error: 'Forbidden host' })
    expect(triggerPollCycle).toHaveBeenCalledTimes(0)

    const forgedWs = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://evil.test:${address.port}`,
      headers: { Host: `evil.test:${address.port}` },
    })

    const [errorPayload] = await once(forgedWs, 'error')
    expect(errorPayload).toBeInstanceOf(Error)
    const error = errorPayload as Error
    expect(error.message).toContain('Unexpected server response: 403')
  })

  it('enforces web mutation auth token and succeeds with a valid token when MCP auth is enabled', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }
    deps.config.mcp.authTokenEnv = 'NIGHT_ORCH_TEST_MCP_TOKEN'

    const previousToken = process.env['NIGHT_ORCH_TEST_MCP_TOKEN']
    process.env['NIGHT_ORCH_TEST_MCP_TOKEN'] = 'test-mcp-token'

    try {
      server = await startWebServer(
        deps,
        {
          host: '127.0.0.1',
          port: 0,
          frontendDistPath: frontendDir,
        },
      )

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Unexpected address type')
      }

      baseUrl = `http://127.0.0.1:${address.port}`
      const mutationToken = await getMutationToken(baseUrl)

      const missingToken = await fetch(`${baseUrl}/api/operations/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: 'mutate',
        },
        body: '{}',
      })
      expect(missingToken.status).toBe(401)
      await expect(missingToken.json()).resolves.toMatchObject({
        error: `Missing required header: ${WEB_AUTH_TOKEN_HEADER}`,
      })

      const invalidToken = await fetch(`${baseUrl}/api/operations/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: 'mutate',
          [WEB_AUTH_TOKEN_HEADER]: 'invalid-token',
        },
        body: '{}',
      })
      expect(invalidToken.status).toBe(403)
      await expect(invalidToken.json()).resolves.toMatchObject({
        error: 'Invalid web auth token',
      })

      const validToken = await fetch(`${baseUrl}/api/operations/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: 'mutate',
          [WEB_AUTH_TOKEN_HEADER]: mutationToken,
        },
        body: '{}',
      })
      expect(validToken.status).toBe(200)
      await expect(validToken.json()).resolves.toMatchObject({
        queued: true,
      })
      expect(triggerPollCycle).toHaveBeenCalledTimes(1)
    } finally {
      if (previousToken === undefined) {
        delete process.env['NIGHT_ORCH_TEST_MCP_TOKEN']
      } else {
        process.env['NIGHT_ORCH_TEST_MCP_TOKEN'] = previousToken
      }
    }
  })

  it('returns 404 for missing asset files but serves index fallback for extensionless routes', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`)
    expect(missingAsset.status).toBe(404)

    const clientRoute = await fetch(`${baseUrl}/runs/route-only`)
    expect(clientRoute.status).toBe(200)
    await expect(clientRoute.text()).resolves.toContain('<!doctype html>')
  })

  it('streams run events over websocket subscriptions', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 12,
      issueNodeId: 'node-12',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    db.prepare(
      `INSERT INTO agent_events (run_id, phase, role, event_type, data, created_at)
       VALUES (?, 'code', 'coder', 'text', '{"text":"hello"}', datetime('now'))`,
    ).run(run.id)

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        snapshotIntervalMs: 50,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const wsOrigin = `http://127.0.0.1:${address.port}`
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: wsOrigin })
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'subscribe-run-events', runId: run.id, since: 0 }))

    const runEvents = await waitForWsMessage<RunEventsPayload>(ws, (payload) => {
      if (!payload || typeof payload !== 'object') return null
      const message = payload as { type?: unknown; payload?: unknown }
      if (message.type !== 'run-events' || !message.payload || typeof message.payload !== 'object') return null
      const body = message.payload as { runId?: unknown; events?: unknown; lastEventId?: unknown }
      if (body.runId !== run.id || !Array.isArray(body.events) || body.events.length === 0) return null
      if (typeof body.lastEventId !== 'number') return null
      return body as RunEventsPayload
    }, 5000)

    expect(runEvents.runId).toBe(run.id)
    expect(runEvents.events[0]?.type).toBe('text')
    ws.close()

    const forbiddenWs = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: 'https://evil.example' })
    const [errorPayload] = await once(forbiddenWs, 'error')
    expect(errorPayload).toBeInstanceOf(Error)
    const error = errorPayload as Error
    expect(error.message).toContain('Unexpected server response: 403')
  })
})

async function getMutationToken(baseUrl: string): Promise<string> {
  const session = await fetch(`${baseUrl}/api/session`)
  expect(session.status).toBe(200)
  const payload = await session.json() as { mutationToken?: unknown }
  if (typeof payload.mutationToken !== 'string' || payload.mutationToken.length === 0) {
    throw new Error('Missing mutation token in /api/session response')
  }
  return payload.mutationToken
}

async function sendRawHttpRequest(
  port: number,
  path: string,
  options: {
    method: string
    headers?: OutgoingHttpHeaders
    body?: string
  },
): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
      },
    )

    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

async function waitForWsMessage<T>(
  ws: WebSocket,
  matcher: (payload: unknown) => T | null,
  timeoutMs: number,
): Promise<T> {
  const timeout = new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for websocket message')), timeoutMs)
  })

  const stream = new Promise<T>((resolve) => {
    ws.on('message', (raw) => {
      let parsed: unknown
      try {
        const message = decodeWsRaw(raw)
        if (message === null) return
        parsed = JSON.parse(message) as unknown
      } catch {
        return
      }
      const match = matcher(parsed)
      if (match) {
        resolve(match)
      }
    })
  })

  return Promise.race([timeout, stream])
}

function decodeWsRaw(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw instanceof Buffer) return raw.toString('utf-8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8')
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf-8')
  }
  return null
}
