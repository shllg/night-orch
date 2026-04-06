import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'
import { buildBootstrapEnv } from '../workers/env.js'

/**
 * Validate that the shared dev environment is running by executing a healthcheck command.
 */
export async function validateSharedEnvironment(healthcheck?: CommandSpec, requireRunning = true): Promise<void> {
  if (!healthcheck) {
    logger.debug('No shared healthcheck configured, skipping')
    return
  }

  const commandLabel = Array.isArray(healthcheck) ? healthcheck.join(' ') : healthcheck
  const { binary, args } = parseCommandSpec(healthcheck)

  try {
    await execa(binary, args, {
      timeout: 10_000,
      extendEnv: false,
      env: buildBootstrapEnv(),
    })
    logger.info({ healthcheck: commandLabel }, 'Shared environment healthcheck passed')
  } catch {
    if (requireRunning) {
      throw new Error(
        `Shared environment healthcheck failed: ${commandLabel}\nMake sure the dev stack is running.`,
      )
    }
    logger.warn({ healthcheck: commandLabel }, 'Shared environment healthcheck failed (not required)')
  }
}
