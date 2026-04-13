import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { FileLoopEngine } from '../../fileloop/engine.js'
import { requestExternalPollCycle } from '../../poller/control.js'
import { parseUtcTimestampMs } from '../../utils/time.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface FileLoopCommandOpts extends GlobalOpts {
  repo?: string
  maxMinutes?: string
  wait?: boolean
}

export async function fileLoopCommand(
  action: string,
  globalOpts?: FileLoopCommandOpts,
): Promise<void> {
  let baseConfig
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    baseConfig = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`)
    } else {
      console.error((err as Error).message)
    }
    process.exitCode = 1
    return
  }

  const db = initDatabase(baseConfig.storage.dbPath)
  try {
    const config = resolveConfigWithRuntimeSettings(baseConfig, db)
    const repoConfig = resolveRepoConfig(config, globalOpts?.repo)
    const engine = new FileLoopEngine(db, config)

    switch (action) {
      case 'start': {
        if (globalOpts?.dryRun) {
          console.log(`[dry-run] would start file-loop session for ${repoConfig.repo}`)
          return
        }
        const maxMinutes = globalOpts?.maxMinutes ? Number.parseInt(globalOpts.maxMinutes, 10) : undefined
        if (globalOpts?.maxMinutes && Number.isNaN(maxMinutes)) {
          throw new Error(`Invalid --max-minutes value: ${globalOpts.maxMinutes}`)
        }
        const session = engine.startSession(repoConfig, { maxMinutes })
        requestExternalPollCycle(config.storage.dbPath)
        console.log(`Started file-loop session ${session.id} for ${session.repo}`)
        console.log(`Branch: ${session.branch}`)
        console.log(`Ends: ${session.endsAt}`)
        return
      }
      case 'stop': {
        if (globalOpts?.dryRun) {
          console.log(`[dry-run] would stop file-loop session for ${repoConfig.repo}`)
          return
        }
        const session = engine.stopSession(repoConfig.repo)
        requestExternalPollCycle(config.storage.dbPath)
        console.log(`Requested stop for file-loop session ${session.id} on ${session.repo}`)
        if (globalOpts?.wait) {
          await waitForCompletion(engine, repoConfig.repo)
          console.log('File-loop session finalized')
        }
        return
      }
      case 'status': {
        const sessions = globalOpts?.repo
          ? engine.listSessions(repoConfig.repo, 5)
          : engine.listSessions(undefined, 20)
        if (sessions.length === 0) {
          console.log('No file-loop sessions found')
          return
        }
        for (const session of sessions) {
          const remainingMs = parseUtcTimestampMs(session.endsAt) - Date.now()
          const remaining = remainingMs > 0 ? `${Math.ceil(remainingMs / 60_000)}m remaining` : 'expired'
          console.log(
            `${session.repo}  id=${session.id}  status=${session.status}  iterations=${session.iterations}  touched=${session.filesTouched}  cost=$${session.totalCostUsd.toFixed(6)}  ${remaining}`,
          )
        }
        return
      }
      default:
        throw new Error(`Unknown file-loop action: ${action}. Expected start, stop, or status.`)
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

function resolveRepoConfig(
  config: ReturnType<typeof resolveConfigWithRuntimeSettings>,
  repo: string | undefined,
) {
  if (repo) {
    const match = config.repos.find((candidate) => candidate.repo === repo)
    if (!match) throw new Error(`Repository not found in config: ${repo}`)
    return match
  }

  if (config.repos.length === 1) {
    return config.repos[0]!
  }

  throw new Error('Multiple repositories are configured. Pass --repo <owner/name>.')
}

async function waitForCompletion(engine: FileLoopEngine, repo: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const active = engine.getActiveSession(repo)
    if (!active) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for file-loop session on ${repo} to finalize`)
}
