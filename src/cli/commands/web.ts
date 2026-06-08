import type { Server } from 'node:http'
import { loadConfigWithRaw, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
import { createOrchestrationCache } from '../../runner/orchestration-cache.js'
import { SyncEngine } from '../../ops/sync.js'
import { ShutdownHandler } from '../../poller/shutdown.js'
import { PollCycleController, resolveExternalPollTriggerPath } from '../../poller/control.js'
import { ReloadController, resolveExternalReloadTriggerPath } from '../../poller/reload-control.js'
import { tryReloadConfig } from '../../config/reload.js'
import { createMetricsService, type MetricsService } from '../../metrics/service.js'
import { createForgeAdapter } from '../../forge/factory.js'
import type { ForgeAdapter } from '../../forge/types.js'
import { startMCPHttpServer } from '../../mcp/http.js'
import { warnIncompleteRebaseFanouts } from '../../ops/fanout-rebase.js'
import { startWebServer } from '../../web/server.js'
import { logger } from '../../utils/logger.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface WebCommandOpts {
  host?: string
  allowedHost?: string[] | string
  port?: string | number
  snapshotIntervalMs?: string | number
  standalone?: boolean
  /** Phase 2a: bypass the mutation auth guard entirely. Only safe
   * when the daemon is behind a trusted reverse proxy (Caddy with
   * basic-auth, Tailscale serve, etc.) that handles its own auth. */
  skipAuth?: boolean
}

