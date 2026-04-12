import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import type { UpdateStrategy } from '../../git/worktree.js'
import { initDatabase } from '../../state/db.js'
import { RetryEngine } from '../../ops/retry.js'
import { requestExternalPollCycle } from '../../poller/control.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface RetryCommandOpts extends GlobalOpts {
  immediate?: boolean
  resetPlan?: boolean
  fresh?: boolean
  strategy?: UpdateStrategy
}

export async function retryCommand(
  repo: string,
  issueNumber: string,
  globalOpts?: RetryCommandOpts,
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

  const db = initDatabase(config.storage.dbPath)

  try {
    const engine = new RetryEngine(db, config)
    await engine.retry(repo, num, {
      immediate: globalOpts?.immediate ?? false,
      resetPlan: true,
      resetBranch: true,
      dryRun: globalOpts?.dryRun ?? false,
      strategyOverride: strategy,
      actor: 'cli',
    })

    console.log(`Fresh retry queued for ${repo}#${num}`)
    if (globalOpts?.fresh || globalOpts?.resetPlan) {
      console.log('Note: retry is always fresh now; --fresh and --reset-plan are accepted for compatibility only.')
    }
    if (globalOpts?.immediate) console.log('Immediate processing started')
    if (globalOpts?.dryRun) {
      console.log('(dry run — no changes applied)')
    } else if (!globalOpts?.immediate) {
      requestExternalPollCycle(config.storage.dbPath)
      console.log('Requested an immediate poll cycle for any running daemon using this database.')
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
