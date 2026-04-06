import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'
import { buildBootstrapEnv } from '../workers/env.js'

export interface DedicatedStackParams {
  worktreePath: string
  composeFile: string
  services: string[]
  projectName: string
  healthcheck?: CommandSpec
}

/**
 * Start a dedicated Docker Compose stack for an issue worktree.
 */
export async function startDedicatedStack(params: DedicatedStackParams): Promise<void> {
  const { worktreePath, composeFile, services, projectName, healthcheck } = params

  const args = [
    'compose',
    '-p', projectName,
    '-f', composeFile,
    'up', '-d',
    ...services,
  ]

  logger.info({ projectName, services }, 'Starting dedicated Docker Compose stack')
  // Compose files are user-authored and run inside an attacker-influenced
  // worktree. Strip the daemon env so tokens don't leak into container env.
  await execa('docker', args, {
    cwd: worktreePath,
    timeout: 120_000,
    extendEnv: false,
    env: buildBootstrapEnv(),
  })

  // Run healthcheck if configured
  if (healthcheck) {
    const commandLabel = Array.isArray(healthcheck) ? healthcheck.join(' ') : healthcheck
    logger.debug({ healthcheck: commandLabel }, 'Running dedicated stack healthcheck')
    // Retry healthcheck a few times with backoff
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const parsed = parseCommandSpec(healthcheck)
        await execa(parsed.binary, parsed.args, {
          timeout: 5_000,
          extendEnv: false,
          env: buildBootstrapEnv(),
        })
        logger.info({ healthcheck: commandLabel }, 'Dedicated stack healthcheck passed')
        return
      } catch (err) {
        lastError = err as Error
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    throw new Error(`Dedicated stack healthcheck failed after retries: ${commandLabel}\n${lastError?.message}`)
  }
}

/**
 * Stop and remove a dedicated Docker Compose stack.
 */
export async function stopDedicatedStack(
  worktreePath: string,
  composeFile: string,
  projectName: string,
): Promise<void> {
  logger.info({ projectName }, 'Stopping dedicated Docker Compose stack')
  try {
    await execa(
      'docker',
      ['compose', '-p', projectName, '-f', composeFile, 'down', '-v'],
      {
        cwd: worktreePath,
        timeout: 60_000,
        extendEnv: false,
        env: buildBootstrapEnv(),
      },
    )
  } catch (err) {
    logger.warn({ projectName, err }, 'Failed to stop dedicated stack (may already be stopped)')
  }
}
