import type { PRCheckStatus, ForgePRReview, ForgePRReviewComment } from '../forge/types.js'

export type ReactionType = 'ci_failure' | 'human_review' | 'review_comment' | 'merge_conflict'

export interface Reaction {
  type: ReactionType
  repo: string
  prNumber: number
  issueNumber: number
  /** Human-readable summary of what triggered this reaction. */
  summary: string
  /** Detailed context to feed back to the agent. */
  context: string
  /** When the triggering event occurred. */
  detectedAt: string
}

export interface CIFailureReaction extends Reaction {
  type: 'ci_failure'
  checkStatus: PRCheckStatus
}

export interface HumanReviewReaction extends Reaction {
  type: 'human_review'
  reviews: ForgePRReview[]
}

export interface ReviewCommentReaction extends Reaction {
  type: 'review_comment'
  comments: ForgePRReviewComment[]
}

export interface ReactionScanResult {
  reactions: Reaction[]
  /** Opaque state to persist for deduplication across scans. */
  cursor: ReactionCursor
}

/**
 * Tracks what we've already seen to avoid re-reacting.
 * Stored in the DB per repo+issue.
 */
export interface ReactionCursor {
  lastReviewId: number
  lastCommentId: number
  lastCheckConclusion: string | null
}
