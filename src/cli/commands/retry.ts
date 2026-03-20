import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { LeaseManager } from '../../state/leases.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

export async function retryCommand(
  repo: string,
  issueNumber: string,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const num = parseInt(issueNumber, 10)
  if (isNaN(num)) {
    console.error(`Invalid issue number: ${issueNumber}`)
    process.exitCode = 1
    return
  }

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

  // Find the latest run for this issue
  const run = db
    .prepare('SELECT id, status FROM runs WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC LIMIT 1')
    .get(repo, num) as { id: string; status: string } | undefined

  if (!run) {
    console.error(`No run found for ${repo}#${num}`)
    process.exitCode = 1
    db.close()
    return
  }

  if (run.status !== 'blocked' && run.status !== 'error') {
    console.error(`Run ${run.id} is in status "${run.status}" — can only retry blocked or error runs`)
    process.exitCode = 1
    db.close()
    return
  }

  // Reset the run
  db.prepare(
    "UPDATE runs SET status = 'queued', current_phase = NULL, phase_data = NULL, last_error = NULL, ended_at = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(run.id)

  // Release any lease
  leaseManager.release(repo, num)

  logger.info({ runId: run.id, repo, issue: num }, 'Run reset to queued for retry')
  console.log(`Reset run ${run.id} for ${repo}#${num} to queued`)
  db.close()
}
