import { execa } from 'execa'
import { logger } from '../utils/logger.js'

/**
 * Validate that the shared dev environment is running by executing a healthcheck command.
 */
export async function validateSharedEnvironment(healthcheck?: string, requireRunning = true): Promise<void> {
  if (!healthcheck) {
    logger.debug('No shared healthcheck configured, skipping')
    return
  }

  const parts = healthcheck.split(/\s+/)
  const binary = parts[0]!
  const args = parts.slice(1)

  try {
    await execa(binary, args, { timeout: 10_000 })
    logger.info({ healthcheck }, 'Shared environment healthcheck passed')
  } catch (err) {
    if (requireRunning) {
      throw new Error(
        `Shared environment healthcheck failed: ${healthcheck}\nMake sure the dev stack is running.`,
      )
    }
    logger.warn({ healthcheck }, 'Shared environment healthcheck failed (not required)')
  }
}
