import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../utils/logger.js'
import {
  fetchOrigin,
  branchExistsLocally,
  branchExistsRemotely,
  createBranch,
  createTrackingBranch,
  mergeFromBranch,
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

export type UpdateStrategy = 'merge' | 'rebase'

export interface EnsureWorktreeParams {
  repoLocalPath: string
  baseBranch: string
  branchName: string
  worktreePath: string
  /** Hard-reset the branch to baseBranch, discarding all prior commits. */
  resetToBase?: boolean
  /** Reuse the branch as-is without auto-updating from base. */
  preserveBranchState?: boolean
  /** How to incorporate upstream base branch changes. Defaults to 'merge'. */
  updateStrategy?: UpdateStrategy
}

export interface WorktreeManager {
  ensure(params: EnsureWorktreeParams): Promise<WorktreeInfo>
  remove(worktreePath: string, deleteBranch?: boolean): Promise<void>
  list(repoLocalPath: string, worktreeRoot: string): Promise<WorktreeInfo[]>
}

export function createWorktreeManager(): WorktreeManager {
  return {
    async ensure(params: EnsureWorktreeParams): Promise<WorktreeInfo> {
      const {
        repoLocalPath,
        baseBranch,
        branchName,
        worktreePath,
        resetToBase,
        preserveBranchState,
        updateStrategy = 'merge',
      } = params

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
          const remoteBaseRef = `origin/${baseBranch}`
          logger.info({ branchName, baseBranch: remoteBaseRef }, 'Creating new branch from base')
          await createBranch(repoLocalPath, branchName, remoteBaseRef)
        }
      }

      // 3. Ensure worktree exists
      if (existsSync(worktreePath)) {
        const valid = await validateWorktree(worktreePath, branchName)
        if (valid) {
          const reused = await refreshExistingWorktree({
            worktreePath,
            branchName,
            baseBranch,
            resetToBase: resetToBase ?? false,
            preserveBranchState: preserveBranchState ?? false,
            updateStrategy,
          })

          // A rebase/merge conflict is handled by the caller (not a dirty-state
          // failure); return it as-is. A clean worktree is good to go.
          if (reused.isClean || reused.rebaseConflict) return reused

          // Auto-heal: the worktree is still dirty after a forceful reset —
          // typically untracked files git cannot remove (e.g. root-owned files a
          // docker run dropped in the tree). Discard the scratch worktree
          // entirely and recreate it from the branch. Committed work lives on the
          // branch and survives; only uncommitted cruft is lost.
          logger.warn(
            { worktreePath, branchName },
            'Worktree still dirty after reset — recreating from branch to self-heal',
          )
          await removeWorktree(repoLocalPath, worktreePath)
          return await createFreshWorktree(repoLocalPath, baseBranch, branchName, worktreePath, updateStrategy, {
            resetToBase: resetToBase ?? false,
            preserveBranchState: preserveBranchState ?? false,
          })
        }

        // Corrupt — remove and recreate
        logger.warn({ worktreePath }, 'Removing corrupt worktree')
        await removeWorktree(repoLocalPath, worktreePath)
      }

      return await createFreshWorktree(
        repoLocalPath,
        baseBranch,
        branchName,
        worktreePath,
        updateStrategy,
        {
          resetToBase: resetToBase ?? false,
          preserveBranchState: preserveBranchState ?? false,
        },
      )
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
  updateStrategy: UpdateStrategy = 'merge',
  options: {
    resetToBase: boolean
    preserveBranchState: boolean
  } = { resetToBase: false, preserveBranchState: false },
): Promise<WorktreeInfo> {
  // Prune stale worktree registrations (directory deleted but still tracked by git)
  await runGit(['worktree', 'prune'], { cwd: repoLocalPath, reject: false })

  await mkdir(dirname(worktreePath), { recursive: true })

  logger.info({ worktreePath, branchName }, 'Creating worktree')
  await runGit(['worktree', 'add', worktreePath, branchName], {
    cwd: repoLocalPath,
  })

  if (options.resetToBase) {
    logger.info({ worktreePath, branchName, baseBranch }, 'Fresh worktree requested with hard reset to base')
    await hardResetToBase(worktreePath, baseBranch)
    const isClean = await isWorktreeClean(worktreePath)
    return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: false }
  }

  if (options.preserveBranchState) {
    const isClean = await isWorktreeClean(worktreePath)
    return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: false }
  }

  // Attempt to incorporate latest base branch changes; on conflict, preserve branch as-is.
  // The AI coder will see the divergence and integrate base branch changes.
  const updateResult = await updateFromBase(worktreePath, baseBranch, updateStrategy)
  if (!updateResult.success) {
    logger.warn({ worktreePath, baseBranch, updateStrategy }, 'Update from base failed — branch preserved as-is, coder will handle divergence')
  }

  const isClean = await isWorktreeClean(worktreePath)
  return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: !updateResult.success }
}

/**
 * Refresh an existing, valid worktree for reuse: discard uncommitted cruft, then
 * bring it to the desired state per policy (`resetToBase` / `preserveBranchState`
 * / update-from-base). Returns the resulting state; the caller decides whether to
 * self-heal a still-dirty result by recreating the worktree.
 */
