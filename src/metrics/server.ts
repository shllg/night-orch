import { createServer, type Server, type ServerResponse } from 'node:http'
import type { Metrics } from './collectors.js'
import { logger } from '../utils/logger.js'
import { getBuildInfo } from '../utils/build-info.js'

/**
 * Start an HTTP server serving Prometheus metrics on /metrics
 * and a JSON summary on /api/stats.
 */
export function startMetricsServer(
  metrics: Metrics,
  host: string,
  port: number,
): Server {
  const version = getBuildInfo().version
  let startedAt: string | null = null
  let healthzHandler: ((res: ServerResponse) => Promise<void>) | null = null

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      if (!healthzHandler) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ready: false,
          registrySize: 0,
          version,
          startedAt: null,
        }))
        return
      }
      await healthzHandler(res)
      return
    }

    if (req.url === '/metrics') {
      try {
        const metricsOutput = await metrics.registry.metrics()
        res.writeHead(200, { 'Content-Type': metrics.registry.contentType })
        res.end(metricsOutput)
      } catch (err) {
        res.writeHead(500)
        res.end(String(err))
      }
    } else if (req.url === '/api/stats') {
      try {
        const metricsJson = await metrics.registry.getMetricsAsJSON()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(metricsJson))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: String(err) }))
      }
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  server.on('listening', () => {
    startedAt = new Date().toISOString()
    healthzHandler = async (res) => {
      try {
        const metricFamilies = await metrics.registry.getMetricsAsJSON()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ready: server.listening,
          registrySize: metricFamilies.length,
          version,
          startedAt,
        }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    }
  })

  server.listen(port, host, () => {
    logger.info({ host, port }, 'Metrics server started')
  })

  return server
}
