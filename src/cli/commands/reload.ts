import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { requestExternalReload } from '../../poller/reload-control.js'
import { tryReloadConfig } from '../../config/reload.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
}

/**
 * `night-orch reload` — ask the running poller to reload its config from disk
 * before the next poll cycle. Writes a trigger file the daemon drains in
 * its poll loop. Validates the config locally first so a bad edit is
 * rejected before the daemon ever sees it.
 */
export async function reloadCommand(globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let configPath: string
  let config
  try {
    configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
      if (err.details) err.details.forEach((d) => process.stderr.write(`${d}\n`))
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exitCode = 1
    return
  }

  // Pre-flight: re-parse with the same code path the daemon will use.
  // The daemon also re-validates and keeps the old config on failure, but
  // catching it here gives the operator immediate feedback instead of a log line.
  const preflight = tryReloadConfig(configPath, config)
  if (!preflight.reloaded) {
    process.stderr.write(`Config validation failed: ${preflight.error?.message ?? 'unknown error'}\n`)
    process.exitCode = 1
    return
  }

  if (dryRun) {
    process.stdout.write(
      `Would request config reload for daemon using ${configPath}\n` +
      `Config validated successfully (${config.repos.length} repo(s) configured).\n`,
    )
    return
  }

  const result = requestExternalReload(config.storage.dbPath)
  process.stdout.write(
    `Reload trigger written to ${result.triggerPath}\n` +
    'The running poller will pick this up before its next poll cycle.\n',
  )
}
