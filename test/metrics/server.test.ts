import { afterEach, describe, expect, it, vi } from 'vitest'
import http, { type Server } from 'node:http'
import { createMetricsRegistry } from '../../src/metrics/collectors.js'
import { startMetricsServer } from '../../src/metrics/server.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function httpRequest(
  port: number,
  path: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('startMetricsServer', () => {
  let server: Server | null = null
  let port = 0

  afterEach(async () => {
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    server = null
  })

  it('exposes /healthz readiness metadata after bind', async () => {
    port = 19800 + Math.floor(Math.random() * 500)
    const metrics = createMetricsRegistry()

    server = startMetricsServer(metrics, '127.0.0.1', port)
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve)
      server?.once('error', reject)
    })

    const { status, body } = await httpRequest(port, '/healthz')
    expect(status).toBe(200)
    const payload = JSON.parse(body) as {
      ready: boolean
      registrySize: number
      version: string
      startedAt: string
    }
    expect(payload.ready).toBe(true)
    expect(payload.registrySize).toBeGreaterThan(0)
    expect(payload.version).toMatch(/\S+/)
    expect(payload.startedAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps /healthz as GET-only route', async () => {
    port = 19800 + Math.floor(Math.random() * 500)
    const metrics = createMetricsRegistry()

    server = startMetricsServer(metrics, '127.0.0.1', port)
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve)
      server?.once('error', reject)
    })

    const { status } = await httpRequest(port, '/healthz', 'POST')
    expect(status).toBe(404)
  })
})
