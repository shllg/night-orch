import { logger } from '../utils/logger.js'
import { runGit } from './process.js'
import { sanitizeError } from '../utils/sanitize-error.js'

/**
 * Fetch all refs from origin.
 */
export async function fetchOrigin(repoPath: string): Promise<void> {
  logger.debug({ repoPath }, 'Fetching from origin')
  await runGit(['fetch', 'origin'], { cwd: repoPath })
}

/**
 * Check if a branch exists locally.
 */
export async function branchExistsLocally(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoPath })
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
    await runGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
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
  await runGit(['branch', branch, startPoint], { cwd: repoPath })
}

/**
 * Create a local tracking branch from a remote branch.
 */
export async function createTrackingBranch(repoPath: string, branch: string): Promise<void> {
  await runGit(['branch', branch, `origin/${branch}`], { cwd: repoPath })
}

/**
 * Validate that a path is a git repository.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: path })
    return true
  } catch {
    return false
  }
}

const MAX_DIFF_LENGTH = 50_000

/** Discriminated result for diff computation. */
export interface DiffResult {
  /** The diff content (empty string if no changes or error). */
  diff: string
  /** Error description if git failed, null on success. */
  error: string | null
}

/**
 * Get the full diff of all changes (committed + uncommitted + untracked)
 * relative to origin/<baseBranch>.
 *
 * The coder writes files to disk but doesn't commit. To capture everything
 * (including new untracked files), we stage all changes and diff the staged
 * tree against the base. Files are left staged so that subsequent steps
 * (reviewer, commit) see them via standard git operations.
 */
export async function getDiffAgainstBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<DiffResult> {
  try {
    // Stage everything so untracked files appear in the diff
    await runGit(['add', '-A'], { cwd: worktreePath })

    const { stdout } = await runGit(
      ['diff', '--staged', `origin/${baseBranch}`],
      { cwd: worktreePath },
    )

    if (!stdout || stdout.trim() === '') {
      logger.warn({ worktreePath, baseBranch }, 'Diff against base branch is empty')
      return { diff: '', error: null }
    }

    const diff = stdout.length <= MAX_DIFF_LENGTH
      ? stdout
      : stdout.slice(0, MAX_DIFF_LENGTH) + '\n\n[... diff truncated at 50KB ...]'
    return { diff, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ worktreePath, baseBranch, err }, 'Failed to get diff against base branch')
    return { diff: '', error: `Failed to compute diff: ${message}` }
  }
}

/**
 * Get the HEAD commit SHA for a worktree.
 */
export async function getHeadSha(worktreePath: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: worktreePath })
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
    await runGit(['merge', '--no-ff', branch, '-m', `Merge ${branch}`], { cwd: worktreePath })
    return { success: true }
  } catch (err) {
    return { success: false, error: sanitizeError(err).message }
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
    await runGit(['cherry-pick', sha], { cwd: worktreePath })
    return { success: true }
  } catch (err) {
    try { await runGit(['cherry-pick', '--abort'], { cwd: worktreePath }) } catch { /* ignore */ }
    return { success: false, error: sanitizeError(err).message }
  }
}

/**
 * Merge a remote branch into the current HEAD using a regular merge commit.
 * On conflict the merge is aborted and the worktree is left clean.
 */
export async function mergeFromBranch(
  worktreePath: string,
  branch: string,
): Promise<{ success: boolean; conflict: boolean }> {
  try {
    await runGit(['merge', branch, '--no-edit'], { cwd: worktreePath })
    return { success: true, conflict: false }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    const isConflict = stderr.includes('CONFLICT') || stderr.includes('Automatic merge failed')
    try { await runGit(['merge', '--abort'], { cwd: worktreePath }) } catch { /* best-effort */ }
    return { success: false, conflict: isConflict }
  }
}

/**
 * Abort an in-progress merge. No-op if there is nothing to abort.
 */
export async function abortMerge(worktreePath: string): Promise<void> {
  try { await runGit(['merge', '--abort'], { cwd: worktreePath }) } catch { /* ignore */ }
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
    await runGit(['add', '-A'], { cwd: worktreePath })

    const { stdout } = await runGit(
      ['diff', '--staged', '--name-only', `origin/${baseBranch}`],
      { cwd: worktreePath },
    )

    // Unstage
    await runGit(['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })

    return stdout.trim().split('\n').filter(Boolean)
  } catch (err) {
    await runGit(['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })
    logger.warn({ worktreePath, baseBranch, err }, 'Failed to get changed files against base branch')
    return []
  }
}
