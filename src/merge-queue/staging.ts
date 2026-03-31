import { execa } from 'execa'
import { getHeadSha, mergeNoFF, abortMerge } from '../git/repo.js'
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

  // Fetch latest and create staging branch from base
  await execa('git', ['fetch', 'origin'], { cwd: repoLocalPath })
  await execa('git', ['checkout', '-B', stagingBranch, `origin/${baseBranch}`], { cwd: repoLocalPath })

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
      await execa('git', ['fetch', 'origin', pr.headBranch], { cwd: repoLocalPath })

      // Try to merge
      const mergeResult = await mergeNoFF(repoLocalPath, `origin/${pr.headBranch}`)
      if (mergeResult.success) {
        merged.push(prNumber)
        logger.info({ repo, prNumber, branch: pr.headBranch }, 'Merged PR into staging')
      } else {
        await abortMerge(repoLocalPath)
        ejected.push(prNumber)
        logger.warn({ repo, prNumber, branch: pr.headBranch, error: mergeResult.error }, 'Merge conflict — ejecting PR')
      }
    } catch (err) {
      ejected.push(prNumber)
      logger.warn({ repo, prNumber, err }, 'Failed to merge PR into staging — ejecting')
    }
  }

  const stagingSha = await getHeadSha(repoLocalPath)

  // Push staging branch
  await execa('git', ['push', 'origin', stagingBranch, '--force-with-lease'], { cwd: repoLocalPath })

  return { stagingSha, merged, ejected, stagingBranch }
}
