import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { pollOnce } from '../../runner/poller.js'
import { createOrchestrationCache } from '../../runner/orchestration-cache.js'
import { SyncEngine } from '../../ops/sync.js'
import { AutoCleanupScheduler } from '../../ops/auto-cleanup.js'
import { ShutdownHandler } from '../../poller/shutdown.js'
import { PollCycleController, resolveExternalPollTriggerPath } from '../../poller/control.js'
import { ReloadController, resolveExternalReloadTriggerPath } from '../../poller/reload-control.js'
import { tryReloadConfig } from '../../config/reload.js'
import { createMetricsService, type MetricsService } from '../../metrics/service.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { startMCPHttpServer } from '../../mcp/http.js'
import { warnIncompleteRebaseFanouts } from '../../ops/fanout-rebase.js'
import type { Server } from 'node:http'
import type { ForgeAdapter } from '../../forge/types.js'
import { logger } from '../../utils/logger.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'
import { createNdjsonWriter, ndjsonError } from '../ndjson.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
  ndjson?: boolean
}

export async function runCommand(globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false
  const emitNdjson = createNdjsonWriter(globalOpts?.ndjson ?? false, 'run')

  let baseConfig
  let configPath: string
  try {
    configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    baseConfig = loadConfig(configPath)
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

  const db = initDatabase(baseConfig.storage.dbPath)
  let runtimeConfig = resolveConfigWithRuntimeSettings(baseConfig, db)

  // Start metrics service
  let metrics: MetricsService | undefined
  if (runtimeConfig.metrics) {
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

  // Crash recovery: release all leases (no process is running at startup)
  // then sync stale runs back to queued state with correct labels
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

  // Start embedded MCP HTTP/SSE server
  let mcpServer: Server | undefined
  const pollerControl = new PollCycleController(resolveExternalPollTriggerPath(baseConfig.storage.dbPath))
  const reloadController = new ReloadController(resolveExternalReloadTriggerPath(baseConfig.storage.dbPath))
  const unregisterReload = reloadController.register()
  // Mutable so that hot-reload can swap in the new config + rebuild adapters
  // without re-creating the MCP server. The MCP handlers re-read deps.config
  // on every call, so updating this object in place propagates to them.
  let mcpDeps: {
    db: typeof db
    config: typeof baseConfig
    configPath: string
    forgeAdapters: Map<string, ForgeAdapter>
    poller: typeof pollerControl
    metrics: MetricsService | null
  } | undefined
  if (runtimeConfig.mcp.enabled) {
    const forgeAdapters = new Map<string, ForgeAdapter>()
    for (const repo of runtimeConfig.repos) {
      try {
        forgeAdapters.set(repo.repo, createForgeAdapter(repo, runtimeConfig))
      } catch (err) {
        logger.warn({ repo: repo.repo, err }, 'Failed to create forge adapter for MCP')
      }
    }
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

  // Auto-cleanup scheduler: runs worktree + DB retention on a time-gated
  // interval within the poll loop. Without this, the daemon accumulates
  // stale worktrees and DB history until disk fills on long-running hosts.
  const autoCleanup = new AutoCleanupScheduler(runtimeConfig, db)

  logger.info(
    {
      intervalMs: runtimeConfig.github.pollIntervalSeconds * 1000,
      dryRun,
      repos: runtimeConfig.repos.length,
    },
    'Starting poller',
  )

  // Graceful shutdown
  const shutdown = new ShutdownHandler(db)
  shutdown.register(async () => {
    unregisterReload()
    if (mcpServer) {
      const serverToClose = mcpServer
      await new Promise<void>((resolve) => serverToClose.close(() => resolve()))
    }
    if (metrics) {
      try { await metrics.stop() } catch { /* ignore */ }
    }
  })

  // Poll loop
  const orchestrationCache = createOrchestrationCache()
  while (!shutdown.isShuttingDown) {
    if (reloadController.consume()) {
      const outcome = tryReloadConfig(configPath, baseConfig)
      if (outcome.reloaded) {
        baseConfig = outcome.config
        const reloaded = resolveConfigWithRuntimeSettings(baseConfig, db)
        autoCleanup.setConfig(reloaded)
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
        emitNdjson('config_reloaded', { configPath })
        logger.info({ configPath }, 'Config hot-reloaded — applied on next poll cycle')
      } else {
        const errMsg = outcome.error instanceof ConfigError
          ? [outcome.error.message, ...(outcome.error.details ?? [])].join('; ')
          : outcome.error?.message
        emitNdjson('config_reload_failed', { configPath, error: ndjsonError(outcome.error) })
        logger.error({ configPath, err: errMsg }, 'Config reload failed — keeping previous config live')
      }
    }
    emitNdjson('poll_cycle_start', { dryRun })
    try {
      runtimeConfig = resolveConfigWithRuntimeSettings(baseConfig, db)
      const runPromise = pollOnce(runtimeConfig, db, dryRun, metrics, undefined, orchestrationCache)
      shutdown.trackRun(runPromise.then(() => {}))
      const pollResult = await runPromise
      emitNdjson('poll_cycle_result', {
        dryRun,
        processed: pollResult.processed,
        errors: pollResult.errors,
        immediateFollowupRepos: pollResult.immediateFollowupRepos,
      })
      if (pollResult.immediateFollowupRepos.length > 0) {
        const trigger = pollerControl.triggerPollCycle()
        emitNdjson('poll_cycle_followup_scheduled', {
          repos: pollResult.immediateFollowupRepos,
          triggerState: trigger.state,
        })
        logger.info(
          { repos: pollResult.immediateFollowupRepos, triggerState: trigger.state },
          'Run reached terminal state — scheduling immediate follow-up poll cycle',
        )
      }
    } catch (err) {
      emitNdjson('poll_cycle_error', { dryRun, error: ndjsonError(err) })
      logger.error({ err }, 'Poll cycle failed')
    }

    // Run time-gated auto-cleanup (worktrees, DB retention). Runs inline
    // after each poll cycle; the scheduler skips if the configured interval
    // hasn't elapsed yet, so this is a cheap no-op on most cycles.
    try {
      await autoCleanup.maybeRun()
    } catch (err) {
      logger.warn({ err }, 'Auto-cleanup failed (non-fatal)')
    }

    if (shutdown.isShuttingDown) break

    runtimeConfig = resolveConfigWithRuntimeSettings(baseConfig, db)
    const waitResult = await pollerControl.waitForNextCycle(runtimeConfig.github.pollIntervalSeconds * 1000)
    if (waitResult === 'manual') {
      logger.info('Manual poll trigger received — running next cycle immediately')
    }
  }
}
