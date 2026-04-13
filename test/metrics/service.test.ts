import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMetricsService, type MetricsService } from '../../src/metrics/service.js'
import http from 'node:http'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function getMetrics(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/metrics`, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    }).on('error', reject)
  })
}

describe('MetricsService', () => {
  let service: MetricsService
  let port: number

  beforeEach(() => {
    // Use a random high port to avoid conflicts
    port = 19000 + Math.floor(Math.random() * 1000)
  })

  afterEach(async () => {
    if (service) {
      await service.stop()
    }
  })

  describe('disabled', () => {
    it('all methods are no-ops, no server started', async () => {
      service = createMetricsService({ enabled: false, host: '127.0.0.1', port })
      expect(service.ready).toBe(false)
      expect(service.endpoint).toBeNull()

      // Methods should not throw
      service.incRunsTotal('completed')
      service.incAgentInvocations('planner', 'claude')
      service.incLoopIterations('org/repo')
      service.incVerifyRuns('pass')
      service.incPROperations('created')
      service.incNotifications('console', 'sent')
      service.observeRunDuration(10)
      service.observePhaseDuration('plan', 5)
      service.observeAgentDuration('planner', 'claude', 3)
      service.observeVerifyDuration(2)
      service.setActiveRuns(1)
      service.setDailyCost(5.0)
      service.setEligibleIssues('org/repo', 3)
      service.addEstimatedCost('org/repo', 'unknown', 1.5)

      // No server running — connection should fail
      await expect(getMetrics(port)).rejects.toThrow()
    })

    it('getRegistry returns empty registry', () => {
      service = createMetricsService({ enabled: false, host: '127.0.0.1', port })
      const registry = service.getRegistry()
      expect(registry).toBeDefined()
    })
  })

  describe('enabled', () => {
    it('server starts on configured port', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      expect(service.ready).toBe(false)
      expect(service.endpoint).toEqual({ host: '127.0.0.1', port })
      await service.start()
      expect(service.ready).toBe(true)

      // Small delay for server to be ready

      const body = await getMetrics(port)
      expect(body).toContain('night_orch_')
    })

    it('/metrics returns valid Prometheus exposition format', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()

      const body = await getMetrics(port)
      // Prometheus format has HELP and TYPE lines
      expect(body).toContain('# HELP')
      expect(body).toContain('# TYPE')
    })

    it('non-/metrics path returns 404', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()

      const { status } = await httpGet(port, '/nonexistent')
      expect(status).toBe(404)
    })

    it('/healthz returns readiness payload', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()

      const { status, body } = await httpGet(port, '/healthz')
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

    it('counter increment reflected in output', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()

      service.incRunsTotal('completed')
      service.incRunsTotal('completed')

      const body = await getMetrics(port)
      expect(body).toContain('night_orch_runs_total{status="completed"} 2')
    })

    it('histogram observation reflected in output', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()

      service.observeRunDuration(120)

      const body = await getMetrics(port)
      expect(body).toContain('night_orch_run_duration_seconds_count 1')
    })

    it('gauge set reflected in output', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()

      service.setActiveRuns(3)

      const body = await getMetrics(port)
      expect(body).toContain('night_orch_active_runs 3')
    })

    it('graceful stop closes server', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()
      expect(service.ready).toBe(true)

      await service.stop()
      expect(service.ready).toBe(false)

      // Connection should fail after stop
      await expect(getMetrics(port)).rejects.toThrow()
    })

    it('addEstimatedCost(0) is a no-op', async () => {
      service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
      await service.start()

      service.addEstimatedCost('org/repo', 'claude', 0)

      const body = await getMetrics(port)
      expect(body).not.toContain('night_orch_estimated_cost_dollars{repo="org/repo",agent="claude"}')
    })

    it('start rejects when port is already in use', async () => {
      const occupiedServer = http.createServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
      await new Promise<void>((resolve) => {
        occupiedServer.listen(port, '127.0.0.1', resolve)
      })

      try {
        service = createMetricsService({ enabled: true, host: '127.0.0.1', port })
        await expect(service.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      } finally {
        await new Promise<void>((resolve, reject) => {
          occupiedServer.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }
    })
  })
})
