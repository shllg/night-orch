import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
import { SyncEngine } from '../../ops/sync.js'
import { warnIncompleteRebaseFanouts } from '../../ops/fanout-rebase.js'
import { logger } from '../../utils/logger.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { createNdjsonWriter, ndjsonError } from '../ndjson.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
  ndjson?: boolean
}

export async function runOnceCommand(globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false
  const emitNdjson = createNdjsonWriter(globalOpts?.ndjson ?? false, 'run-once')

  let baseConfig
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    baseConfig = loadConfig(configPath)
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

  const db = initDatabase(baseConfig.storage.dbPath)
  const runtimeConfig = resolveConfigWithRuntimeSettings(baseConfig, db)

  try {
    // Crash recovery: release orphaned leases and reconcile stale runs.
    try {
      const { LeaseManager } = await import('../../state/leases.js')
      const leaseManager = new LeaseManager(db)
      const releasedLeases = leaseManager.releaseAll()
      if (releasedLeases > 0) {
        logger.info({ releasedLeases }, 'Released orphaned leases from previous run')
      }

      const syncEngine = new SyncEngine(db, runtimeConfig)
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
    warnIncompleteRebaseFanouts(db)

    emitNdjson('poll_start', { dryRun })
    const result = await pollOnce(runtimeConfig, db, dryRun)
    emitNdjson('poll_result', { dryRun, processed: result.processed, errors: result.errors })
    logger.info({ processed: result.processed, errors: result.errors }, 'Run-once complete')

    if (result.errors > 0) {
      process.exitCode = 1
    }
  } catch (err) {
    emitNdjson('poll_error', { dryRun, error: ndjsonError(err) })
    logger.error({ err }, 'Run-once failed')
    process.exitCode = 1
  } finally {
    db.close()
  }
}
