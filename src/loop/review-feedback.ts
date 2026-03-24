import type { ForgeAdapter, ForgePRReview, ForgePRReviewComment } from '../forge/types.js'

export interface PRReviewFeedback {
  reviews: ForgePRReview[]
  comments: ForgePRReviewComment[]
  summary: string
}

const MAX_SUMMARY_LENGTH = 8000

/**
 * Sanitize untrusted text from PR review comments.
 * Strips potential prompt injection patterns and truncates.
 */
function sanitizeReviewText(text: string): string {
  return text
    // Strip lines that look like system prompt instructions
    .replace(/^(System|Instructions|SYSTEM|IMPORTANT|OVERRIDE|IGNORE):.*/gim, '')
    // Strip HTML tags
    .replace(/<[^>]+>/g, '')
    // Collapse excessive whitespace
    .replace(/\s{3,}/g, '  ')
    .trim()
}

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
      parts.push(`[Review by ${review.user} (${review.state})]:\n${sanitizeReviewText(review.body)}`)
    }
  }

  for (const comment of comments) {
    const location = comment.path
      ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
      : 'general'
    parts.push(`[Comment by ${comment.user} on ${location}]:\n${sanitizeReviewText(comment.body)}`)
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
): Promise<PRReviewFeedback> {
  const [allReviews, allComments] = await Promise.all([
    forge.listPRReviews(repo, prNumber),
    forge.listPRReviewComments(repo, prNumber),
  ])

  // Filter out bot's own reviews and comments
  const reviews = allReviews.filter((r) => r.user !== botUser)
  const comments = allComments.filter((c) => c.user !== botUser)

  return {
    reviews,
    comments,
    summary: compileSummary(reviews, comments),
  }
}
