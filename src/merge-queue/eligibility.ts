import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../forge/types.js'
import type { RepoConfig } from '../config/schema.js'
import { logger } from '../utils/logger.js'

export interface MergeCandidate {
  prNumber: number
  headSha: string
  issueNumber: number
  runId: string
}

interface RawRunRow {
  id: string
  issue_number: number
  pr_number: number
}

/**
 * Find PRs eligible for the merge queue:
 * - Run status is `review_ready` with a PR number
 * - CI checks are passing (if `getPRCheckStatus` is implemented)
 * - Human approval exists (if `requireApproval` is true in mergeQueue config)
 */
export async function findMergeEligiblePRs(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
): Promise<MergeCandidate[]> {
  const candidates: MergeCandidate[] = []

  const rows = db
    .prepare(
      "SELECT id, issue_number, pr_number FROM runs WHERE repo = ? AND status = 'review_ready' AND pr_number IS NOT NULL ORDER BY created_at",
    )
    .all(repoConfig.repo) as RawRunRow[]

  for (const row of rows) {
    try {
      // Check CI status if the forge adapter supports it
      if (forge.getPRCheckStatus) {
        const checkStatus = await forge.getPRCheckStatus(repoConfig.repo, row.pr_number)
        if (checkStatus.overall !== 'success') {
          logger.debug(
            { repo: repoConfig.repo, pr: row.pr_number, ciStatus: checkStatus.overall },
            'PR not merge-eligible: CI not passing',
          )
          continue
        }
      }

      // Check human approval if required
      if (repoConfig.mergeQueue.requireApproval) {
        const reviews = await forge.listPRReviews(repoConfig.repo, row.pr_number)
        const hasApproval = reviews.some((r) => r.state === 'approved')
        if (!hasApproval) {
          logger.debug(
            { repo: repoConfig.repo, pr: row.pr_number },
            'PR not merge-eligible: no human approval',
          )
          continue
        }
      }

      // Fetch the PR to get the head SHA when available
      let headSha = ''
      if (forge.getPR) {
        const pr = await forge.getPR(repoConfig.repo, row.pr_number)
        headSha = (pr as unknown as Record<string, unknown>)['headSha'] as string | undefined ?? ''
      }

      candidates.push({
        prNumber: row.pr_number,
        headSha,
        issueNumber: row.issue_number,
        runId: row.id,
      })
    } catch (err) {
      logger.warn(
        { repo: repoConfig.repo, pr: row.pr_number, err },
        'Failed to check merge eligibility for PR',
      )
    }
  }

  return candidates
}
