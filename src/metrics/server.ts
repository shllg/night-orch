import { createServer, type Server } from 'node:http'
import type { Metrics } from './collectors.js'
import { logger } from '../utils/logger.js'

/**
 * Start an HTTP server serving Prometheus metrics on /metrics
 * and a JSON summary on /api/stats.
 */
export function startMetricsServer(
  metrics: Metrics,
  host: string,
  port: number,
): Server {
  const server = createServer(async (req, res) => {
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

  server.listen(port, host, () => {
    logger.info({ host, port }, 'Metrics server started')
  })

  return server
}
