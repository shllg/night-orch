import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getHeadSha, mergeNoFF, abortMerge } from '../git/repo.js'
import { runGit } from '../git/process.js'
import type { ForgeAdapter } from '../forge/types.js'
import { logger } from '../utils/logger.js'

export interface StagingResult {
  stagingSha: string
  merged: number[]        // PR numbers successfully merged
  ejected: number[]       // PR numbers that conflicted
  stagingBranch: string
}

/**
 * Build a staging branch by sequentially merging PR head branches.
 * Ejects conflicting PRs and continues with the rest.
 */
export async function buildStagingBranch(
  repoLocalPath: string,
  baseBranch: string,
  prNumbers: number[],
  forge: ForgeAdapter,
  repo: string,
  stagingBranchPrefix: string,
): Promise<StagingResult> {
  const stagingBranch = `${stagingBranchPrefix}/${Date.now()}`
  const merged: number[] = []
  const ejected: number[] = []
  const stagingWorktreePath = await createStagingWorktree(repoLocalPath, baseBranch, stagingBranch)

  try {
    for (const prNumber of prNumbers) {
      try {
        // Get PR to find head branch
        const pr = forge.getPR
          ? await forge.getPR(repo, prNumber)
          : await forge.findPRByBranch(repo, '') // fallback — won't work well

        if (!pr) {
          logger.warn({ repo, prNumber }, 'Could not find PR for merge — ejecting')
          ejected.push(prNumber)
          continue
        }

        // Fetch the PR branch
        await runGit(['fetch', 'origin', pr.headBranch], { cwd: stagingWorktreePath })

        // Try to merge
        const mergeResult = await mergeNoFF(stagingWorktreePath, `origin/${pr.headBranch}`)
        if (mergeResult.success) {
          merged.push(prNumber)
          logger.info({ repo, prNumber, branch: pr.headBranch }, 'Merged PR into staging')
        } else {
          await abortMerge(stagingWorktreePath)
          ejected.push(prNumber)
          logger.warn({ repo, prNumber, branch: pr.headBranch, error: mergeResult.error }, 'Merge conflict — ejecting PR')
        }
      } catch (err) {
        ejected.push(prNumber)
        logger.warn({ repo, prNumber, err }, 'Failed to merge PR into staging — ejecting')
      }
    }

    const stagingSha = await getHeadSha(stagingWorktreePath)

    // Push staging branch
    await runGit(['push', 'origin', stagingBranch, '--force-with-lease'], { cwd: stagingWorktreePath })

    return { stagingSha, merged, ejected, stagingBranch }
  } finally {
    await cleanupStagingWorktree(repoLocalPath, stagingWorktreePath)
  }
}

async function createStagingWorktree(
  repoLocalPath: string,
  baseBranch: string,
  stagingBranch: string,
): Promise<string> {
  await runGit(['fetch', 'origin'], { cwd: repoLocalPath })
  const stagingWorktreePath = await mkdtemp(join(tmpdir(), 'night-orch-staging-'))
  await runGit(
    ['worktree', 'add', '--force', '-B', stagingBranch, stagingWorktreePath, `origin/${baseBranch}`],
    { cwd: repoLocalPath },
  )
  return stagingWorktreePath
}

async function cleanupStagingWorktree(repoLocalPath: string, stagingWorktreePath: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', stagingWorktreePath, '--force'], {
      cwd: repoLocalPath,
      reject: false,
    })
  } catch (err) {
    logger.debug({ repoLocalPath, stagingWorktreePath, err }, 'Failed to remove staging worktree')
  }

  try {
    await runGit(['worktree', 'prune'], {
      cwd: repoLocalPath,
      reject: false,
    })
  } catch (err) {
    logger.debug({ repoLocalPath, err }, 'Failed to prune worktrees after staging cleanup')
  }

  try {
    await rm(stagingWorktreePath, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}
