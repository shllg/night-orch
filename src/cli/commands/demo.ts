import type { Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigWithRaw, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import type { ForgeAdapter } from '../../forge/types.js'
import { startWebServer } from '../../web/server.js'
import { logger } from '../../utils/logger.js'
import { buildDemoConfigYaml } from '../../web/demo/config.js'
import { seedDemoData } from '../../web/demo/seed.js'

interface DemoCommandOpts {
  host?: string
  port?: string | number
  allowedHost?: string[] | string
  keepTempDir?: boolean
}

/**
 * `night-orch demo` — run the web UI against synthetic fixture data.
 *
 * Spawns a temp working directory, writes a minimal demo config, boots
 * an in-process SQLite DB seeded with varied runs / issues / events,
 * and serves the REST + WebSocket API with auth disabled and
 * operations disabled. No forge adapters are created, no poller loop
 * runs, no workers are spawned — the UI gets rich data to iterate
 * against without touching any real state.
 */
export async function demoCommand(commandOpts: DemoCommandOpts): Promise<void> {
  const host = (commandOpts.host ?? '127.0.0.1').trim() || '127.0.0.1'
  const port = normalizePort(commandOpts.port, 3200)
  const allowedHosts = normalizeAllowedHosts(commandOpts.allowedHost)
  const keepTempDir = commandOpts.keepTempDir ?? false

  const tempRoot = mkdtempSync(join(tmpdir(), 'night-orch-demo-'))
  const dbPath = join(tempRoot, 'state.db')
  const worktreeRoot = join(tempRoot, 'worktrees')
  const logsRoot = join(tempRoot, 'logs')
  const configPath = join(tempRoot, 'config.yaml')
  mkdirSync(worktreeRoot, { recursive: true })
  mkdirSync(logsRoot, { recursive: true })

  writeFileSync(configPath, buildDemoConfigYaml({ dbPath, worktreeRoot, logsRoot }))

  let loaded
  try {
    loaded = loadConfigWithRaw(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Demo config validation failed: ${err.message}\n`)
      if (err.details) err.details.forEach((d) => process.stderr.write(`${d}\n`))
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    rmSync(tempRoot, { recursive: true, force: true })
    process.exitCode = 1
    return
  }
  const { config, raw } = loaded
  const db = initDatabase(dbPath)

  const seedResult = seedDemoData(db)
  logger.info({ tempRoot, ...seedResult }, 'Demo data seeded')

  const forgeAdapters = new Map<string, ForgeAdapter>()

  let webServer: Server | undefined
  try {
    webServer = await startWebServer(
      { db, config, forgeAdapters, poller: null, metrics: null },
      {
        host,
        allowedHosts,
        port,
        snapshotIntervalMs: 5_000,
        operationsEnabled: false,
        requireAuth: false,
        rawConfig: raw,
      },
    )
  } catch (err) {
    logger.error({ err }, 'Failed to start demo web server')
    db.close()
    if (!keepTempDir) rmSync(tempRoot, { recursive: true, force: true })
    process.exitCode = 1
    return
  }

  logger.info(
    { host, port, tempRoot },
    `Demo server ready at http://${host}:${port} — auth & operations disabled, no forge/poller`,
  )

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down demo server')
    if (webServer) {
      const serverToClose = webServer
      await new Promise<void>((resolve) => serverToClose.close(() => resolve()))
    }
    db.close()
    if (!keepTempDir) {
      try {
        rmSync(tempRoot, { recursive: true, force: true })
      } catch (err) {
        logger.warn({ err, tempRoot }, 'Failed to clean up demo temp dir')
      }
    }
  }

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  await new Promise<void>(() => {})
}

function normalizePort(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
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
