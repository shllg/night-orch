/**
 * Resolution of a branch-refresh / rebase re-evaluation, computed before any
 * state transition or side effect.
 *
 * `review_ready` is only valid when the run already has a published PR. A
 * rebase no-op (`rebased: false`) — or even a clean rebase — on a branch that
 * was never published is NOT genuinely ready for review; it must fall through
 * to the code loop instead of phantom-transitioning to `review_ready`.
 */
export type BranchRefreshTransition =
  | { kind: 'review_ready'; reason: 'rebased_verify_passed' | 'already_up_to_date' }
  | { kind: 'continue_to_loop'; reason: 'no_published_pr' | 'verify_failed' }

export interface BranchRefreshTransitionInput {
  /** Whether the branch was actually rebased/updated (`false` = already up to date). */
  rebased: boolean
  /**
   * Whether verify passed. Note: a rebase no-op reports this as `true` without
   * running verify, so it cannot stand in for "genuinely ready" on its own.
   */
  verifyPassed: boolean
  /** Whether a PR has been published for this run (`run.prNumber !== null`). */
  hasPublishedPr: boolean
}

/**
 * Decide what a branch-refresh run should do after rebase + verify, gating the
 * `review_ready` transition on an actual published PR to avoid the phantom
 * "ready for review" produced by a rebase no-op on an unpublished branch.
 */
export function decideBranchRefreshTransition(
  input: BranchRefreshTransitionInput,
): BranchRefreshTransition {
  const { rebased, verifyPassed, hasPublishedPr } = input

  if (!verifyPassed) {
    return { kind: 'continue_to_loop', reason: 'verify_failed' }
  }

  if (!hasPublishedPr) {
    return { kind: 'continue_to_loop', reason: 'no_published_pr' }
  }

  return {
    kind: 'review_ready',
    reason: rebased ? 'rebased_verify_passed' : 'already_up_to_date',
  }
}
