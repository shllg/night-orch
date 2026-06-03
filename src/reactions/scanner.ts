import type { ForgeAdapter, PRCheckStatus, ForgePRReview, ForgePRReviewComment } from '../forge/types.js'
import type { MentionFeedbackReaction, ReactionCursor, ReactionEnvelope, ReactionScanResult } from './types.js'
import { isBotAuthored, isBotLogin } from '../forge/bot-comment.js'
import { parseMentions } from '../runner/comment-commands.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import { sanitizeUntrustedText } from '../workers/prompt/compiler.js'

const EMPTY_CURSOR: ReactionCursor = {
  lastReviewId: 0,
  lastCommentId: 0,
  lastIssueCommentId: 0,
  lastCheckConclusion: null,
  lastMergeableState: null,
}

export interface ReactionScanOptions {
  acceptMentions?: boolean
  requireCollaborator?: boolean
  mentionAliases?: readonly string[]
  botUser?: string
  reviewBotAllowlist?: readonly string[]
}

/**
 * Scan a PR for new events that warrant a reaction:
 * - CI/check failures (new failure since last scan)
 * - Human review submissions (changes_requested, commented with body)
 * - Inline review comments (new since last scan)
 *
 * Bot-vs-human distinction is marker-based (see isBotAuthored), not
 * author-identity-based, so single-user deployments work correctly.
 *
 * Returns only NEW reactions since the provided cursor.
 * The caller is responsible for persisting the returned cursor.
 */
export async function scanForReactions(
  forge: ForgeAdapter,
  repo: string,
  prNumber: number,
  issueNumber: number,
  cursor: ReactionCursor = EMPTY_CURSOR,
  options: ReactionScanOptions = {},
): Promise<ReactionScanResult> {
  const reactions: ReactionEnvelope[] = []
  const newCursor: ReactionCursor = {
    ...cursor,
    lastIssueCommentId: cursor.lastIssueCommentId ?? 0,
  }
  const now = nowUtcIso()
  const reviewBotAllowlist = new Set(options.reviewBotAllowlist ?? [])

  // 0. Check mergeability (conflicting PRs should trigger rebase flow).
  //    Edge-deduped via cursor — emit only on transition into 'conflicting'
  //    so a persistently conflicting PR doesn't re-queue on every scan.
  if (forge.getPR) {
    try {
      const pr = await forge.getPR(repo, prNumber)
      if (pr.state === 'open') {
        const mergeableState: 'mergeable' | 'conflicting' | 'unknown' =
          pr.mergeable === true ? 'mergeable' : pr.mergeable === false ? 'conflicting' : 'unknown'
        if (mergeableState === 'conflicting' && cursor.lastMergeableState !== 'conflicting') {
          reactions.push({
            type: 'merge_conflict',
            repo,
            prNumber,
            issueNumber,
            summary: 'PR has merge conflicts with base branch',
            context: 'PR cannot be merged cleanly. Refresh the branch against the latest base branch, resolve conflicts, then rerun verify.',
            detectedAt: now,
          })
        }
        newCursor.lastMergeableState = mergeableState
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
          checkStatus: status,
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
      (r) => r.id > cursor.lastReviewId && isAcceptableReviewAuthor(r.user, r.body, reviewBotAllowlist),
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
        reviews: actionableReviews,
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
      (c) => c.id > cursor.lastCommentId && isAcceptableReviewAuthor(c.user, c.body, reviewBotAllowlist),
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
        comments: newComments,
      })
    }

    const maxCommentId = comments.reduce((max, c) => Math.max(max, c.id), cursor.lastCommentId)
    newCursor.lastCommentId = maxCommentId
  } catch (err) {
    logger.debug({ repo, prNumber, err }, 'Failed to check review comments for reaction scan')
  }

  // 4. Check free-form mentions in issue/PR conversation comments.
  if (options.acceptMentions ?? false) {
    try {
      const aliases = mentionAliases(options)
      const comments = await forge.listIssueComments(repo, issueNumber)
      const newComments = comments.filter(
        (c) => c.id > (cursor.lastIssueCommentId ?? 0) && c.user !== options.botUser,
      )
      for (const mention of parseMentions(newComments, aliases)) {
        if (!await canAcceptMentionAuthor(forge, repo, mention.user, options, reviewBotAllowlist)) {
          continue
        }
        const reaction: MentionFeedbackReaction = {
          type: 'mention_feedback',
          repo,
          prNumber,
          issueNumber,
          summary: `Mention feedback from ${mention.user}`,
          context: formatMentionContext(mention.user, mention.body),
          detectedAt: now,
          author: mention.user,
          body: mention.body,
          locationKind: 'issue_comment',
          commentId: mention.commentId,
          commentUrl: null,
        }
        reactions.push(reaction)
      }
      const maxIssueCommentId = comments.reduce((max, c) => Math.max(max, c.id), cursor.lastIssueCommentId ?? 0)
      newCursor.lastIssueCommentId = maxIssueCommentId
    } catch (err) {
      logger.debug({ repo, issueNumber, err }, 'Failed to check issue comments for mention reactions')
    }
  }

  return { reactions, cursor: newCursor }
}

async function canAcceptMentionAuthor(
  forge: ForgeAdapter,
  repo: string,
  user: string,
  options: ReactionScanOptions,
  reviewBotAllowlist: Set<string>,
): Promise<boolean> {
  if (isBotLogin(user)) return reviewBotAllowlist.has(user)
  if (!(options.requireCollaborator ?? true)) return true
  if (!forge.isCollaborator) return false
  try {
    return await forge.isCollaborator(repo, user)
  } catch (err) {
    logger.warn({ repo, user, err }, 'Failed collaborator check for mention feedback user')
    return false
  }
}

function mentionAliases(options: ReactionScanOptions): string[] {
  const aliases = [...(options.mentionAliases ?? [])]
  if (options.botUser?.trim()) {
    aliases.push(`@${options.botUser.trim().replace(/^@/, '')}`)
  }
  return [...new Set(aliases)]
}

function isAcceptableReviewAuthor(user: string, body: string, reviewBotAllowlist: Set<string>): boolean {
  if (isBotAuthored(body)) return false
  if (isBotLogin(user)) return reviewBotAllowlist.has(user)
  return true
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

function formatMentionContext(author: string, body: string): string {
  return `[Review by @${author}]:\n${sanitizeUntrustedText(body)}`
}
