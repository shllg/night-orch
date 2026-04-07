import { runGit } from '../git/process.js'
import { mergeFromBranch } from '../git/repo.js'
import { logger } from '../utils/logger.js'
import type { UpdateStrategy } from '../git/worktree.js'

export interface RebaseTarget {
  repo: string
  issueNumber: number
  prNumber: number
  branchName: string
  baseBranch: string
  worktreePath: string
}

export type RebaseResult = 'up_to_date' | 'rebased' | 'conflict' | 'error'

/**
 * Update a branch to incorporate latest base branch changes and push.
 * Supports both merge and rebase strategies. Uses --force-with-lease for
 * push to protect against overwriting others' work.
 *
 * @param strategy - 'merge' creates a merge commit (reliable), 'rebase' replays commits (linear history)
 * @returns 'up_to_date' if no update needed, 'rebased' on success,
 *          'conflict' if update had conflicts (aborted), 'error' on other failures.
 */
export async function autoRebase(
  target: RebaseTarget,
  repoLocalPath: string,
  strategy: UpdateStrategy = 'merge',
): Promise<RebaseResult> {
  const { branchName, baseBranch, worktreePath } = target
  const log = logger.child({ repo: target.repo, issue: target.issueNumber, branch: branchName })

  try {
    // Fetch latest remote state
    await runGit(['fetch', 'origin'], {
      cwd: repoLocalPath,
      timeout: 60_000,
    })

    // Check if base branch is already an ancestor of HEAD (i.e., no update needed)
    try {
      await runGit(['merge-base', '--is-ancestor', `origin/${baseBranch}`, 'HEAD'], {
        cwd: worktreePath,
        timeout: 30_000,
      })
      return 'up_to_date'
    } catch {
      // Non-zero exit = base is NOT an ancestor → update needed
    }

    const remoteRef = `origin/${baseBranch}`
    log.info({ baseBranch, strategy }, 'Base branch has moved ahead — updating')

    if (strategy === 'merge') {
      const result = await mergeFromBranch(worktreePath, remoteRef)
      if (!result.success) {
        if (result.conflict) {
          log.warn({ baseBranch }, 'Merge conflict with base branch — aborting')
          return 'conflict'
        }
        return 'error'
      }
    } else {
      // Rebase strategy
      try {
        await runGit(['rebase', remoteRef], {
          cwd: worktreePath,
          timeout: 120_000,
        })
      } catch (rebaseErr) {
        const stderr = (rebaseErr as { stderr?: string }).stderr ?? ''
        if (stderr.includes('CONFLICT') || stderr.includes('could not apply')) {
          log.warn({ baseBranch }, 'Rebase conflict — aborting')
          try {
            await runGit(['rebase', '--abort'], { cwd: worktreePath, timeout: 30_000 })
          } catch {
            log.error('Failed to abort rebase')
          }
          return 'conflict'
        }
        throw rebaseErr
      }
    }

    // Push with --force-with-lease
    await runGit(['push', '--force-with-lease', 'origin', branchName], {
      cwd: worktreePath,
      timeout: 60_000,
    })

    log.info({ baseBranch, strategy }, 'Updated and pushed successfully')
    return 'rebased'
  } catch (err) {
    log.error({ err }, 'Auto-update failed')
    return 'error'
  }
}
