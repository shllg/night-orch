import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
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

  logger.info({ intervalMs, dryRun, repos: config.repos.length }, 'Starting poller')

  // Graceful shutdown
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    logger.info('Shutting down gracefully...')
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Poll loop
  while (!stopping) {
    try {
      const result = await pollOnce(config, db, dryRun)
      logger.info({ processed: result.processed, errors: result.errors }, 'Poll cycle complete')
    } catch (err) {
      logger.error({ err }, 'Poll cycle failed')
    }

    // Wait for next interval
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs)
      if (stopping) {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
