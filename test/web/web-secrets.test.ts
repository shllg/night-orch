import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { WebSecretStore } from '../../src/state/web-secrets.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import { startWebServer } from '../../src/web/server.js'
import { SESSION_COOKIE_NAME } from '../../src/web/auth.js'
import { makeTestConfig } from '../helpers/factories.js'

describe('WebSecretStore', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-web-secrets-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns the same session secret and loopback token across instances', () => {
    const first = new WebSecretStore(db)
    const secret1 = first.getOrCreateSessionSecret()
    const token1 = first.getOrCreateLoopbackToken()

    const second = new WebSecretStore(db)
    expect(second.getOrCreateSessionSecret().equals(secret1)).toBe(true)
    expect(second.getOrCreateLoopbackToken()).toBe(token1)
  })

  it('generates a 32-byte session secret', () => {
    expect(new WebSecretStore(db).getOrCreateSessionSecret().length).toBe(32)
  })
})

describe('web server secret persistence across restart', () => {
  let tmpDir: string
  let frontendDir: string
  let runtimeDir: string
  let dbPath: string
  let db: Database.Database
  let server: Server | null
  let baseUrl: string
  let priorRuntimeDir: string | undefined
  let priorWebToken: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-web-restart-test-'))
    frontendDir = join(tmpDir, 'frontend')
    runtimeDir = join(tmpDir, 'runtime')
    dbPath = join(tmpDir, 'test.db')
    mkdirSync(frontendDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    db = initDatabase(dbPath)
    server = null
    baseUrl = ''
    priorRuntimeDir = process.env['XDG_RUNTIME_DIR']
    priorWebToken = process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
    process.env['XDG_RUNTIME_DIR'] = runtimeDir
    delete process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
  })

  afterEach(async () => {
    await stop()
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

  it('keeps the same loopback token and a valid session cookie after a restart', async () => {
    const tokenPath = join(runtimeDir, 'night-orch-web.token')

    // First boot: capture loopback token + mint a session cookie.
    await start()
    const firstToken = readFileSync(tokenPath, 'utf8')
    const loginRes = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-night-orch-intent': 'mutate' },
      body: JSON.stringify({ token: firstToken }),
    })
    expect(loginRes.status).toBe(204)
    const cookie = sessionCookiePair(loginRes)
    expect(cookie).not.toBeNull()

    // Simulate restart: close the server, reopen the DB, start again.
    await stop()
    db.close()
    db = initDatabase(dbPath)
    await start()

    // Loopback token is unchanged.
    expect(readFileSync(tokenPath, 'utf8')).toBe(firstToken)

    // The pre-restart cookie still validates after the restart.
    const checkRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie: cookie as string },
    })
    expect(checkRes.status).toBe(200)
    const body = (await checkRes.json()) as Record<string, unknown>
    expect(body.authenticated).toBe(true)
  })

  function sessionCookiePair(res: Response): string | null {
    const cookies = res.headers.getSetCookie()
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    if (!sessionCookie) return null
    return sessionCookie.split(';')[0] ?? null
  }

  async function start(): Promise<void> {
    const deps: MCPDependencies = {
      db,
      config: makeTestConfig({ storage: { worktreeRoot: tmpDir } }),
      forgeAdapters: new Map(),
      poller: null,
      metrics: null,
    }
    server = await startWebServer(deps, {
      host: '127.0.0.1',
      port: 0,
      frontendDistPath: frontendDir,
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  }

  async function stop(): Promise<void> {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = null
    }
  }
})
