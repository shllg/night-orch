import { execa } from 'execa'
import type { ForgeAdapter } from '../forge/types.js'
import { logger } from '../utils/logger.js'

/**
 * Fast-forward the base branch to the staging branch tip, then close
 * the merged PRs and delete the staging branch.
 */
export async function finalizeMerge(
  forge: ForgeAdapter,
  repo: string,
  baseBranch: string,
  stagingSha: string,
  mergedPrNumbers: number[],
  stagingBranch: string,
  repoLocalPath: string,
): Promise<void> {
  // Fast-forward base branch to staging tip via API if available
  if (forge.updateRef) {
    await forge.updateRef(repo, `refs/heads/${baseBranch}`, stagingSha)
    logger.info({ repo, baseBranch, stagingSha }, 'Fast-forwarded base branch via API')
  } else {
    // Fallback: local push
    await execa('git', ['checkout', baseBranch], { cwd: repoLocalPath })
    await execa('git', ['merge', '--ff-only', stagingSha], { cwd: repoLocalPath })
    await execa('git', ['push', 'origin', baseBranch], { cwd: repoLocalPath })
    logger.info({ repo, baseBranch, stagingSha }, 'Fast-forwarded base branch via local push')
  }

  // Close merged PRs
  for (const prNumber of mergedPrNumbers) {
    try {
      await forge.closePR(repo, prNumber)
      logger.info({ repo, prNumber }, 'Closed merged PR')
    } catch (err) {
      logger.warn({ repo, prNumber, err }, 'Failed to close merged PR')
    }
  }

  // Clean up staging branch
  try {
    await execa('git', ['push', 'origin', '--delete', stagingBranch], { cwd: repoLocalPath })
  } catch {
    logger.debug({ repo, stagingBranch }, 'Could not delete staging branch')
  }
}
