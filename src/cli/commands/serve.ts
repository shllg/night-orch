import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
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
}

export async function serveCommand(
  commandOpts: ServeCommandOpts,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const projectRoot = process.cwd()

  // Check for docker-compose.yaml (same check as run command)
  const composeFile = resolve(projectRoot, 'docker-compose.yaml')
  if (!existsSync(composeFile)) {
    process.stderr.write(
      'docker-compose.yaml not found.\n' +
      'Copy docker-compose.example.yaml to docker-compose.yaml and adjust for your environment.\n',
    )
    process.exitCode = 1
    return
  }

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
