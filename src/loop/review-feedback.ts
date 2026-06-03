import type { ForgeAdapter, ForgePRReview, ForgePRReviewComment } from '../forge/types.js'
import { sanitizeUntrustedText } from '../workers/prompt/compiler.js'

export interface PRReviewFeedback {
  reviews: ForgePRReview[]
  comments: ForgePRReviewComment[]
  summary: string
}

export interface FetchPRReviewFeedbackOptions {
  reviewBotAllowlist?: readonly string[]
}

const MAX_SUMMARY_LENGTH = 8000

/**
 * Compile a human-readable summary of PR review feedback for prompt inclusion.
 */
function compileSummary(
  reviews: ForgePRReview[],
  comments: ForgePRReviewComment[],
): string {
  const parts: string[] = []

  for (const review of reviews) {
    if (review.body.trim()) {
      parts.push(`[Review by ${review.user} (${review.state})]:\n${sanitizeUntrustedText(review.body)}`)
    }
  }

  for (const comment of comments) {
    const location = comment.path
      ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
      : 'general'
    parts.push(`[Comment by ${comment.user} on ${location}]:\n${sanitizeUntrustedText(comment.body)}`)
  }

  const full = parts.join('\n\n')
  if (full.length <= MAX_SUMMARY_LENGTH) return full
  return `${full.slice(0, MAX_SUMMARY_LENGTH - 20).trimEnd()}\n\n[...truncated]`
}

/**
 * Fetch and compile PR review feedback from the forge.
 * Filters out the bot's own reviews/comments and sanitizes all text.
 */
export async function fetchPRReviewFeedback(
  forge: ForgeAdapter,
  repo: string,
  prNumber: number,
  botUser: string,
  options: FetchPRReviewFeedbackOptions = {},
): Promise<PRReviewFeedback> {
  const [allReviews, allComments] = await Promise.all([
    forge.listPRReviews(repo, prNumber),
    forge.listPRReviewComments(repo, prNumber),
  ])

  const reviewBotAllowlist = new Set(options.reviewBotAllowlist ?? [])
  const reviews = allReviews.filter((r) => shouldKeepFeedbackAuthor(r.user, botUser, reviewBotAllowlist))
  const comments = allComments.filter((c) => shouldKeepFeedbackAuthor(c.user, botUser, reviewBotAllowlist))

  return {
    reviews,
    comments,
    summary: compileSummary(reviews, comments),
  }
}

function shouldKeepFeedbackAuthor(user: string, botUser: string, reviewBotAllowlist: Set<string>): boolean {
  if (user === botUser) return false
  if (/\[bot\]$/i.test(user)) return reviewBotAllowlist.has(user)
  return true
}
