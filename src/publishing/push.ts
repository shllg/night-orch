import { execa } from 'execa'
import { logger } from '../utils/logger.js'

/**
 * Push a branch to origin using --force-with-lease to prevent overwriting
 * commits pushed by others (e.g., reviewer-pushed fixes).
 * On rejection (branch diverged), attempts a single rebase then retries.
 */
export async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  logger.info({ branchName }, 'Pushing branch to remote')
  try {
    await execa('git', ['push', '--force-with-lease', '-u', 'origin', branchName], {
      cwd: worktreePath,
      timeout: 60_000,
    })
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)

    // Detect rejected push (branch diverged or lease failed)
    if (stderr.includes('rejected') || stderr.includes('non-fast-forward') || stderr.includes('stale info')) {
      logger.warn({ branchName }, 'Push rejected — attempting rebase')
      try {
        await execa('git', ['pull', '--rebase', 'origin', branchName], {
          cwd: worktreePath,
          timeout: 60_000,
        })
        await execa('git', ['push', '--force-with-lease', '-u', 'origin', branchName], {
          cwd: worktreePath,
          timeout: 60_000,
        })
        return
      } catch (rebaseErr: unknown) {
        const rebaseStderr = (rebaseErr as { stderr?: string }).stderr ?? String(rebaseErr)
        throw new Error(`Push failed for ${branchName} after rebase attempt: ${rebaseStderr}`)
      }
    }

    throw new Error(`Push failed for ${branchName}: ${stderr}`)
  }
}
