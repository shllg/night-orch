import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import type { UpdateStatusTracker } from './status.js'

export interface UpdateResult {
  success: boolean
  previousCommit: string
  newCommit: string
  error?: string
}

export async function runUpdate(
  projectRoot: string,
  status: UpdateStatusTracker,
): Promise<UpdateResult> {
  const git = (args: string[]) => execa('git', args, { cwd: projectRoot })
  const previousCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()

  // Pull
  status.transition('pulling', { startedAt: new Date().toISOString(), previousCommit })
  try {
    await git(['pull', '--ff-only'])
  } catch (err) {
    const message = `git pull failed: ${(err as Error).message}`
    logger.error(message)
    status.transition('failed', { error: message, completedAt: new Date().toISOString() })
    return { success: false, previousCommit, newCommit: previousCommit, error: message }
  }

  const newCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()

  // Build
  status.transition('building')
  try {
    await execa('pnpm', ['install', '--frozen-lockfile'], { cwd: projectRoot })
    await execa('pnpm', ['build'], { cwd: projectRoot })
    await execa('pnpm', ['install-global'], { cwd: projectRoot })
  } catch (err) {
    const message = `Build failed: ${(err as Error).message}`
    logger.error(message)

    // Rollback
    status.transition('rolling-back', { error: message })
    try {
      await git(['checkout', previousCommit])
      await execa('pnpm', ['install', '--frozen-lockfile'], { cwd: projectRoot })
      await execa('pnpm', ['build'], { cwd: projectRoot })
      await execa('pnpm', ['install-global'], { cwd: projectRoot })
      logger.info({ previousCommit }, 'Rolled back to previous commit')
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'Rollback also failed — manual intervention required')
    }

    status.transition('failed', { error: message, completedAt: new Date().toISOString() })
    return { success: false, previousCommit, newCommit: previousCommit, error: message }
  }

  return { success: true, previousCommit, newCommit }
}
