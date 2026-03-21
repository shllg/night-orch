import type { RunContext } from '../loop/types.js'
import type { NotificationEvent, NotificationPayload } from './types.js'

export function buildPayload(
  ctx: RunContext,
  event: NotificationEvent,
  extra: {
    prUrl?: string | null
    prNumber?: number | null
    blockingReason?: string | null
  } = {},
): NotificationPayload {
  return {
    event,
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    issueTitle: ctx.issue.title,
    state: ctx.currentPhase,
    prUrl: extra.prUrl ?? null,
    prNumber: extra.prNumber ?? null,
    summary: buildSummary(ctx, event),
    blockingReason: extra.blockingReason ?? null,
    reviewSummary: ctx.reviewResult ? `${ctx.reviewResult.verdict}: ${ctx.reviewResult.summary}` : null,
    iterationCount: ctx.iteration,
    timestamp: new Date().toISOString(),
  }
}

function buildSummary(ctx: RunContext, event: NotificationEvent): string {
  switch (event) {
    case 'run_started':
      return `Started processing issue #${ctx.issueNumber}: ${ctx.issue.title}`
    case 'pr_ready':
      return ctx.codeResult?.summary ?? `Changes ready for review on #${ctx.issueNumber}`
    case 'pr_updated':
      return `PR updated after iteration ${ctx.iteration}`
    case 'blocked':
      return `Issue #${ctx.issueNumber} blocked after ${ctx.iteration} iterations`
    case 'error':
      return `Error processing issue #${ctx.issueNumber}`
    case 'retry_exhausted':
      return `Retries exhausted for issue #${ctx.issueNumber} after ${ctx.iteration} iterations`
    default:
      return `Notification for issue #${ctx.issueNumber}`
  }
}
