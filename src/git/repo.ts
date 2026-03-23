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
 * Get the diff of the current branch against the target branch.
 * Truncates output beyond MAX_DIFF_LENGTH to avoid blowing up prompts.
 */
export async function getDiffAgainstBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  try {
    const { stdout } = await execa(
      'git',
      ['diff', `origin/${baseBranch}...HEAD`],
      { cwd: worktreePath },
    )
    if (stdout.length <= MAX_DIFF_LENGTH) return stdout
    return stdout.slice(0, MAX_DIFF_LENGTH) + '\n\n[... diff truncated at 50KB ...]'
  } catch (err) {
    logger.warn({ worktreePath, baseBranch, err }, 'Failed to get diff against base branch')
    return ''
  }
}

/**
 * Get the list of changed files relative to the target branch.
 */
export async function getChangedFilesAgainstBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['diff', '--name-only', `origin/${baseBranch}...HEAD`],
      { cwd: worktreePath },
    )
    return stdout.trim().split('\n').filter(Boolean)
  } catch (err) {
    logger.warn({ worktreePath, baseBranch, err }, 'Failed to get changed files against base branch')
    return []
  }
}
