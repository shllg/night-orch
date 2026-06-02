import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import { startWebServer } from '../../src/web/server.js'
import { makeTestConfig } from '../helpers/factories.js'

describe('web loopback token', () => {
  let tmpDir: string
  let frontendDir: string
  let runtimeDir: string
  let db: Database.Database
  let server: Server | null
  let baseUrl: string
  let deps: MCPDependencies
  let priorRuntimeDir: string | undefined
  let priorWebToken: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-loopback-token-test-'))
    frontendDir = join(tmpDir, 'frontend')
    runtimeDir = join(tmpDir, 'runtime')
    mkdirSync(frontendDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })

    db = initDatabase(join(tmpDir, 'test.db'))
    deps = {
      db,
      config: makeTestConfig({ storage: { worktreeRoot: tmpDir } }),
      forgeAdapters: new Map(),
      poller: null,
      metrics: null,
    }
    server = null
    baseUrl = ''
    priorRuntimeDir = process.env['XDG_RUNTIME_DIR']
    priorWebToken = process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
    process.env['XDG_RUNTIME_DIR'] = runtimeDir
    delete process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = null
    }
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
    if (priorRuntimeDir === undefined) {
      delete process.env['XDG_RUNTIME_DIR']
    } else {
      process.env['XDG_RUNTIME_DIR'] = priorRuntimeDir
    }
    if (priorWebToken === undefined) {
      delete process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
    } else {
      process.env['NIGHT_ORCH_WEB_AUTH_TOKEN'] = priorWebToken
    }
  })

  it('/api/session does not return mutationToken in loopback mode', async () => {
    await start()

    const res = await fetch(`${baseUrl}/api/session`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    expect(body).not.toHaveProperty('mutationToken')
    expect(body).toMatchObject({
      requiresExternalAuth: false,
      loopbackTokenHint: {
        path: join(runtimeDir, 'night-orch-web.token'),
        stdoutPrinted: true,
      },
    })
  })

  it('writes the loopback token sidecar with mode 0600', async () => {
    await start()

    const tokenPath = join(runtimeDir, 'night-orch-web.token')
    expect(existsSync(tokenPath)).toBe(true)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
  })

  it('does not advertise a loopback token when auth is disabled', async () => {
    await start({ requireAuth: false })

    const res = await fetch(`${baseUrl}/api/session`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    expect(body).not.toHaveProperty('mutationToken')
    expect(body).toMatchObject({
      requiresExternalAuth: false,
      loopbackTokenHint: null,
    })
    expect(existsSync(join(runtimeDir, 'night-orch-web.token'))).toBe(false)
  })

  async function start(options: { requireAuth?: boolean } = {}): Promise<void> {
    server = await startWebServer(deps, {
      host: '127.0.0.1',
      port: 0,
      frontendDistPath: frontendDir,
      ...options,
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  }
})
