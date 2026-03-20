import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

export async function runOnceCommand(globalOpts?: GlobalOpts): Promise<void> {
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

  try {
    const result = await pollOnce(config, db, dryRun)
    logger.info({ processed: result.processed, errors: result.errors }, 'Run-once complete')

    if (result.errors > 0) {
      process.exitCode = 1
    }
  } catch (err) {
    logger.error({ err }, 'Run-once failed')
    process.exitCode = 1
  } finally {
    db.close()
  }
}
