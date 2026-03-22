import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
import { SyncEngine } from '../../ops/sync.js'
import { ShutdownHandler } from '../../poller/shutdown.js'
import { createMetricsService, type MetricsService } from '../../metrics/service.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

export async function runCommand(globalOpts?: GlobalOpts): Promise<void> {
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

  const db = initDatabase(config.storage.dbPath)
  const intervalMs = config.github.pollIntervalSeconds * 1000

  // Start metrics service
  let metrics: MetricsService | undefined
  if (config.metrics) {
    metrics = createMetricsService(config.metrics)
    try {
      await metrics.start()
    } catch (err) {
      logger.warn({ err }, 'Failed to start metrics server — continuing without metrics')
      metrics = undefined
    }
  }

  // Crash recovery: sync stale runs on startup
  try {
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

  logger.info({ intervalMs, dryRun, repos: config.repos.length }, 'Starting poller')

  // Graceful shutdown
  const shutdown = new ShutdownHandler(db)
  shutdown.register(async () => {
    if (metrics) {
      try { await metrics.stop() } catch { /* ignore */ }
    }
  })

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

    // Wait for next interval
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs)
      if (shutdown.isShuttingDown) {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
