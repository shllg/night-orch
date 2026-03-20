import { execa } from 'execa'
import { logger } from '../utils/logger.js'

export interface DedicatedStackParams {
  worktreePath: string
  composeFile: string
  services: string[]
  projectName: string
  healthcheck?: string
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
  await execa('docker', args, { cwd: worktreePath, timeout: 120_000 })

  // Run healthcheck if configured
  if (healthcheck) {
    logger.debug({ healthcheck }, 'Running dedicated stack healthcheck')
    // Retry healthcheck a few times with backoff
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const parts = healthcheck.split(/\s+/)
        await execa(parts[0]!, parts.slice(1), { timeout: 5_000 })
        logger.info({ healthcheck }, 'Dedicated stack healthcheck passed')
        return
      } catch (err) {
        lastError = err as Error
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    throw new Error(`Dedicated stack healthcheck failed after retries: ${healthcheck}\n${lastError?.message}`)
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
      { cwd: worktreePath, timeout: 60_000 },
    )
  } catch (err) {
    logger.warn({ projectName, err }, 'Failed to stop dedicated stack (may already be stopped)')
  }
}
