import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { startMCPStdio } from '../../mcp/server.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { createMetricsService } from '../../metrics/service.js'
import { createLogger, logger } from '../../utils/logger.js'
import type { ForgeAdapter } from '../../forge/types.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

const mcpLogger = createLogger(process.env['LOG_LEVEL'] ?? 'info', {
  destination: 'stderr',
  pretty: false,
})

export async function mcpCommand(globalOpts?: GlobalOpts): Promise<void> {
  // In stdio mode stdout is reserved for JSON-RPC frames.
  logger.level = 'silent'

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      // Write to stderr — stdout is reserved for MCP stdio transport
      process.stderr.write(`Config error: ${err.message}\n`)
    } else {
      process.stderr.write(`Error: ${(err as Error).message}\n`)
    }
    process.exitCode = 1
    return
  }

  const db = initDatabase(config.storage.dbPath)
  const metrics = config.metrics.enabled ? createMetricsService(config.metrics) : null

  if (metrics) {
    await metrics.start()
  }

  const forgeAdapters = new Map<string, ForgeAdapter>()
  for (const repo of config.repos) {
    try {
      forgeAdapters.set(repo.repo, createForgeAdapter(repo, config))
    } catch (err) {
      mcpLogger.warn({ repo: repo.repo, err }, 'Failed to create forge adapter — list-issues will be unavailable for this repo')
    }
  }

  // All logging goes to stderr when in MCP stdio mode
  mcpLogger.info('Starting MCP server')

  await startMCPStdio({ db, config, forgeAdapters, poller: null, metrics })
}
