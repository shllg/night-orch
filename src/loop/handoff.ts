import type { RecordHandoffInput } from '../state/handoffs.js'
import type { ReviewerOutput, TokenUsage } from '../workers/types.js'
import type { RunContext } from './types.js'
import {
  renderCodeHandoff,
  renderExternalReviewHandoff,
  renderPlanHandoff,
  renderReviewHandoff,
  renderVerifyHandoff,
} from './handoff-render.js'
import { reviewerKeyForStep, runWhenForStep, type WorkerStep, type WorkflowStep } from './workflow.js'

export interface BuildStepHandoffInput {
  readonly ctx: RunContext
  readonly step: WorkflowStep
  readonly steps: readonly WorkflowStep[]
  readonly stepIndex: number
  readonly tokenUsage?: TokenUsage
}

export function buildStepHandoff(input: BuildStepHandoffInput): RecordHandoffInput | null {
  const { ctx, step, steps, stepIndex, tokenUsage } = input

  if (step.type === 'worker') {
    if (step.role === 'planner') {
      if (!ctx.plan) return null
      const rendered = renderPlanHandoff(ctx.plan)
      return withTokenUsage({
        runId: ctx.runId,
        attemptId: ctx.runId,
        stepId: step.id,
        fromRole: 'planner',
        toRole: nextHandoffRole(steps, stepIndex),
        kind: 'plan',
        summary: rendered.summary,
        contentMd: rendered.contentMd,
        contentJson: rendered.contentJson,
      }, tokenUsage)
    }

    if (step.role === 'coder') {
      if (!ctx.codeResult) return null
      const rendered = renderCodeHandoff(ctx.codeResult)
      return withTokenUsage({
        runId: ctx.runId,
        attemptId: ctx.runId,
        stepId: step.id,
        fromRole: 'coder',
        toRole: nextHandoffRole(steps, stepIndex),
        kind: 'code-summary',
        summary: rendered.summary,
        contentMd: rendered.contentMd,
        contentJson: rendered.contentJson,
      }, tokenUsage)
    }

    if (step.role === 'reviewer') {
      const key = reviewerKeyForStep(step)
      const review = ctx.reviewResults[key] ?? null
      if (!review) return null
      if (runWhenForStep(step) === 'post-publish') {
        const rendered = renderExternalReviewHandoff(review, step.id)
        return withTokenUsage({
          runId: ctx.runId,
          attemptId: ctx.runId,
          stepId: step.id,
          fromRole: 'reviewer',
          toRole: shouldQueuePostPublishContinue(step, review) ? 'coder' : 'system',
          kind: 'external-review-findings',
          summary: rendered.summary,
          contentMd: rendered.contentMd,
          contentJson: rendered.contentJson,
        }, tokenUsage)
      }
      const rendered = renderReviewHandoff(review, step.id)
      return withTokenUsage({
        runId: ctx.runId,
        attemptId: ctx.runId,
        stepId: step.id,
        fromRole: 'reviewer',
        toRole: review.verdict === 'CHANGES_REQUIRED' ? 'coder' : nextHandoffRole(steps, stepIndex),
        kind: 'review-findings',
        summary: rendered.summary,
        contentMd: rendered.contentMd,
        contentJson: rendered.contentJson,
      }, tokenUsage)
    }

    return null
  }

  if (step.type === 'verify') {
    if (ctx.verifyResults.length === 0) return null
    const rendered = renderVerifyHandoff(ctx.verifyResults)
    return {
      runId: ctx.runId,
      attemptId: ctx.runId,
      stepId: step.id,
      fromRole: 'system',
      toRole: nextHandoffRole(steps, stepIndex),
      kind: 'verify-summary',
      summary: rendered.summary,
      contentMd: rendered.contentMd,
      contentJson: rendered.contentJson,
    }
  }

  return null
}

function nextHandoffRole(steps: readonly WorkflowStep[], stepIndex: number): string {
  const next = steps[stepIndex + 1]
  return next?.type === 'worker' ? next.role : 'system'
}

function withTokenUsage(input: RecordHandoffInput, tokenUsage: TokenUsage | undefined): RecordHandoffInput {
  return tokenUsage ? { ...input, tokenUsage } : input
}

function shouldQueuePostPublishContinue(step: WorkerStep, review: ReviewerOutput): boolean {
  return review.verdict !== 'APPROVED' && (step.onChangesRequired ?? 'continue') === 'continue'
}
