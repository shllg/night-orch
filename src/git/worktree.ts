import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../utils/logger.js'
import {
  fetchOrigin,
  branchExistsLocally,
  branchExistsRemotely,
  createBranch,
  createTrackingBranch,
} from './repo.js'
import { runGit } from './process.js'

export interface WorktreeInfo {
  path: string
  branchName: string
  exists: boolean
  isClean: boolean
  /** True if rebase onto base branch was attempted but failed due to conflicts. */
  rebaseConflict: boolean
}

export interface EnsureWorktreeParams {
  repoLocalPath: string
  baseBranch: string
  branchName: string
  worktreePath: string
  /** Hard-reset the branch to baseBranch, discarding all prior commits. */
  resetToBase?: boolean
}

export interface WorktreeManager {
  ensure(params: EnsureWorktreeParams): Promise<WorktreeInfo>
  remove(worktreePath: string, deleteBranch?: boolean): Promise<void>
  list(repoLocalPath: string, worktreeRoot: string): Promise<WorktreeInfo[]>
}

export function createWorktreeManager(): WorktreeManager {
  return {
    async ensure(params: EnsureWorktreeParams): Promise<WorktreeInfo> {
      const { repoLocalPath, baseBranch, branchName, worktreePath, resetToBase } = params

      // 1. Fetch
      await fetchOrigin(repoLocalPath)

      // 2. Ensure branch exists
      const localExists = await branchExistsLocally(repoLocalPath, branchName)
      const remoteExists = await branchExistsRemotely(repoLocalPath, branchName)

      if (!localExists) {
        if (remoteExists) {
          logger.info({ branchName }, 'Creating local tracking branch from remote')
          await createTrackingBranch(repoLocalPath, branchName)
        } else {
          logger.info({ branchName, baseBranch }, 'Creating new branch from base')
          await createBranch(repoLocalPath, branchName, baseBranch)
        }
      }

      // 3. Ensure worktree exists
      if (existsSync(worktreePath)) {
        const valid = await validateWorktree(worktreePath, branchName)
        if (valid) {
          // Clean any leftover uncommitted state from prior runs
          await resetWorktree(worktreePath)

          if (resetToBase) {
            // Prior run produced tainted work — discard all commits and start fresh
            logger.info({ worktreePath, branchName, baseBranch }, 'Resetting branch to base — prior run was tainted')
            await hardResetToBase(worktreePath, baseBranch)
            const isClean = await isWorktreeClean(worktreePath)
            return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: false }
          }

          logger.info({ worktreePath, branchName }, 'Reusing existing worktree')
          // Attempt rebase onto latest base branch; on conflict, preserve branch as-is
          const rebased = await rebaseOnto(worktreePath, baseBranch)
          if (!rebased) {
            logger.warn({ worktreePath, baseBranch }, 'Rebase conflict — preserving existing work, coder will handle divergence')
          }
          const isClean = await isWorktreeClean(worktreePath)
          return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: !rebased }
        }

        // Corrupt — remove and recreate
        logger.warn({ worktreePath }, 'Removing corrupt worktree')
        await removeWorktree(repoLocalPath, worktreePath)
      }

      return await createFreshWorktree(repoLocalPath, baseBranch, branchName, worktreePath)
    },

    async remove(worktreePath: string, deleteBranch = false): Promise<void> {
      // Need the main repo path to remove worktree
      const repoPath = await getMainRepoPath(worktreePath)
      const branchName = deleteBranch ? await getCurrentBranch(worktreePath) : null

      await removeWorktree(repoPath, worktreePath)

      if (branchName) {
        try {
          await runGit(['branch', '-D', branchName], { cwd: repoPath })
          logger.info({ branchName }, 'Deleted branch')
        } catch (err) {
          logger.warn({ branchName, err }, 'Failed to delete branch')
        }
      }
    },

    async list(repoLocalPath: string, worktreeRoot: string): Promise<WorktreeInfo[]> {
      const { stdout } = await runGit(['worktree', 'list', '--porcelain'], {
        cwd: repoLocalPath,
      })

      const worktrees: WorktreeInfo[] = []
      let currentPath = ''
      let currentBranch = ''

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.slice('worktree '.length)
        } else if (line.startsWith('branch ')) {
          currentBranch = line.slice('branch refs/heads/'.length)
        } else if (line === '') {
          // End of entry
          if (currentPath && currentPath.startsWith(worktreeRoot)) {
            worktrees.push({
              path: currentPath,
              branchName: currentBranch,
              exists: existsSync(currentPath),
              isClean: true, // Would need git status check for accuracy
              rebaseConflict: false,
            })
          }
          currentPath = ''
          currentBranch = ''
        }
      }

      return worktrees
    },
  }
}

