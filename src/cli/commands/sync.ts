import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { LeaseManager } from '../../state/leases.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

export async function syncCommand(globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config)
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`)
    } else {
      console.error((err as Error).message)
    }
    process.exitCode = 1
    return
  }

  const db = initDatabase(config.storage.dbPath)
  const leaseManager = new LeaseManager(db)

  // Clean stale running runs (crash recovery)
  const staleRuns = db
    .prepare("SELECT id, repo, issue_number FROM runs WHERE status = 'running'")
    .all() as Array<{ id: string; repo: string; issue_number: number }>

  for (const run of staleRuns) {
    if (dryRun) {
      console.log(`[dry-run] Would mark stale run ${run.id} (#${run.issue_number}) as error`)
    } else {
      db.prepare(
        "UPDATE runs SET status = 'error', last_error = 'Stale run detected during sync', ended_at = datetime('now') WHERE id = ?",
      ).run(run.id)
      leaseManager.release(run.repo, run.issue_number)
      logger.info({ runId: run.id, issue: run.issue_number }, 'Marked stale run as error')
    }
  }

  // Clean expired leases
  const expired = leaseManager.cleanExpired()

  console.log(`Sync complete: ${staleRuns.length} stale run(s), ${expired} expired lease(s)`)
  db.close()
}
