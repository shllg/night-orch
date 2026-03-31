import React from 'react'
import { render } from 'ink'
import { App } from '../tui/app.js'
import { initDatabase } from '../../state/db.js'
import { resolveConfigPath, loadConfig, ConfigError } from '../../config/loader.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
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

  const { waitUntilExit } = render(
    React.createElement(App, { db, pollIntervalMs: 2000 }),
  )

  await waitUntilExit()
  db.close()
}
