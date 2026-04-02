import type { Server } from 'node:http'
import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
import { SyncEngine } from '../../ops/sync.js'
import { ShutdownHandler } from '../../poller/shutdown.js'
import { PollCycleController } from '../../poller/control.js'
import { createMetricsService, type MetricsService } from '../../metrics/service.js'
import { createForgeAdapter } from '../../forge/factory.js'
import type { ForgeAdapter } from '../../forge/types.js'
import { startMCPHttpServer } from '../../mcp/http.js'
import { startWebServer } from '../../web/server.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface WebCommandOpts {
  host?: string
  allowedHost?: string[] | string
  port?: string | number
  snapshotIntervalMs?: string | number
  standalone?: boolean
}

export async function webCommand(
  commandOpts: WebCommandOpts,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
      if (err.details) err.details.forEach((d) => process.stderr.write(`${d}\n`))
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exitCode = 1
    return
  }

  const host = normalizeHost(commandOpts.host)
  const allowedHosts = normalizeAllowedHosts(commandOpts.allowedHost)
  const port = normalizePort(commandOpts.port, 3200)
  const snapshotIntervalMs = normalizePort(commandOpts.snapshotIntervalMs, 3000)
  const standalone = commandOpts.standalone ?? false

  const db = initDatabase(config.storage.dbPath)
  const intervalMs = config.github.pollIntervalSeconds * 1000

  // Start metrics service (standalone mode only)
  let metrics: MetricsService | undefined
  if (standalone && config.metrics) {
    metrics = createMetricsService(config.metrics)
    try {
      await metrics.start()
    } catch (err) {
      logger.warn({ err }, 'Failed to start metrics server — continuing without metrics')
      metrics = undefined
    }
  }

  if (standalone) {
    // Crash recovery: release all leases and reconcile stale runs.
    try {
      const { LeaseManager } = await import('../../state/leases.js')
      const leaseManager = new LeaseManager(db)
      const releasedLeases = leaseManager.releaseAll()
      if (releasedLeases > 0) {
        logger.info({ releasedLeases }, 'Released orphaned leases from previous run')
      }

      const syncEngine = new SyncEngine(db, config)
      const syncResult = await syncEngine.reconcile(dryRun)
      if (syncResult.reconciledRuns.length > 0 || syncResult.expiredLeases > 0) {
        logger.info(
          { reconciled: syncResult.reconciledRuns.length, expiredLeases: syncResult.expiredLeases },
          'Startup sync complete',
        )
      }
    } catch (err) {
      logger.warn({ err }, 'Startup sync failed — continuing')
    }
  }

  const forgeAdapters = new Map<string, ForgeAdapter>()
  for (const repo of config.repos) {
    try {
      forgeAdapters.set(repo.repo, createForgeAdapter(repo, config))
    } catch (err) {
      logger.warn({ repo: repo.repo, err }, 'Failed to create forge adapter')
    }
  }

  // Start optional embedded MCP server (standalone mode only).
  const pollerControl = standalone ? new PollCycleController() : null
  let mcpServer: Server | undefined
  if (standalone && config.mcp.enabled) {
    try {
      mcpServer = await startMCPHttpServer(
        { db, config, forgeAdapters, poller: pollerControl, metrics: metrics ?? null },
        config.mcp.httpHost,
        config.mcp.httpPort,
      )
    } catch (err) {
      logger.warn({ err }, 'Failed to start MCP HTTP server — continuing without MCP')
    }
  }

  // Start web API + frontend server.
  let webServer: Server | undefined
  try {
    webServer = await startWebServer(
      { db, config, forgeAdapters, poller: pollerControl, metrics: metrics ?? null },
      { host, allowedHosts, port, snapshotIntervalMs, operationsEnabled: true },
    )
  } catch (err) {
    logger.error({ err, host, allowedHosts, port }, 'Failed to start web server')
    if (mcpServer) {
      await new Promise<void>((resolve) => mcpServer?.close(() => resolve()))
    }
    if (metrics) {
      try { await metrics.stop() } catch { /* ignore */ }
    }
    db.close()
    process.exitCode = 1
    return
  }

  // Graceful shutdown
  const shutdown = new ShutdownHandler(db)
  shutdown.register(async () => {
    if (webServer) {
      const serverToClose = webServer
      await new Promise<void>((resolve) => serverToClose.close(() => resolve()))
    }

    if (mcpServer) {
      const serverToClose = mcpServer
      await new Promise<void>((resolve) => serverToClose.close(() => resolve()))
    }

    if (metrics) {
      try { await metrics.stop() } catch { /* ignore */ }
    }
  })

  if (!standalone) {
    logger.info({ host, port }, 'Starting web control surface (attach mode)')
    await new Promise<void>(() => {})
    return
  }

  logger.info({ intervalMs, dryRun, repos: config.repos.length, host, port }, 'Starting web poller')

  // Poll loop
  while (!shutdown.isShuttingDown) {
    try {
      const runPromise = pollOnce(config, db, dryRun, metrics).then(() => {})
      shutdown.trackRun(runPromise)
      await runPromise
    } catch (err) {
      logger.error({ err }, 'Poll cycle failed')
    }

    if (shutdown.isShuttingDown) break

    const waitResult = await pollerControl!.waitForNextCycle(intervalMs)
    if (waitResult === 'manual') {
      logger.info('Manual poll trigger received — running next cycle immediately')
    }
  }
}

function normalizeHost(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '127.0.0.1'
}

function normalizePort(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : NaN

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

function normalizeAllowedHosts(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  return []
}
