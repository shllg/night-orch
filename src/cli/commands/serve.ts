import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Supervisor } from '../../supervisor/index.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface ServeCommandOpts {
  webHost?: string
  webPort?: string
  allowedHost?: string[]
  skipAuth?: boolean
}

export async function serveCommand(
  commandOpts: ServeCommandOpts,
  globalOpts?: GlobalOpts,
): Promise<void> {
  // Resolve from the compiled module location (dist/cli/commands/serve.js)
  // up to the package root. Works for both git checkout and npm global install.
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

  // docker-compose.yaml is optional — only required when the monitoring
  // stack (Prometheus + Grafana) is explicitly requested via mise run dev.
  // The supervisor spawns run + web children which do not themselves
  // require compose.

  // Build global args to pass to children
  const globalArgs: string[] = []
  if (globalOpts?.config) {
    globalArgs.push('--config', globalOpts.config)
  }
  if (globalOpts?.trustWorkspace) {
    globalArgs.push('--trust-workspace')
  }
  if (globalOpts?.dryRun) {
    globalArgs.push('--dry-run')
  }
  if (globalOpts?.logLevel) {
    globalArgs.push('--log-level', globalOpts.logLevel)
  }

  // Build web-specific args
  const webArgs: string[] = []
  if (commandOpts.webHost) {
    webArgs.push('--host', commandOpts.webHost)
  }
  if (commandOpts.webPort) {
    webArgs.push('--port', commandOpts.webPort)
  }
  if (commandOpts.allowedHost) {
    for (const host of commandOpts.allowedHost) {
      webArgs.push('--allowed-host', host)
    }
  }
  if (commandOpts.skipAuth) {
    webArgs.push('--skip-auth')
  }

  // Data directory for status files
  const dataDir = resolve(homedir(), '.config', 'night-orch')
  mkdirSync(dataDir, { recursive: true })

  const supervisor = new Supervisor({
    projectRoot,
    globalArgs,
    webArgs,
    dataDir,
  })

  logger.info({ projectRoot, dataDir }, 'Starting night-orch supervisor')
  await supervisor.start()
}
