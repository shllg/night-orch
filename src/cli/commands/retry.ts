import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { RetryEngine } from '../../ops/retry.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

interface RetryCommandOpts extends GlobalOpts {
  immediate?: boolean
  resetPlan?: boolean
}

export async function retryCommand(
  repo: string,
  issueNumber: string,
  globalOpts?: RetryCommandOpts,
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

  try {
    const engine = new RetryEngine(db, config)
    await engine.retry(repo, num, {
      immediate: globalOpts?.immediate ?? false,
      resetPlan: globalOpts?.resetPlan ?? false,
      dryRun: globalOpts?.dryRun ?? false,
    })

    console.log(`Retry queued for ${repo}#${num}`)
    if (globalOpts?.immediate) console.log('Immediate processing started')
    if (globalOpts?.dryRun) console.log('(dry run — no changes applied)')
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}
