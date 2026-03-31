import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { rebaseAndCheck } from '../../ops/rebase-and-check.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface RebaseCommandOpts extends GlobalOpts {
  check?: boolean
}

export async function rebaseCommand(
  repo: string,
  issueNumber: string,
  globalOpts?: RebaseCommandOpts,
): Promise<void> {
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
    const checkAfter = globalOpts?.check !== false
    const result = await rebaseAndCheck(db, forge, repoConfig, num, botUser, checkAfter)

    console.log(`Rebase result: ${result.rebaseResult}`)
    if (result.verifyPassed !== null) {
      console.log(`Verify: ${result.verifyPassed ? 'PASSED' : 'FAILED'}`)
    }
    if (result.requeued) {
      console.log('Issue re-queued for coder to fix')
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}
