import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { startMCPStdio } from '../../mcp/server.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { createMetricsService } from '../../metrics/service.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

export async function mcpCommand(globalOpts?: GlobalOpts): Promise<void> {
  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config)
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

  const forgeAdapters = new Map<string, import('../../forge/types.js').ForgeAdapter>()
  for (const repo of config.repos) {
    try {
      forgeAdapters.set(repo.repo, createForgeAdapter(repo, config))
    } catch (err) {
      logger.warn({ repo: repo.repo, err }, 'Failed to create forge adapter — list-issues will be unavailable for this repo')
    }
  }

  // All logging goes to stderr when in MCP stdio mode
  logger.info('Starting MCP server')

  await startMCPStdio({ db, config, forgeAdapters, poller: null, metrics })
}
