import { execa } from 'execa'
import { logger } from '../utils/logger.js'

/**
 * Push a branch to origin. Sets upstream tracking.
 */
export async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  logger.info({ branchName }, 'Pushing branch to remote')
  try {
    await execa('git', ['push', '-u', 'origin', branchName], {
      cwd: worktreePath,
      timeout: 60_000,
    })
  } catch (err: unknown) {
    const message = (err as { stderr?: string }).stderr ?? String(err)
    throw new Error(`Push failed for ${branchName}: ${message}`)
  }
}
