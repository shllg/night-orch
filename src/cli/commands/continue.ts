import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { queueContinue } from '../../ops/continue.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

export async function continueCommand(
  repo: string,
  issueNumber: string,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false
  const num = parseInt(issueNumber, 10)
  if (isNaN(num)) {
    console.error(`Invalid issue number: ${issueNumber}`)
    process.exitCode = 1
    return
  }

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
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

  const repoConfig = config.repos.find((r) => r.repo === repo)
  if (!repoConfig) {
    console.error(`Repository "${repo}" not found in config`)
    process.exitCode = 1
    return
  }

  const db = initDatabase(config.storage.dbPath)
  const forge = createForgeAdapter(repoConfig, config)

  let botUser = ''
  try {
    const authInfo = await forge.validateAuth()
    botUser = authInfo.user
  } catch {
    // Best effort
  }

  try {
    const result = await queueContinue(db, forge, repoConfig, num, botUser, { dryRun })

    if (result.queued) {
      if (dryRun) {
        console.log(`Continue preview for ${repo}#${num}`)
        console.log('(dry run — no changes applied)')
      } else {
        console.log(`Queued ${repo}#${num} for a continue pass`)
      }
      console.log(result.reason)
    } else {
      console.log(`Not queued: ${result.reason}`)
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}
