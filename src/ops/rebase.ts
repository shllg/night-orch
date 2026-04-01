import { runGit } from '../git/process.js'
import { logger } from '../utils/logger.js'

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
 * Check if a branch needs rebase and perform it automatically.
 * Uses --force-with-lease for push to protect against overwriting others' work.
 *
 * @returns 'up_to_date' if no rebase needed, 'rebased' on success,
 *          'conflict' if rebase had conflicts (aborted), 'error' on other failures.
 */
export async function autoRebase(
  target: RebaseTarget,
  repoLocalPath: string,
): Promise<RebaseResult> {
  const { branchName, baseBranch, worktreePath } = target
  const log = logger.child({ repo: target.repo, issue: target.issueNumber, branch: branchName })

  try {
    // Fetch latest remote state
    await runGit(['fetch', 'origin'], {
      cwd: repoLocalPath,
      timeout: 60_000,
    })

    // Check if base branch is already an ancestor of HEAD (i.e., no rebase needed)
    try {
      await runGit(['merge-base', '--is-ancestor', `origin/${baseBranch}`, 'HEAD'], {
        cwd: worktreePath,
        timeout: 30_000,
      })
      // Exit code 0 means base is ancestor → already up to date
      return 'up_to_date'
    } catch {
      // Non-zero exit = base is NOT an ancestor → rebase needed
    }

    log.info({ baseBranch }, 'Base branch has moved ahead — rebasing')

    // Attempt rebase
    try {
      await runGit(['rebase', `origin/${baseBranch}`], {
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
          // Abort itself failed — worktree may be in bad state
          log.error('Failed to abort rebase')
        }
        return 'conflict'
      }
      throw rebaseErr
    }

    // Push with --force-with-lease
    await runGit(['push', '--force-with-lease', 'origin', branchName], {
      cwd: worktreePath,
      timeout: 60_000,
    })

    log.info({ baseBranch }, 'Rebased and pushed successfully')
    return 'rebased'
  } catch (err) {
    log.error({ err }, 'Auto-rebase failed')
    return 'error'
  }
}
