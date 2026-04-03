import type { ForgeAdapter, PRCheckStatus, ForgePRReview, ForgePRReviewComment } from '../forge/types.js'
import type { Reaction, ReactionCursor, ReactionScanResult } from './types.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'

const EMPTY_CURSOR: ReactionCursor = {
  lastReviewId: 0,
  lastCommentId: 0,
  lastCheckConclusion: null,
}

/**
 * Scan a PR for new events that warrant a reaction:
 * - CI/check failures (new failure since last scan)
 * - Human review submissions (changes_requested, commented with body)
 * - Inline review comments (new since last scan)
 *
 * Returns only NEW reactions since the provided cursor.
 * The caller is responsible for persisting the returned cursor.
 */
export async function scanForReactions(
  forge: ForgeAdapter,
  repo: string,
  prNumber: number,
  issueNumber: number,
  botUser: string,
  cursor: ReactionCursor = EMPTY_CURSOR,
): Promise<ReactionScanResult> {
  const reactions: Reaction[] = []
  const newCursor: ReactionCursor = { ...cursor }
  const now = nowUtcIso()

  // 0. Check mergeability (conflicting PRs should trigger rebase flow).
  if (forge.getPR) {
    try {
      const pr = await forge.getPR(repo, prNumber)
      if (pr.state === 'open' && pr.mergeable === false) {
        reactions.push({
          type: 'merge_conflict',
          repo,
          prNumber,
          issueNumber,
          summary: 'PR has merge conflicts with base branch',
          context: 'PR cannot be merged cleanly. Rebase onto the latest base branch, resolve conflicts, then rerun verify.',
          detectedAt: now,
        })
      }
    } catch (err) {
      logger.debug({ repo, prNumber, err }, 'Failed to check mergeability for reaction scan')
    }
  }

  // 1. Check CI status
  if (forge.getPRCheckStatus) {
    try {
      const status = await forge.getPRCheckStatus(repo, prNumber)
      if (status.overall === 'failure' && cursor.lastCheckConclusion !== 'failure') {
        const failedChecks = status.checks.filter((c) => c.conclusion === 'failure')
        const failedNames = failedChecks.map((c) => c.name).join(', ')
        reactions.push({
          type: 'ci_failure',
          repo,
          prNumber,
          issueNumber,
          summary: `CI failed: ${failedNames}`,
          context: formatCIContext(status),
          detectedAt: now,
        })
      }
      newCursor.lastCheckConclusion = status.overall
    } catch (err) {
      logger.debug({ repo, prNumber, err }, 'Failed to check CI status for reaction scan')
    }
  }

  // 2. Check for new human reviews
  try {
    const reviews = await forge.listPRReviews(repo, prNumber)
    const newReviews = reviews.filter(
      (r) => r.id > cursor.lastReviewId && r.user !== botUser,
    )

    const actionableReviews = newReviews.filter(
      (r) => r.state === 'changes_requested' || (r.state === 'commented' && r.body.trim().length > 0),
    )

    if (actionableReviews.length > 0) {
      reactions.push({
        type: 'human_review',
        repo,
        prNumber,
        issueNumber,
        summary: `Human review: ${actionableReviews.map((r) => `${r.user} (${r.state})`).join(', ')}`,
        context: formatReviewContext(actionableReviews),
        detectedAt: now,
      })
    }

    const maxReviewId = reviews.reduce((max, r) => Math.max(max, r.id), cursor.lastReviewId)
    newCursor.lastReviewId = maxReviewId
  } catch (err) {
    logger.debug({ repo, prNumber, err }, 'Failed to check reviews for reaction scan')
  }

  // 3. Check for new inline review comments
  try {
    const comments = await forge.listPRReviewComments(repo, prNumber)
    const newComments = comments.filter(
      (c) => c.id > cursor.lastCommentId && c.user !== botUser,
    )

    if (newComments.length > 0) {
      reactions.push({
        type: 'review_comment',
        repo,
        prNumber,
        issueNumber,
        summary: `${newComments.length} new inline comment(s) from ${[...new Set(newComments.map((c) => c.user))].join(', ')}`,
        context: formatCommentContext(newComments),
        detectedAt: now,
      })
    }

    const maxCommentId = comments.reduce((max, c) => Math.max(max, c.id), cursor.lastCommentId)
    newCursor.lastCommentId = maxCommentId
  } catch (err) {
    logger.debug({ repo, prNumber, err }, 'Failed to check review comments for reaction scan')
  }

  return { reactions, cursor: newCursor }
}

function formatCIContext(status: PRCheckStatus): string {
  const lines = ['## CI Status: FAILED\n']
  for (const check of status.checks) {
    const icon = check.conclusion === 'failure' ? 'FAIL' : check.conclusion === 'success' ? 'PASS' : check.conclusion.toUpperCase()
    lines.push(`- [${icon}] ${check.name}${check.detailsUrl ? ` (${check.detailsUrl})` : ''}`)
  }
  lines.push('\nPlease investigate the failing checks and fix the issues.')
  return lines.join('\n')
}

function formatReviewContext(reviews: ForgePRReview[]): string {
  const lines = ['## Human Review Feedback\n']
  for (const review of reviews) {
    lines.push(`### ${review.user} — ${review.state}`)
    if (review.body.trim()) {
      lines.push(review.body.trim())
    }
    lines.push('')
  }
  lines.push('Please address the review feedback above.')
  return lines.join('\n')
}

function formatCommentContext(comments: ForgePRReviewComment[]): string {
  const lines = ['## Inline Review Comments\n']
  for (const comment of comments) {
    const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : 'general'
    lines.push(`### ${comment.user} on ${location}`)
    lines.push(comment.body.trim())
    lines.push('')
  }
  lines.push('Please address the inline comments above.')
  return lines.join('\n')
}