async function createFreshWorktree(
  repoLocalPath: string,
  baseBranch: string,
  branchName: string,
  worktreePath: string,
): Promise<WorktreeInfo> {
  // Prune stale worktree registrations (directory deleted but still tracked by git)
  await runGit(['worktree', 'prune'], { cwd: repoLocalPath, reject: false })

  await mkdir(dirname(worktreePath), { recursive: true })

  logger.info({ worktreePath, branchName }, 'Creating worktree')
  await runGit(['worktree', 'add', worktreePath, branchName], {
    cwd: repoLocalPath,
  })

  // Attempt rebase onto latest base; on conflict, preserve branch as-is.
  // The AI coder will see the divergence and integrate base branch changes.
  const rebased = await rebaseOnto(worktreePath, baseBranch)
  if (!rebased) {
    logger.warn({ worktreePath, baseBranch }, 'Rebase conflict — branch preserved as-is, coder will handle divergence')
  }

  const isClean = await isWorktreeClean(worktreePath)
  return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: !rebased }
}

async function validateWorktree(worktreePath: string, expectedBranch: string): Promise<boolean> {
  try {
    const currentBranch = await getCurrentBranch(worktreePath)
    return currentBranch === expectedBranch
  } catch {
    return false
  }
}

async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
  return stdout.trim()
}

async function getMainRepoPath(worktreePath: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: worktreePath,
  })
  // git-common-dir returns the .git dir of the main repo
  return dirname(stdout.trim())
}

async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const { stdout } = await runGit(['status', '--porcelain'], { cwd: worktreePath })
  return stdout.trim() === ''
}

/**
 * Discard all uncommitted changes (tracked and untracked) so the worktree
 * starts each run in a pristine state.
 */
async function resetWorktree(worktreePath: string): Promise<void> {
  try {
    await runGit(['checkout', '.'], { cwd: worktreePath })
    await runGit(['clean', '-fd'], { cwd: worktreePath })
    logger.debug({ worktreePath }, 'Reset worktree to clean state')
  } catch (err) {
    logger.warn({ worktreePath, err }, 'Failed to reset worktree — continuing anyway')
  }
}

/**
 * Hard-reset the branch to the base branch tip, discarding all prior commits.
 * Used when a prior run produced tainted work that should not be preserved.
 */
async function hardResetToBase(worktreePath: string, baseBranch: string): Promise<void> {
  await runGit(['reset', '--hard', `origin/${baseBranch}`], { cwd: worktreePath })
  await runGit(['clean', '-fd'], { cwd: worktreePath })
}

/**
 * Rebase the current branch onto the latest base branch.
 * Returns true on success, false on conflict (after aborting the rebase).
 */
async function rebaseOnto(worktreePath: string, baseBranch: string): Promise<boolean> {
  try {
    await runGit(['rebase', `origin/${baseBranch}`], { cwd: worktreePath })
    logger.debug({ worktreePath, baseBranch }, 'Rebased onto base branch')
    return true
  } catch {
    logger.warn({ worktreePath, baseBranch }, 'Rebase conflict with base branch')
    try {
      await runGit(['rebase', '--abort'], { cwd: worktreePath })
    } catch (abortErr) {
      logger.debug({ worktreePath, err: abortErr }, 'Failed to abort rebase')
    }
    return false
  }
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath })
  } catch {
    // Fallback: prune
    await runGit(['worktree', 'prune'], { cwd: repoPath })
  }
}
