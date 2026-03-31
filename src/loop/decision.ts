import type { RunContext, LoopDecision } from './types.js'
import type { Config } from '../config/schema.js'
import { isPlanningIssue } from '../planning/mode.js'

/**
 * Determine next action based on review verdict, verify results,
 * iteration counts, and cost limits.
 *
 * Rules:
 * 1. Cost limit exceeded → block
 * 2. Max total agent passes reached → block
 * 3. APPROVED + verify pass → publish
 * 4. APPROVED + verify fail → iterate (fix verify failures)
 * 5. CHANGES_REQUIRED + under limit → iterate
 * 6. CHANGES_REQUIRED + at max review iterations → block
 * 7. BLOCKED verdict → block
 * 8. Parse failure + blockOnAmbiguousReview → block
 * 9. Parse failure + !blockOnAmbiguousReview → iterate (one more try)
 */
export function decide(
  ctx: RunContext,
  loopConfig: Config['loop'],
  securityConfig: Config['security'],
): LoopDecision {
  const maxReviewIter = ctx.adjustedLimits.maxReviewIterations
  const maxTotalPasses = ctx.adjustedLimits.maxTotalAgentPasses

  // Rule 1: Cost limit
  // (Caller should check before invoking, but double-check here)
  if (ctx.estimatedCostUsd > securityConfig.maxCostPerRunUsd) {
    return { action: 'block', reason: `Per-run cost limit exceeded: $${ctx.estimatedCostUsd.toFixed(2)} > $${securityConfig.maxCostPerRunUsd}`, blockReason: 'cost_limit' }
  }

  // Rule 2: Max total passes
  if (ctx.totalAgentPasses >= maxTotalPasses) {
    return { action: 'block', reason: `Max total agent passes reached: ${ctx.totalAgentPasses}/${maxTotalPasses}`, blockReason: 'agent_pass_limit' }
  }

  // Planning-only mode bypasses verify/review gates. The commit guard enforces
  // that only the configured PRD markdown file is committed.
  if (isPlanningIssue(ctx.issue.labels, ctx.repoConfig)) {
    if (!ctx.codeResult) {
      return { action: 'block', reason: 'Planning-only mode requires a PRD output from the coder', blockReason: 'ambiguous_review' }
    }
    return { action: 'publish', reason: 'Planning-only mode: PRD ready for publishing' }
  }

  const review = ctx.reviewResult
  const verifyCommandsConfigured = (ctx.repoConfig.verify?.length ?? 0) > 0
  const verifyResultsAvailable = ctx.verifyResults.length > 0
  const allVerifyPassed = verifyResultsAvailable && ctx.verifyResults.every((r) => r.passed)
  const verificationSatisfied = loopConfig.requireVerificationPass
    ? verifyCommandsConfigured && verifyResultsAvailable && allVerifyPassed
    : ctx.verifyResults.length === 0 || allVerifyPassed

  // No review result = parse failure
  if (!review) {
    // Rules 8, 9
    if (loopConfig.blockOnAmbiguousReview) {
      return { action: 'block', reason: 'Review output not parseable and blockOnAmbiguousReview is true', blockReason: 'ambiguous_review' }
    }
    if (ctx.iteration >= maxReviewIter) {
      return { action: 'block', reason: 'Review parse failure at max iterations', blockReason: 'iteration_limit' }
    }
    return { action: 'iterate', reason: 'Review output not parseable — retrying', findings: [] }
  }

  switch (review.verdict) {
    case 'APPROVED':
      // Rules 3, 4
      if (loopConfig.requireVerificationPass && !verifyCommandsConfigured) {
        return { action: 'block', reason: 'Verification required but no verify commands are configured', blockReason: 'verify_config' }
      }
      if (loopConfig.requireVerificationPass && !verifyResultsAvailable) {
        return { action: 'block', reason: 'Verification required but no verify results are available', blockReason: 'verify_config' }
      }
      if (verificationSatisfied) {
        return { action: 'publish', reason: 'Review approved, all verification passed' }
      }
      return {
        action: 'iterate',
        reason: 'Review approved but verification failed — fixing',
        findings: [],
      }

    case 'CHANGES_REQUIRED':
      // Rules 5, 6
      if (ctx.iteration >= maxReviewIter) {
        return { action: 'block', reason: `Max review iterations reached: ${ctx.iteration}/${maxReviewIter}`, blockReason: 'iteration_limit' }
      }
      return {
        action: 'iterate',
        reason: `Review requested changes (iteration ${ctx.iteration}/${maxReviewIter})`,
        findings: review.findings,
      }

    case 'BLOCKED':
      // Rule 7
      return { action: 'block', reason: `Reviewer blocked: ${review.summary}`, blockReason: 'reviewer_blocked' }

    default:
      return { action: 'error', reason: `Unknown review verdict: ${review.verdict as string}` }
  }
}
