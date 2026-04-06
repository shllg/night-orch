import type Database from 'better-sqlite3'
import type { ForgeAdapter, ForgePRReview, PRReviewState } from '../forge/types.js'
import type { RepoConfig } from '../config/schema.js'
import { logger } from '../utils/logger.js'

/**
 * Reduce a list of reviews to the latest state per reviewer. GitHub and
 * Forgejo both return reviews in chronological order; we defensively sort
 * by `submittedAt` to preserve latest-wins semantics regardless of order.
 * Only decisive states (`approved`, `changes_requested`, `dismissed`) are
 * considered — `commented` is informational and does not override.
 */
export function latestReviewStatePerReviewer(reviews: ForgePRReview[]): Map<string, PRReviewState> {
  const sorted = [...reviews].sort((a, b) => {
    const at = a.submittedAt ?? ''
    const bt = b.submittedAt ?? ''
    return at < bt ? -1 : at > bt ? 1 : 0
  })
  const latest = new Map<string, PRReviewState>()
  for (const review of sorted) {
    if (review.state === 'commented') continue
    latest.set(review.user, review.state)
  }
  return latest
}

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
      `WITH canonical_ready AS (
         SELECT
           r.id,
           i.issue_number,
           i.pr_number,
           i.updated_at
         FROM issues i
         JOIN runs r
           ON r.id = i.current_run_id
         WHERE i.repo = ?
           AND i.status = 'review_ready'
           AND i.pr_number IS NOT NULL
           AND i.current_run_id IS NOT NULL
       ),
       fallback_ready AS (
         SELECT
           r.id,
           r.issue_number,
           r.pr_number,
           r.updated_at
         FROM runs r
         WHERE r.repo = ?
           AND r.status = 'review_ready'
           AND r.pr_number IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM issues i
             WHERE i.repo = r.repo
               AND i.issue_number = r.issue_number
               AND i.current_run_id = r.id
               AND i.status = 'review_ready'
           )
       )
       SELECT id, issue_number, pr_number
       FROM (
         SELECT id, issue_number, pr_number, updated_at FROM canonical_ready
         UNION ALL
         SELECT id, issue_number, pr_number, updated_at FROM fallback_ready
       )
       ORDER BY datetime(updated_at)`,
    )
    .all(repoConfig.repo, repoConfig.repo) as RawRunRow[]

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

      // Check human approval if required. Approval must be the *latest*
      // state from each reviewer — an `approved` review is invalidated by a
      // later `changes_requested` from the same reviewer.
      if (repoConfig.mergeQueue.requireApproval) {
        const reviews = await forge.listPRReviews(repoConfig.repo, row.pr_number)
        const latestByReviewer = latestReviewStatePerReviewer(reviews)
        const hasActiveChangesRequested = Array.from(latestByReviewer.values()).some(
          (state) => state === 'changes_requested',
        )
        const hasApproval = Array.from(latestByReviewer.values()).some((state) => state === 'approved')
        if (hasActiveChangesRequested || !hasApproval) {
          logger.debug(
            {
              repo: repoConfig.repo,
              pr: row.pr_number,
              hasActiveChangesRequested,
              hasApproval,
            },
            'PR not merge-eligible: approval stale or missing',
          )
          continue
        }
      }

      // Fetch the PR to verify it is still open and capture the head SHA.
      // Without this check a closed or already-merged PR can be queued.
      let headSha = ''
      if (forge.getPR) {
        const pr = await forge.getPR(repoConfig.repo, row.pr_number)
        if (pr.state !== 'open') {
          logger.debug(
            { repo: repoConfig.repo, pr: row.pr_number, state: pr.state },
            'PR not merge-eligible: not open',
          )
          continue
        }
        headSha = pr.headSha
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
