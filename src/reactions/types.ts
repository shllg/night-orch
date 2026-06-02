import type { PRCheckStatus, ForgePRReview, ForgePRReviewComment } from '../forge/types.js'
import type { ReviewFinding, ReviewerOutput } from '../workers/types.js'

export type ReactionType =
  | 'ci_failure'
  | 'human_review'
  | 'review_comment'
  | 'merge_conflict'
  | 'external_review'
  | 'mention_feedback'

/**
 * Common envelope fields shared by every reaction subtype. Consumers should
 * prefer the discriminated `ReactionEnvelope` union below over this base
 * interface so a missing `case` in a `switch (reaction.type)` becomes a
 * compile-time error instead of silently dropping events.
 */
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

export interface MergeConflictReaction extends Reaction {
  type: 'merge_conflict'
}

/**
 * Synthesised by the post-publish orchestrator when an external reviewer
 * (CodeRabbit-style worker step running with `runWhen: post-publish`)
 * returns a non-APPROVED verdict. Carries the structured `verdict` and
 * `findings` from the parsed reviewer output so downstream consumers (the
 * `continue` op, metrics, handoff renderer) do not need to re-parse the
 * markdown `context` payload.
 */
export interface ExternalReviewReaction extends Reaction {
  type: 'external_review'
  /** Workflow step id that produced this reaction (e.g. 'cr', 'snyk'). */
  stepId: string
  verdict: ReviewerOutput['verdict']
  findings: ReadonlyArray<ReviewFinding>
}

export interface MentionFeedbackReaction extends Reaction {
  type: 'mention_feedback'
  author: string
  body: string
  locationKind: 'issue_comment' | 'review' | 'review_comment'
  commentId: number
  commentUrl: string | null
}

/**
 * Discriminated union over every reaction subtype. Use this in function
 * signatures that route on `reaction.type` so the TypeScript compiler can
 * verify exhaustiveness via `assertNever`-style fall-through guards.
 */
export type ReactionEnvelope =
  | CIFailureReaction
  | HumanReviewReaction
  | ReviewCommentReaction
  | MergeConflictReaction
  | ExternalReviewReaction
  | MentionFeedbackReaction

export interface ReactionScanResult {
  reactions: ReactionEnvelope[]
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
  lastIssueCommentId: number
  lastCheckConclusion: string | null
  /**
   * Last observed mergeable state of the PR. `null` means never scanned.
   * `merge_conflict` reactions fire only on edge transitions into
   * 'conflicting' — not on every scan of a persistently conflicting PR.
   */
  lastMergeableState: 'mergeable' | 'conflicting' | 'unknown' | null
}
