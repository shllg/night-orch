import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { MetricsService } from '../metrics/service.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import type { ExternalReviewReaction } from '../reactions/types.js'
import type { WorkerAdapter } from '../workers/types.js'
import { sanitizeUntrustedText } from '../workers/prompt/compiler.js'
import type { RunContext, ReviewerOutput } from './types.js'
import { updateContext } from './context.js'
import type { ResolvedWorkflow, WorkerStep } from './workflow.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'
import type { AgentEvent } from '../events/types.js'

export interface PostPublishReviewDeps {
  config: Config
  workflow: ResolvedWorkflow
  adapters: Record<string, WorkerAdapter>
  envOverrides?: Record<string, string>
  metrics?: MetricsService
  onAgentEvent?: (event: AgentEvent) => void
  leaseHeartbeat?: () => boolean
}

export interface HandlePostPublishReviewInput {
  ctx: RunContext
  step: WorkerStep
  review: ReviewerOutput
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  prNumber: number
  botUser: string
  metrics?: MetricsService
}

export function withPublishedPrContext(ctx: RunContext, prNumber: number, prUrl: string): RunContext {
  return updateContext(ctx, {
    prReviewFeedback: {
      type: 'post_publish',
      summary: `PR #${prNumber} is open`,
      context: `PR number: #${prNumber}\nPR URL: ${prUrl}`,
    },
  })
}

export async function handlePostPublishReview(input: HandlePostPublishReviewInput): Promise<{
  reaction?: ExternalReviewReaction | null
  result: 'ok' | 'comment_only' | 'continue_queued'
}> {
  try { input.metrics?.incExternalReviewFindings(input.step.id, input.review.verdict) } catch { /* best-effort */ }

  if (shouldCommentOnIssue(input.step)) {
    try {
      await upsertExternalReviewComment({
        forge: input.forge,
        issueRepo: input.issueRepo,
        issueNumber: input.issueNumber,
        botUser: input.botUser,
        runId: input.ctx.runId,
        step: input.step,
        review: input.review,
      })
    } catch (err) {
      logger.warn(
        { repo: input.issueRepo, issueNumber: input.issueNumber, stepId: input.step.id, err },
        'Failed to upsert post-publish external review comment',
      )
    }
  }

  if (input.review.verdict === 'APPROVED') {
    return { result: 'ok' }
  }

  if (!shouldQueueContinue(input.step, input.review)) {
    return { result: 'comment_only' }
  }

  return {
    result: 'continue_queued',
    reaction: buildExternalReviewReaction({
      ctx: input.ctx,
      step: input.step,
      review: input.review,
      prNumber: input.prNumber,
      issueNumber: input.issueNumber,
    }),
  }
}

function shouldCommentOnIssue(step: WorkerStep): boolean {
  return step.commentOnIssue ?? true
}

function shouldQueueContinue(step: WorkerStep, review: ReviewerOutput): boolean {
  return review.verdict !== 'APPROVED' && (step.onChangesRequired ?? 'continue') === 'continue'
}

function buildExternalReviewReaction(input: {
  ctx: RunContext
  step: WorkerStep
  review: ReviewerOutput
  prNumber: number
  issueNumber: number
}): ExternalReviewReaction {
  return {
    type: 'external_review',
    repo: input.ctx.repo,
    prNumber: input.prNumber,
    issueNumber: input.issueNumber,
    summary: `External review ${input.step.id}: ${input.review.verdict}`,
    context: formatExternalReviewFeedback(input.ctx, input.step, input.review),
    detectedAt: nowUtcIso(),
    stepId: input.step.id,
    verdict: input.review.verdict,
    findings: input.review.findings,
  }
}

async function upsertExternalReviewComment(input: {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  botUser: string
  runId: string
  step: WorkerStep
  review: ReviewerOutput
}): Promise<void> {
  const marker = markerTag(`${input.step.id}-${input.runId}`)
  const body = formatExternalReviewComment(input.step, input.review)
  if (input.botUser) {
    await upsertBotComment(input.forge, input.issueRepo, input.issueNumber, marker, body, input.botUser)
    return
  }
  await input.forge.commentOnIssue(input.issueRepo, input.issueNumber, `${marker}\n${body}`)
}

function formatExternalReviewComment(step: WorkerStep, review: ReviewerOutput): string {
  const prefix = step.commentPrefix ?? '[night-orch]'
  const lines = [
    `${prefix} External review: ${review.verdict}`,
    '',
    review.summary,
  ]

  if (review.findings.length > 0) {
    lines.push('', 'Findings:')
    for (const finding of review.findings) {
      lines.push(`- [${finding.severity}] ${finding.message}`)
      if (finding.suggestedFix) lines.push(`  Suggested fix: ${finding.suggestedFix}`)
    }
  }

  return lines.join('\n')
}

function formatExternalReviewFeedback(ctx: RunContext, step: WorkerStep, review: ReviewerOutput): string {
  const lines = [
    '## External Review Findings',
    '',
    `${step.id}: ${review.verdict}`,
    sanitizeUntrustedText(review.summary),
  ]

  if (ctx.reviewFindings.length > 0) {
    lines.push('', '## Review Findings to Address')
    for (const finding of ctx.reviewFindings) {
      const sourceStepId = 'sourceStepId' in finding ? finding.sourceStepId : 'review'
      const message = sanitizeUntrustedText(finding.message)
      const suggestedFix = finding.suggestedFix ? sanitizeUntrustedText(finding.suggestedFix) : null
      lines.push(`- [${sourceStepId}][${finding.severity}] ${message}`)
      if (suggestedFix) lines.push(`  Suggested fix: ${suggestedFix}`)
    }
  }

  return lines.join('\n')
}