async function refreshExistingWorktree(params: {
  worktreePath: string
  branchName: string
  baseBranch: string
  resetToBase: boolean
  preserveBranchState: boolean
  updateStrategy: UpdateStrategy
}): Promise<WorktreeInfo> {
  const { worktreePath, branchName, baseBranch, resetToBase, preserveBranchState, updateStrategy } = params

  // Clean any leftover uncommitted state from prior runs.
  await resetWorktree(worktreePath)

  if (resetToBase) {
    // Prior run produced tainted work — discard all commits and start fresh.
    logger.info({ worktreePath, branchName, baseBranch }, 'Resetting branch to base — prior run was tainted')
    await hardResetToBase(worktreePath, baseBranch)
    const isClean = await isWorktreeClean(worktreePath)
    return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: false }
  }

  if (preserveBranchState) {
    logger.info({ worktreePath, branchName }, 'Reusing existing worktree without updating from base')
    const isClean = await isWorktreeClean(worktreePath)
    return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: false }
  }

  logger.info({ worktreePath, branchName, updateStrategy }, 'Reusing existing worktree')
  const updateResult = await updateFromBase(worktreePath, baseBranch, updateStrategy)
  if (!updateResult.success) {
    logger.warn({ worktreePath, baseBranch, updateStrategy }, 'Update from base failed — preserving existing work, coder will handle divergence')
  }
  const isClean = await isWorktreeClean(worktreePath)
  return { path: worktreePath, branchName, exists: true, isClean, rebaseConflict: !updateResult.success }
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
 * Return the `git status --porcelain` listing for a worktree (empty string when
 * clean). Used to make a dirty-worktree block actionable instead of opaque.
 * Best-effort: returns an explanatory string if git itself fails.
 */
export async function getWorktreeStatus(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await runGit(['status', '--porcelain'], { cwd: worktreePath })
    return stdout.trim()
  } catch (err) {
    return `<failed to read git status: ${String(err)}>`
  }
}

/**
 * Discard all uncommitted changes (tracked and untracked) so the worktree
 * starts each run in a pristine state.
 *
 * `reset --hard` restores tracked content and file modes; `clean -ffd` removes
 * untracked files AND nested git repos (the second `-f`) that a single `-f`
 * would skip. Files git still cannot remove (e.g. root-owned files a container
 * dropped in the tree) are left behind — the caller detects the residual dirty
 * state and self-heals by recreating the worktree. Errors are logged, not
 * thrown, for the same reason.
 */
async function resetWorktree(worktreePath: string): Promise<void> {
  try {
    await runGit(['reset', '--hard', 'HEAD'], { cwd: worktreePath })
    await runGit(['clean', '-ffd'], { cwd: worktreePath })
    logger.debug({ worktreePath }, 'Reset worktree to clean state')
  } catch (err) {
    logger.warn({ worktreePath, err }, 'Failed to reset worktree — caller will recreate if still dirty')
  }
}

/**
 * Hard-reset the branch to the base branch tip, discarding all prior commits.
 * Used when a prior run produced tainted work that should not be preserved.
 */
async function hardResetToBase(worktreePath: string, baseBranch: string): Promise<void> {
  await runGit(['reset', '--hard', `origin/${baseBranch}`], { cwd: worktreePath })
  await runGit(['clean', '-ffd'], { cwd: worktreePath })
}

/**
 * Incorporate upstream base branch changes into the worktree using the
 * configured strategy. Merge is the default — it creates a merge commit
 * but handles conflicts deterministically. Rebase replays commits for a
 * linear history but is fragile in automated contexts.
 *
 * On conflict (either strategy), the operation is aborted and the worktree
 * is left in its pre-update state.
 */
async function updateFromBase(
  worktreePath: string,
  baseBranch: string,
  strategy: UpdateStrategy,
): Promise<{ success: boolean; conflict: boolean }> {
  const remoteRef = `origin/${baseBranch}`

  // Check if base is already an ancestor of HEAD (no update needed)
  try {
    await runGit(['merge-base', '--is-ancestor', remoteRef, 'HEAD'], { cwd: worktreePath })
    logger.debug({ worktreePath, baseBranch, strategy }, 'Base branch already up to date')
    return { success: true, conflict: false }
  } catch {
    // Non-zero exit = base is NOT an ancestor → update needed
  }

  if (strategy === 'merge') {
    const result = await mergeFromBranch(worktreePath, remoteRef)
    if (result.success) {
      logger.debug({ worktreePath, baseBranch }, 'Merged base branch into worktree')
    }
    return result
  }

  // Rebase strategy (legacy)
  try {
    await runGit(['rebase', remoteRef], { cwd: worktreePath })
    logger.debug({ worktreePath, baseBranch }, 'Rebased onto base branch')
    return { success: true, conflict: false }
  } catch {
    logger.warn({ worktreePath, baseBranch }, 'Rebase conflict with base branch')
    try {
      await runGit(['rebase', '--abort'], { cwd: worktreePath })
    } catch (abortErr) {
      logger.debug({ worktreePath, err: abortErr }, 'Failed to abort rebase')
    }
    return { success: false, conflict: true }
  }
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath })
  } catch {
    // git worktree remove failed — prune stale metadata, then force-remove the directory
    await runGit(['worktree', 'prune'], { cwd: repoPath })
    if (existsSync(worktreePath)) {
      logger.warn({ worktreePath }, 'Force-removing orphaned worktree directory')
      await rm(worktreePath, { recursive: true, force: true })
    }
  }
}
