import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import type { UpdateStrategy } from '../../git/worktree.js'
import { initDatabase } from '../../state/db.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { queueRebase } from '../../ops/rebase-and-check.js'
import { requestExternalPollCycle } from '../../poller/control.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
  strategy?: UpdateStrategy
}

export async function rebaseCommand(
  repo: string,
  issueNumber: string,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const strategy = normalizeStrategy(globalOpts?.strategy)
  if (globalOpts?.strategy && !strategy) {
    console.error(`Invalid strategy: ${globalOpts.strategy}. Expected merge or rebase.`)
    process.exitCode = 1
    return
  }
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
    const result = await queueRebase({
      db,
      forge,
      repoConfig,
      issueNumber: num,
      botUser,
      strategyOverride: strategy,
      trigger: { kind: 'cli' },
      maxAttemptChainLength: config.loop.maxAttemptChainLength,
    })

    if (result.queued) {
      requestExternalPollCycle(config.storage.dbPath)
      console.log(`Queued ${repo}#${num} for rebase and re-evaluation`)
      console.log('The poller will rebase, verify, and fix any issues on the next cycle.')
      console.log('Requested an immediate poll cycle for any running daemon using this database.')
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

function normalizeStrategy(value: unknown): UpdateStrategy | undefined {
  return value === 'merge' || value === 'rebase' ? value : undefined
}
