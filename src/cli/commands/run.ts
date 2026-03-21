import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
import { SyncEngine } from '../../ops/sync.js'
import { ShutdownHandler } from '../../poller/shutdown.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

export async function runCommand(globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config)
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`)
      if (err.details) err.details.forEach((d) => console.error(d))
    } else {
      console.error((err as Error).message)
    }
    process.exitCode = 1
    return
  }

  const db = initDatabase(config.storage.dbPath)
  const intervalMs = config.github.pollIntervalSeconds * 1000

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
  shutdown.register()

  // Poll loop
  while (!shutdown.isShuttingDown) {
    try {
      const runPromise = pollOnce(config, db, dryRun).then(() => {})
      shutdown.trackRun(runPromise)
      const result = await pollOnce(config, db, dryRun)
      logger.info({ processed: result.processed, errors: result.errors }, 'Poll cycle complete')
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
