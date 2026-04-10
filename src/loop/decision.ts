import type { RunContext, LoopDecision } from './types.js'
import type { Config } from '../config/schema.js'
import { isPlanningIssue } from '../planning/mode.js'
import { costLimitRecoveryHint } from './cost.js'
import { blocked } from './state.js'

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
  options: { requireReview?: boolean; costModel?: Config['cost']['model'] } = {},
): LoopDecision {
  const maxReviewIter = ctx.adjustedLimits.maxReviewIterations
  const maxTotalPasses = ctx.adjustedLimits.maxTotalAgentPasses
  const requireReview = options.requireReview ?? true
  const costModel = options.costModel ?? 'pay-per-use'

  // Rule 1: Per-run cost limit
  // (Primary check lives in the engine via CostTracker.checkBudget which also
  // covers the daily cap; this is a pure-function fallback that only sees the
  // run-local estimate, so it can only catch the per-run overrun here.)
  // Skipped in subscription-like modes — the engine-level CostTracker handles
  // enforcement policy for subscription-metered and advisory-only subscription.
  if (costModel === 'pay-per-use' && ctx.estimatedCostUsd > securityConfig.maxCostPerRunUsd) {
    const reason =
      `Per-run cost limit exceeded: $${ctx.estimatedCostUsd.toFixed(2)} >= ` +
      `$${securityConfig.maxCostPerRunUsd.toFixed(2)}. ${costLimitRecoveryHint('per-run')}`
    return {
      action: 'block',
      reason,
      state: blocked(
        {
          type: 'costLimit',
          limit: 'per-run',
          actualUsd: ctx.estimatedCostUsd,
          limitUsd: securityConfig.maxCostPerRunUsd,
        },
        { message: reason },
      ),
    }
  }

  // Rule 2: Max total passes
  if (ctx.totalAgentPasses >= maxTotalPasses) {
    const reason = `Max total agent passes reached: ${ctx.totalAgentPasses}/${maxTotalPasses}`
    return {
      action: 'block',
      reason,
      state: blocked(
        { type: 'agentPassLimit', passes: ctx.totalAgentPasses, max: maxTotalPasses },
        { message: reason },
      ),
    }
  }

  // Planning-only mode bypasses verify/review gates. The commit guard enforces
  // that only the configured PRD markdown file is committed.
  if (isPlanningIssue(ctx.issue.labels, ctx.repoConfig)) {
    if (!ctx.codeResult) {
      const reason = 'Planning-only mode requires a PRD output from the coder'
      return {
        action: 'block',
        reason,
        state: blocked(
          { type: 'ambiguousReview', excerpt: reason },
          { message: reason },
        ),
      }
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
    // Lightweight workflows may intentionally omit reviewer phases.
    if (!requireReview) {
      if (loopConfig.requireVerificationPass && !verifyCommandsConfigured) {
        const reason = 'Verification required but no verify commands are configured'
        return {
          action: 'block',
          reason,
          state: blocked(
            { type: 'verifyConfig', detail: 'no verify commands configured' },
            { message: reason },
          ),
        }
      }
      if (loopConfig.requireVerificationPass && !verifyResultsAvailable) {
        const reason = 'Verification required but no verify results are available'
        return {
          action: 'block',
          reason,
          state: blocked(
            { type: 'verifyConfig', detail: 'no verify results available' },
            { message: reason },
          ),
        }
      }
      if (verificationSatisfied) {
        return { action: 'publish', reason: 'Verification passed in no-review workflow' }
      }
      if (ctx.iteration >= maxReviewIter) {
        const reason = `Max review iterations reached: ${ctx.iteration}/${maxReviewIter}`
        return {
          action: 'block',
          reason,
          state: blocked(
            { type: 'iterationLimit', iterations: ctx.iteration, max: maxReviewIter },
            { message: reason },
          ),
        }
      }
      return {
        action: 'iterate',
        reason: 'Verification failed in no-review workflow — retrying',
        findings: [],
      }
    }

    // Rules 8, 9
    if (loopConfig.blockOnAmbiguousReview) {
      const reason = 'Review output not parseable and blockOnAmbiguousReview is true'
      return {
        action: 'block',
        reason,
        state: blocked(
          { type: 'ambiguousReview', excerpt: 'review output could not be parsed' },
          { message: reason },
        ),
      }
    }
    if (ctx.iteration >= maxReviewIter) {
      const reason = 'Review parse failure at max iterations'
      return {
        action: 'block',
        reason,
        state: blocked(
          { type: 'iterationLimit', iterations: ctx.iteration, max: maxReviewIter },
          { message: reason },
        ),
      }
    }
    return { action: 'iterate', reason: 'Review output not parseable — retrying', findings: [] }
  }

  switch (review.verdict) {
    case 'APPROVED': {
      // Rules 3, 4
      if (loopConfig.requireVerificationPass && !verifyCommandsConfigured) {
        const reason = 'Verification required but no verify commands are configured'
        return {
          action: 'block',
          reason,
          state: blocked(
            { type: 'verifyConfig', detail: 'no verify commands configured' },
            { message: reason },
          ),
        }
      }
      if (loopConfig.requireVerificationPass && !verifyResultsAvailable) {
        const reason = 'Verification required but no verify results are available'
        return {
          action: 'block',
          reason,
          state: blocked(
            { type: 'verifyConfig', detail: 'no verify results available' },
            { message: reason },
          ),
        }
      }
      if (verificationSatisfied) {
        return { action: 'publish', reason: 'Review approved, all verification passed' }
      }
      return {
        action: 'iterate',
        reason: 'Review approved but verification failed — fixing',
        findings: [],
      }
    }

    case 'CHANGES_REQUIRED': {
      // Rules 5, 6
      if (ctx.iteration >= maxReviewIter) {
        const reason = `Max review iterations reached: ${ctx.iteration}/${maxReviewIter}`
        return {
          action: 'block',
          reason,
          state: blocked(
            { type: 'iterationLimit', iterations: ctx.iteration, max: maxReviewIter },
            { message: reason },
          ),
        }
      }
      return {
        action: 'iterate',
        reason: `Review requested changes (iteration ${ctx.iteration}/${maxReviewIter})`,
        findings: review.findings,
      }
    }

    case 'BLOCKED': {
      // Rule 7
      const reason = `Reviewer blocked: ${review.summary}`
      return {
        action: 'block',
        reason,
        state: blocked({ type: 'reviewerBlocked', summary: review.summary }, { message: reason }),
      }
    }

    default:
      return { action: 'error', reason: `Unknown review verdict: ${review.verdict as string}` }
  }
}
