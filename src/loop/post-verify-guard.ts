import type { Config } from '../config/schema.js'
import type { MetricsService } from '../metrics/service.js'
import { blockExit } from './block-exit.js'
import type { Checkpoint } from './checkpoint.js'
import { recordPhase, updateContext } from './context.js'
import { decideEmptyDiffRetry } from './decision.js'
import { blockedReasonToLegacy } from './state.js'
import type { RunContext } from './types.js'
import type { WorkflowStep } from './workflow.js'
import { findCoderStepBefore } from './step-executor.js'
import { logger } from '../utils/logger.js'

export type PostVerifyGuardResult =
  | { action: 'next'; ctx: RunContext }
  | { action: 'continue'; ctx: RunContext; stepIndex: number }
  | { action: 'return'; ctx: RunContext }

export function handlePostVerifyGuard(params: {
  ctx: RunContext
  checkpoint: Pick<Checkpoint, 'phaseBlocked'>
  steps: WorkflowStep[]
  stepIndex: number
  loopConfig: Config['loop']
  metrics?: MetricsService
}): PostVerifyGuardResult {
  const { checkpoint, loopConfig, metrics, steps, stepIndex } = params
  let { ctx } = params

  if (ctx.diffError) {
    const blockMessage = `Git diff failed: ${ctx.diffError}`
    checkpoint.phaseBlocked(ctx.runId, 'empty_diff_guard', blockMessage, ctx.iteration)
    return {
      action: 'return',
      ctx: recordPhase(
        updateContext(ctx, {
          currentPhase: 'error',
          terminalStatus: 'error',
          stepOutputs: { ...ctx.stepOutputs, blockMessage },
        }),
        'empty_diff_guard',
        'failure',
      ),
    }
  }

  const emptyDiffDecision = decideEmptyDiffRetry(ctx, loopConfig)
  if (emptyDiffDecision !== null) {
    if (emptyDiffDecision.action === 'block') {
      const blockMessage = emptyDiffDecision.state.message
      return {
        action: 'return',
        ctx: blockExit(
          ctx,
          checkpoint,
          'empty_diff_guard',
          blockedReasonToLegacy(emptyDiffDecision.state.reason),
          blockMessage,
        ),
      }
    }

    if (emptyDiffDecision.action === 'iterate' && emptyDiffDecision.jumpTo === 'coder') {
      const coderIndex = findCoderStepBefore(steps, stepIndex)
      if (coderIndex === -1) {
        ctx = updateContext(ctx, {
          verifyResults: [],
          reviewResult: null,
          reviewResults: {},
          diff: null,
          diffError: null,
        })
        logger.warn(
          { runId: ctx.runId },
          'Empty diff but no coder step to retry — proceeding to review',
        )
      } else {
        ctx = updateContext(ctx, {
          emptyDiffRetries: ctx.emptyDiffRetries + 1,
          verifyResults: [],
          reviewResult: null,
          reviewResults: {},
          diff: null,
          diffError: null,
        })
        logger.info(
          {
            runId: ctx.runId,
            emptyDiffRetries: ctx.emptyDiffRetries,
            maxRetries: loopConfig.maxEmptyDiffRetries,
          },
          emptyDiffDecision.reason,
        )
        try { metrics?.incLoopIterations(ctx.repo) } catch { /* best-effort */ }
        return { action: 'continue', ctx, stepIndex: coderIndex }
      }
    }
  }

  if (ctx.diff && ctx.emptyDiffRetries > 0) {
    ctx = updateContext(ctx, { emptyDiffRetries: 0 })
  }

  return { action: 'next', ctx }
}
