import { describe, it, expect } from 'vitest'
import { decideBranchRefreshTransition } from '../../src/poller/branch-refresh-decision.js'

describe('decideBranchRefreshTransition', () => {
  it('returns review_ready (already_up_to_date) for a rebase no-op when a PR exists', () => {
    expect(
      decideBranchRefreshTransition({ rebased: false, verifyPassed: true, hasPublishedPr: true }),
    ).toEqual({ kind: 'review_ready', reason: 'already_up_to_date' })
  })

  it('returns review_ready (rebased_verify_passed) for a successful rebase when a PR exists', () => {
    expect(
      decideBranchRefreshTransition({ rebased: true, verifyPassed: true, hasPublishedPr: true }),
    ).toEqual({ kind: 'review_ready', reason: 'rebased_verify_passed' })
  })

  it('does NOT return review_ready for a rebase no-op when no PR exists', () => {
    // Acceptance: an issue with no PR never lands in review_ready via a rebase no-op.
    expect(
      decideBranchRefreshTransition({ rebased: false, verifyPassed: true, hasPublishedPr: false }),
    ).toEqual({ kind: 'continue_to_loop', reason: 'no_published_pr' })
  })

  it('does NOT return review_ready for a successful rebase when no PR exists', () => {
    expect(
      decideBranchRefreshTransition({ rebased: true, verifyPassed: true, hasPublishedPr: false }),
    ).toEqual({ kind: 'continue_to_loop', reason: 'no_published_pr' })
  })

  it('continues to the loop when verify failed, regardless of PR existence', () => {
    expect(
      decideBranchRefreshTransition({ rebased: true, verifyPassed: false, hasPublishedPr: true }),
    ).toEqual({ kind: 'continue_to_loop', reason: 'verify_failed' })
    expect(
      decideBranchRefreshTransition({ rebased: false, verifyPassed: false, hasPublishedPr: false }),
    ).toEqual({ kind: 'continue_to_loop', reason: 'verify_failed' })
  })
})
