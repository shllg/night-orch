import React from 'react'
import { render } from 'ink'
import { App } from '../tui/app.js'
import { initDatabase } from '../../state/db.js'
import { resolveConfigPath, loadConfig, ConfigError } from '../../config/loader.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

export async function runWatch(globalOpts?: GlobalOpts): Promise<void> {
  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exit(1)
  }

  const db = initDatabase(config.storage.dbPath)
  const pollIntervalMs = config.github.pollIntervalSeconds * 1000
  const useAltScreen = Boolean(process.stdout.isTTY)

  if (useAltScreen) {
    process.stdout.write('\u001B[?1049h\u001B[H')
    process.stdout.write('\u001B[?25l')
  }

  try {
    const { waitUntilExit } = render(
      React.createElement(App, {
        db,
        config,
        pollIntervalMs,
        dryRun: globalOpts?.dryRun ?? false,
        enableBackgroundPoller: true,
      }),
      {
        exitOnCtrlC: false,
      },
    )

    await waitUntilExit()
  } finally {
    if (useAltScreen) {
      process.stdout.write('\u001B[?25h')
      process.stdout.write('\u001B[?1049l')
    }
    db.close()
  }
}
