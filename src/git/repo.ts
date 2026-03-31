import { execa } from 'execa'
import { logger } from '../utils/logger.js'

/**
 * Fetch all refs from origin.
 */
export async function fetchOrigin(repoPath: string): Promise<void> {
  logger.debug({ repoPath }, 'Fetching from origin')
  await execa('git', ['fetch', 'origin'], { cwd: repoPath })
}

/**
 * Check if a branch exists locally.
 */
export async function branchExistsLocally(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

/**
 * Check if a branch exists on the remote.
 */
export async function branchExistsRemotely(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: repoPath,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Create a local branch from a given start point.
 */
export async function createBranch(
  repoPath: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await execa('git', ['branch', branch, startPoint], { cwd: repoPath })
}

/**
 * Create a local tracking branch from a remote branch.
 */
export async function createTrackingBranch(repoPath: string, branch: string): Promise<void> {
  await execa('git', ['branch', branch, `origin/${branch}`], { cwd: repoPath })
}

/**
 * Validate that a path is a git repository.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd: path })
    return true
  } catch {
    return false
  }
}

const MAX_DIFF_LENGTH = 50_000

/**
 * Get the full diff of all changes (committed + uncommitted + untracked)
 * relative to origin/<baseBranch>.
 *
 * The coder writes files to disk but doesn't commit. To capture everything
 * (including new untracked files), we temporarily stage all changes, diff
 * the staged tree against the base, then unstage. The later commit step
 * does its own `git add -A` so unstaging here is safe.
 */
export async function getDiffAgainstBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  try {
    // Stage everything so untracked files appear in the diff
    await execa('git', ['add', '-A'], { cwd: worktreePath })

    const { stdout } = await execa(
      'git',
      ['diff', '--staged', `origin/${baseBranch}`],
      { cwd: worktreePath },
    )

    // Unstage — the commit step will re-stage later
    await execa('git', ['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })

    if (!stdout || stdout.trim() === '') {
      logger.warn({ worktreePath, baseBranch }, 'Diff against base branch is empty')
      return ''
    }

    if (stdout.length <= MAX_DIFF_LENGTH) return stdout
    return stdout.slice(0, MAX_DIFF_LENGTH) + '\n\n[... diff truncated at 50KB ...]'
  } catch (err) {
    // Always unstage on error
    await execa('git', ['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })
    logger.warn({ worktreePath, baseBranch, err }, 'Failed to get diff against base branch')
    return ''
  }
}

/**
 * Get the HEAD commit SHA for a worktree.
 */
export async function getHeadSha(worktreePath: string): Promise<string> {
  const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
  return result.stdout.trim()
}

/**
 * Merge a branch into the current HEAD using --no-ff.
 * Returns success/failure so the caller can decide whether to eject.
 */
export async function mergeNoFF(
  worktreePath: string,
  branch: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await execa('git', ['merge', '--no-ff', branch, '-m', `Merge ${branch}`], { cwd: worktreePath })
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Cherry-pick a single commit SHA onto the current HEAD.
 * Aborts the cherry-pick automatically on failure.
 */
export async function cherryPick(
  worktreePath: string,
  sha: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await execa('git', ['cherry-pick', sha], { cwd: worktreePath })
    return { success: true }
  } catch (err) {
    try { await execa('git', ['cherry-pick', '--abort'], { cwd: worktreePath }) } catch { /* ignore */ }
    return { success: false, error: String(err) }
  }
}

/**
 * Abort an in-progress merge. No-op if there is nothing to abort.
 */
export async function abortMerge(worktreePath: string): Promise<void> {
  try { await execa('git', ['merge', '--abort'], { cwd: worktreePath }) } catch { /* ignore */ }
}

/**
 * Get the list of changed files (committed + uncommitted + untracked)
 * relative to origin/<baseBranch>.
 */
export async function getChangedFilesAgainstBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  try {
    // Stage everything to capture untracked files
    await execa('git', ['add', '-A'], { cwd: worktreePath })

    const { stdout } = await execa(
      'git',
      ['diff', '--staged', '--name-only', `origin/${baseBranch}`],
      { cwd: worktreePath },
    )

    // Unstage
    await execa('git', ['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })

    return stdout.trim().split('\n').filter(Boolean)
  } catch (err) {
    await execa('git', ['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })
    logger.warn({ worktreePath, baseBranch, err }, 'Failed to get changed files against base branch')
    return []
  }
}
