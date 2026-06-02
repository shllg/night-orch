import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import type { Reaction } from '../reactions/types.js'
import { recordHandoff } from '../state/handoffs.js'
import type { WorkerAdapter } from '../workers/types.js'
import { sanitizeUntrustedText } from '../workers/prompt/compiler.js'
import type { RunContext, ReviewerOutput } from './types.js'
import { updateContext } from './context.js'
import { executeWorkerStep, type StepDependencies } from './step-executor.js'
import { getPostPublishSteps, type ResolvedWorkflow, type WorkerStep } from './workflow.js'
import { nowUtcIso } from '../utils/time.js'
import type Database from 'better-sqlite3'

export interface PostPublishReviewDeps {
  config: Config
  workflow: ResolvedWorkflow
  adapters: Record<string, WorkerAdapter>
  envOverrides?: Record<string, string>
}

export interface RunPostPublishStepsInput extends PostPublishReviewDeps {
  ctx: RunContext
  db: Database.Database
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  prNumber: number
  prUrl: string
  botUser: string
}

export interface PostPublishResult {
  ctx: RunContext
  reactions: Reaction[]
}

export async function runPostPublishSteps(input: RunPostPublishStepsInput): Promise<PostPublishResult> {
  let ctx = withPublishedPrContext(input.ctx, input.prNumber, input.prUrl)
  const reactions: Reaction[] = []
  const stepDeps: StepDependencies = {
    adapters: input.adapters,
    config: input.config,
    envOverrides: input.envOverrides,
  }

  for (const step of getPostPublishSteps(input.workflow)) {
    const result = await executeWorkerStep(ctx, step, stepDeps)
    ctx = result.ctx

    if (step.role === 'reviewer') {
      const review = ctx.reviewResults?.[step.reviewerKey ?? step.id] ?? ctx.reviewResult
      if (review) {
        recordExternalReviewHandoff(input.db, ctx, step, review, result.tokenUsage)
      }
      if (review && shouldCommentOnIssue(step)) {
        await upsertExternalReviewComment({
          forge: input.forge,
          issueRepo: input.issueRepo,
          issueNumber: input.issueNumber,
          botUser: input.botUser,
          runId: ctx.runId,
          step,
          review,
        })
      }
      if (review && shouldQueueContinue(step, review)) {
        reactions.push(buildExternalReviewReaction({
          ctx,
          step,
          review,
          prNumber: input.prNumber,
          issueNumber: input.issueNumber,
        }))
      }
    }
  }

  return { ctx, reactions }
}

function withPublishedPrContext(ctx: RunContext, prNumber: number, prUrl: string): RunContext {
  return updateContext(ctx, {
    prReviewFeedback: {
      type: 'post_publish',
      summary: `PR #${prNumber} is open`,
      context: `PR number: #${prNumber}\nPR URL: ${prUrl}`,
    },
  })
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
}): Reaction {
  return {
    type: 'external_review',
    repo: input.ctx.repo,
    prNumber: input.prNumber,
    issueNumber: input.issueNumber,
    summary: `External review ${input.step.id}: ${input.review.verdict}`,
    context: formatExternalReviewFeedback(input.ctx, input.step, input.review),
    detectedAt: nowUtcIso(),
  }
}

function recordExternalReviewHandoff(
  db: Database.Database,
  ctx: RunContext,
  step: WorkerStep,
  review: ReviewerOutput,
  tokenUsage: Parameters<typeof recordHandoff>[1]['tokenUsage'],
): void {
  const count = review.findings.length
  recordHandoff(db, {
    runId: ctx.runId,
    attemptId: ctx.runId,
    stepId: step.id,
    fromRole: 'reviewer',
    toRole: shouldQueueContinue(step, review) ? 'coder' : 'system',
    kind: 'external-review-findings',
    summary: `${review.verdict}: ${count} ${count === 1 ? 'finding' : 'findings'}`,
    contentMd: formatExternalReviewHandoff(step, review),
    contentJson: review,
    ...(tokenUsage ? { tokenUsage } : {}),
  })
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

function formatExternalReviewHandoff(step: WorkerStep, review: ReviewerOutput): string {
  const lines = [
    `## External Review: ${step.id}`,
    '',
    `Verdict: ${review.verdict}`,
    '',
    sanitizeUntrustedText(review.summary),
  ]

  if (review.findings.length > 0) {
    lines.push('', 'Findings:')
    for (const finding of review.findings) {
      lines.push(`- [${finding.severity}] ${sanitizeUntrustedText(finding.message)}`)
      if (finding.suggestedFix) {
        lines.push(`  Suggested fix: ${sanitizeUntrustedText(finding.suggestedFix)}`)
      }
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
