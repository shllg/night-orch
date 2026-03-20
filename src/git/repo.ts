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
