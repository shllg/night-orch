import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import { startWebServer } from '../../src/web/server.js'
import { makeTestConfig } from '../helpers/factories.js'

const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const WEB_AUTH_TOKEN = 'csrf-test-token'

describe('web CSRF protection', () => {
  let tmpDir: string
  let frontendDir: string
  let db: Database.Database
  let server: Server | null
  let baseUrl: string
  let deps: MCPDependencies
  let priorWebToken: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-csrf-test-'))
    frontendDir = join(tmpDir, 'frontend')
    mkdirSync(frontendDir, { recursive: true })
    writeFileSync(join(frontendDir, 'index.html'), '<!doctype html><html><body>ok</body></html>')

    db = initDatabase(join(tmpDir, 'test.db'))
    deps = {
      db,
      config: makeTestConfig({ storage: { worktreeRoot: tmpDir } }),
      forgeAdapters: new Map(),
      poller: {
        triggerPollCycle: vi.fn().mockReturnValue({
          accepted: true as const,
          state: 'woke-sleeper' as const,
        }),
      },
      metrics: null,
    }
    server = null
    baseUrl = ''
    priorWebToken = process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
    process.env['NIGHT_ORCH_WEB_AUTH_TOKEN'] = WEB_AUTH_TOKEN
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = null
    }
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
    if (priorWebToken === undefined) {
      delete process.env['NIGHT_ORCH_WEB_AUTH_TOKEN']
    } else {
      process.env['NIGHT_ORCH_WEB_AUTH_TOKEN'] = priorWebToken
    }
  })

  it('rejects cookie-authenticated mutation requests without x-csrf-token', async () => {
    await start()
    const { sessionCookie } = await loginAndGetCookies()

    const res = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        [MUTATION_INTENT_HEADER]: 'mutate',
        cookie: sessionCookie,
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/csrf/i),
    })
  })

  it('accepts cookie-authenticated mutation requests with matching x-csrf-token', async () => {
    await start()
    const { sessionCookie, csrfCookie } = await loginAndGetCookies()
    const csrfToken = csrfCookie.split('=')[1]

    const res = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        [MUTATION_INTENT_HEADER]: 'mutate',
        'x-csrf-token': csrfToken,
        cookie: `${sessionCookie}; ${csrfCookie}`,
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      queued: true,
    })
  })

  it('emits Secure __Host cookies when trustedProxy sees HTTPS', async () => {
    deps.config = makeTestConfig({
      storage: { worktreeRoot: tmpDir },
      web: { trustedProxy: true },
    } as Parameters<typeof makeTestConfig>[0])
    await start()

    const login = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        'x-forwarded-proto': 'https',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: JSON.stringify({ token: WEB_AUTH_TOKEN }),
    })

    expect(login.status).toBe(204)
    const setCookie = login.headers.get('set-cookie')
    expect(setCookie).toContain('__Host-night-orch-session=')
    expect(setCookie).toContain('__Host-night-orch-csrf=')
    expect(setCookie).toContain('Secure')
  })

  it('clears Secure __Host cookies on logout', async () => {
    deps.config = makeTestConfig({
      storage: { worktreeRoot: tmpDir },
      web: { trustedProxy: true },
    } as Parameters<typeof makeTestConfig>[0])
    await start()

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        'x-forwarded-proto': 'https',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: JSON.stringify({}),
    })

    expect(logout.status).toBe(204)
    const setCookie = logout.headers.get('set-cookie')
    expect(setCookie).toContain('__Host-night-orch-session=')
    expect(setCookie).toContain('__Host-night-orch-csrf=')
    expect(setCookie).toContain('Max-Age=0')
    expect(setCookie).toContain('Secure')
  })

  async function start(): Promise<void> {
    server = await startWebServer(deps, {
      host: '0.0.0.0',
      port: 0,
      allowedHosts: ['127.0.0.1'],
      frontendDistPath: frontendDir,
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  }

  async function loginAndGetCookies(): Promise<{ sessionCookie: string; csrfCookie: string }> {
    const login = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: JSON.stringify({ token: WEB_AUTH_TOKEN }),
    })
    expect(login.status).toBe(204)
    const setCookie = login.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    const cookies = setCookie!.split(/,\s*(?=[^;,]+=)/).map((cookie) => cookie.split(';')[0]!)
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('norch_session='))
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('norch_csrf='))
    if (!sessionCookie || !csrfCookie) {
      throw new Error(`Missing session or CSRF cookie in ${setCookie}`)
    }
    return { sessionCookie, csrfCookie }
  }
})