export async function webCommand(
  commandOpts: WebCommandOpts,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let baseConfig
  let rawConfig: unknown
  let configPath: string
  try {
    configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    const loadedConfig = loadConfigWithRaw(configPath)
    baseConfig = loadedConfig.config
    rawConfig = loadedConfig.raw
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

  const host = normalizeHost(commandOpts.host)
  const allowedHosts = normalizeAllowedHosts(commandOpts.allowedHost)
  const port = normalizePort(commandOpts.port, 3200)
  const snapshotIntervalMs = normalizePort(commandOpts.snapshotIntervalMs, 3000)
  const standalone = commandOpts.standalone ?? false

  const db = initDatabase(baseConfig.storage.dbPath)
  let runtimeConfig = resolveConfigWithRuntimeSettings(baseConfig, db)

  // Start metrics service (standalone mode only)
  let metrics: MetricsService | undefined
  if (standalone && runtimeConfig.metrics) {
    metrics = createMetricsService(runtimeConfig.metrics)
    try {
      await metrics.start()
      if (metrics.endpoint) {
        logger.info({ host: metrics.endpoint.host, port: metrics.endpoint.port }, 'Metrics endpoint ready')
      }
    } catch (err) {
      logger.error({ err }, 'Failed to start metrics server — continuing without metrics')
      metrics = undefined
    }
  }

  if (standalone) {
    // Crash recovery: release all leases and reconcile stale runs.
    try {
      const { LeaseManager } = await import('../../state/leases.js')
      const leaseManager = new LeaseManager(db)
      const releasedLeases = leaseManager.releaseAll()
      if (releasedLeases > 0) {
        logger.info({ releasedLeases }, 'Released orphaned leases from previous run')
      }

      const syncEngine = new SyncEngine(db, runtimeConfig)
      const syncResult = await syncEngine.reconcile(dryRun)
      if (syncResult.reconciledRuns.length > 0 || syncResult.expiredLeases > 0) {
        logger.info(
          { reconciled: syncResult.reconciledRuns.length, expiredLeases: syncResult.expiredLeases },
          'Startup sync complete',
        )
      }
    } catch (err) {
      logger.warn({ err }, 'Startup sync failed — continuing')
    }
    warnIncompleteRebaseFanouts(db)
  }

  const forgeAdapters = new Map<string, ForgeAdapter>()
  for (const repo of runtimeConfig.repos) {
    try {
      forgeAdapters.set(repo.repo, createForgeAdapter(repo, runtimeConfig))
    } catch (err) {
      logger.warn({ repo: repo.repo, err }, 'Failed to create forge adapter')
    }
  }

  // Start optional embedded MCP server (standalone mode only).
  const pollerControl = standalone
    ? new PollCycleController(resolveExternalPollTriggerPath(baseConfig.storage.dbPath))
    : null
  const reloadController = standalone
    ? new ReloadController(resolveExternalReloadTriggerPath(baseConfig.storage.dbPath))
    : null
  const unregisterReload = reloadController?.register() ?? (() => undefined)
  let mcpDeps: {
    db: typeof db
    config: typeof baseConfig
    configPath: string
    forgeAdapters: Map<string, ForgeAdapter>
    poller: typeof pollerControl
    metrics: MetricsService | null
  } | undefined
  let mcpServer: Server | undefined
  if (standalone && runtimeConfig.mcp.enabled) {
    mcpDeps = { db, config: baseConfig, configPath, forgeAdapters, poller: pollerControl, metrics: metrics ?? null }
    try {
      mcpServer = await startMCPHttpServer(
        mcpDeps,
        runtimeConfig.mcp.httpHost,
        runtimeConfig.mcp.httpPort,
      )
    } catch (err) {
      logger.warn({ err }, 'Failed to start MCP HTTP server — continuing without MCP')
    }
  }

  // Start web API + frontend server.
  let webServer: Server | undefined
  try {
    webServer = await startWebServer(
      { db, config: baseConfig, forgeAdapters, poller: pollerControl, metrics: metrics ?? null },
      {
        host,
        allowedHosts,
        port,
        snapshotIntervalMs,
        operationsEnabled: true,
        requireAuth: commandOpts.skipAuth !== true,
        rawConfig,
      },
    )
  } catch (err) {
    logger.error({ err, host, allowedHosts, port }, 'Failed to start web server')
    if (mcpServer) {
      await new Promise<void>((resolve) => mcpServer?.close(() => resolve()))
    }
    if (metrics) {
      try { await metrics.stop() } catch { /* ignore */ }
    }
    db.close()
    process.exitCode = 1
    return
  }

  // Graceful shutdown
  const shutdown = new ShutdownHandler(db)
  shutdown.register(async () => {
    unregisterReload()
    if (webServer) {
      const serverToClose = webServer
      await new Promise<void>((resolve) => serverToClose.close(() => resolve()))
    }

    if (mcpServer) {
      const serverToClose = mcpServer
      await new Promise<void>((resolve) => serverToClose.close(() => resolve()))
    }

    if (metrics) {
      try { await metrics.stop() } catch { /* ignore */ }
    }
  })

  if (!standalone) {
    logger.info({ host, port }, 'Starting web control surface (attach mode)')
    if (runtimeConfig.metrics.enabled) {
      logger.info('Metrics are served by the night-orch run process, not this web process')
    } else {
      logger.info('Metrics are disabled at runtime')
    }
    await new Promise<void>(() => {})
    return
  }

  logger.info(
    {
      intervalMs: runtimeConfig.github.pollIntervalSeconds * 1000,
      dryRun,
      repos: runtimeConfig.repos.length,
      host,
      port,
    },
    'Starting web poller',
  )

  // Poll loop
  const orchestrationCache = createOrchestrationCache()
  while (!shutdown.isShuttingDown) {
    if (reloadController?.consume()) {
      const outcome = tryReloadConfig(configPath, baseConfig)
      if (outcome.reloaded) {
        baseConfig = outcome.config
        const reloaded = resolveConfigWithRuntimeSettings(baseConfig, db)
        if (mcpDeps) {
          const newAdapters = new Map<string, ForgeAdapter>()
          for (const repo of reloaded.repos) {
            try {
              newAdapters.set(repo.repo, createForgeAdapter(repo, reloaded))
            } catch (err) {
              logger.warn({ repo: repo.repo, err }, 'Failed to rebuild forge adapter after reload')
            }
          }
          // Swap atomically so concurrent MCP handlers never observe an empty map.
          mcpDeps.config = baseConfig
          mcpDeps.forgeAdapters = newAdapters
        }
        logger.info({ configPath }, 'Config hot-reloaded — applied on next poll cycle')
      } else {
        const errMsg = outcome.error instanceof ConfigError
          ? [outcome.error.message, ...(outcome.error.details ?? [])].join('; ')
          : outcome.error?.message
        logger.error({ configPath, err: errMsg }, 'Config reload failed — keeping previous config live')
      }
    }
    try {
      runtimeConfig = resolveConfigWithRuntimeSettings(baseConfig, db)
      const runPromise = pollOnce(runtimeConfig, db, dryRun, metrics, undefined, orchestrationCache)
      shutdown.trackRun(runPromise.then(() => {}))
      const pollResult = await runPromise
      if (pollResult.immediateFollowupRepos.length > 0) {
        const trigger = pollerControl!.triggerPollCycle()
        logger.info(
          { repos: pollResult.immediateFollowupRepos, triggerState: trigger.state },
          'Run reached terminal state — scheduling immediate follow-up poll cycle',
        )
      }
    } catch (err) {
      logger.error({ err }, 'Poll cycle failed')
    }

    if (shutdown.isShuttingDown) break

    runtimeConfig = resolveConfigWithRuntimeSettings(baseConfig, db)
    const waitResult = await pollerControl!.waitForNextCycle(runtimeConfig.github.pollIntervalSeconds * 1000)
    if (waitResult === 'manual') {
      logger.info('Manual poll trigger received — running next cycle immediately')
    }
  }
}

function normalizeHost(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '127.0.0.1'
}

function normalizePort(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : NaN

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

function normalizeAllowedHosts(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  return []
}
