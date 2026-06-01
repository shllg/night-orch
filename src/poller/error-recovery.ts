import type { Config } from '../config/schema.js'
import type { ForgeAdapter, ForgeIssue } from '../forge/types.js'
import type { NotificationDispatcher } from '../notify/dispatcher.js'
import type { RunManager } from '../state/runs.js'
import { isTransientWorkerError, isWorkerError } from '../workers/errors.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'
import { postErrorStatusComment, sanitizeErrorForComment, toErrorMessage } from '../runner/comment-formatting.js'
import { makePayload } from '../notify/payload.js'

/**
 * R6: infra error recovery for the poller's per-issue dispatch loop.
 *
 * Before R6, this logic was a ~90-line inline block inside the
 * `pollOnce` try/catch at `src/runner/poller.ts:736-823`. Extracting
 * it into a dedicated module gives the R2 `WorkerTransientError` path
 * a named home (transient errors bubble to this recovery step to be
 * reclassified for auto-retry or marked terminal) and makes the
 * classifier testable in isolation.
 *
 * The module exposes two layers:
 *  - `classifyInfraError()` — pure classifier that takes the error +
 *    run retry state and returns a `RecoveryPlan` describing what
 *    should happen next (`auto_retry` with attempt count or
 *    `mark_error` with the sanitized message).
 *  - `applyRecoveryPlan()` — async executor that performs the side
 *    effects (label transitions, status comments, notifier dispatch)
 *    implied by the plan. Separated from the classifier so tests
 *    can verify the decision logic without mocking the forge.
 *
 * Non-`WorkerTransientError` failures should never reach here —
 * R2's engine catch converts typed worker errors to a `blocked`
 * RunState inside `executeLoop`. This recovery path is specifically
 * for *infra* errors (git failures, forge API hiccups, worktree
 * setup issues, unexpected exceptions) that the engine doesn't
 * catch.
 */

export interface InfraErrorContext {
  runId: string
  currentRetryCount: number
  err: unknown
  maxAutoRetries: number
}

export type RecoveryPlan =
  | {
      kind: 'auto_retry'
      attemptCount: number
      errorMessage: string
    }
  | {
      kind: 'mark_error'
      attemptCount: number
      errorMessage: string
    }
  | {
      kind: 'abort_no_auto_retry'
      errorMessage: string
    }

/**
 * Decide what to do when the poller catches an error during per-issue
 * dispatch. Pure function — no side effects, no I/O.
 *
 * Rules:
 *  1. If the error is a typed `WorkerError` but NOT a
 *     `WorkerTransientError`, we shouldn't have ended up here (the
 *     engine catches non-transient worker errors and turns them
 *     into typed blocked states before they bubble out). Treat as
 *     `abort_no_auto_retry` and let the caller log loudly — that
 *     indicates a bug in the engine's catch boundary.
 *  2. Otherwise, bump the retry counter. If it's still under
 *     `maxAutoRetries`, return `auto_retry` (the caller will
 *     transition labels running→queued and the next poll will pick
 *     the run back up).
 *  3. If the retry budget is exhausted, return `mark_error` (the
 *     caller transitions labels running→error and dispatches a
 *     `retry_exhausted` notification).
 */
export function classifyInfraError(ctx: InfraErrorContext): RecoveryPlan {
  const errorMessage = toErrorMessage(ctx.err)

  // Guard: this recovery path is for infra errors. Typed non-transient
  // worker errors (auth, timeout, token-capture, parse, rate-limit)
  // should be caught by the engine's R2 boundary and converted into a
  // blocked RunState inside executeLoop. If we see one here it means
  // the engine's catch missed it — surface loudly rather than retrying.
  if (isWorkerError(ctx.err) && !isTransientWorkerError(ctx.err)) {
    return { kind: 'abort_no_auto_retry', errorMessage }
  }

  const attemptCount = ctx.currentRetryCount + 1
  if (attemptCount > ctx.maxAutoRetries) {
    return { kind: 'mark_error', attemptCount, errorMessage }
  }
  return { kind: 'auto_retry', attemptCount, errorMessage }
}

export interface ApplyRecoveryPlanDeps {
  plan: RecoveryPlan
  config: Config
  repoConfig: Config['repos'][number]
  issueRepo: string
  issue: ForgeIssue
  runId: string
  botUser: string
  forge: ForgeAdapter
  runManager: RunManager
  notifier: NotificationDispatcher
}

/**
 * Apply the side effects implied by a `RecoveryPlan`: update the run
 * row, transition forge labels, post a status comment, dispatch a
 * notification. All side effects are best-effort — label/comment/
 * notification failures are logged but never rethrown, matching the
 * pre-R6 inline behavior.
 *
 * The caller is still responsible for incrementing the poller's
 * local error counter and releasing the lease in the `finally` block;
 * this module only performs the recovery-specific work.
 */
export async function applyRecoveryPlan(deps: ApplyRecoveryPlanDeps): Promise<void> {
  const { plan, config, repoConfig, issueRepo, issue, runId, botUser, forge, runManager, notifier } = deps

  // Always mark the run row as errored first — even on auto_retry we
  // want the row to carry the last-error string until the next poll
  // cycle picks it back up.
  runManager.updateLifecycle(runId, {
    status: 'error',
    lastError: plan.errorMessage,
    endedAt: nowUtcIso(),
  })

  if (plan.kind === 'abort_no_auto_retry') {
    logger.error(
      { repo: repoConfig.repo, issue: issue.number, runId, errorMessage: plan.errorMessage },
      'Non-transient worker error reached poller recovery — engine catch boundary may be broken',
    )
    return
  }

  if (plan.kind === 'auto_retry') {
    runManager.incrementRetryCount(runId)
    logger.info(
      {
        repo: repoConfig.repo,
        issue: issue.number,
        attempt: plan.attemptCount,
        maxRetries: config.loop.maxAutoRetries,
      },
      'Infra error — auto-retrying (transitioning back to ready)',
    )

    try {
      const latestIssue = await forge.getIssue(issueRepo, issue.number)
      await transitionLabels(
        forge,
        issueRepo,
        issue.number,
        latestIssue.labels,
        'running',
        'queued',
        buildLabelConfig(repoConfig, latestIssue.labels),
      )
    } catch (labelErr) {
      logger.warn(
        { repo: repoConfig.repo, issue: issue.number, err: labelErr },
        'Failed to transition labels for auto-retry',
      )
    }

    await postErrorStatusComment({
      forge,
      issueRepo,
      issueNumber: issue.number,
      botUser,
      error: `Attempt ${plan.attemptCount} failed. Last error: ${plan.errorMessage}`,
      retryCount: plan.attemptCount,
      maxRetries: config.loop.maxAutoRetries,
      nextStep: 'Automatic retry queued. night-orch will retry this issue on the next poll cycle.',
      warnMessage: 'Failed to post auto-retry status comment',
    })
    return
  }

  // plan.kind === 'mark_error'
  logger.warn(
    {
      repo: repoConfig.repo,
      issue: issue.number,
      currentRetries: plan.attemptCount - 1,
      maxRetries: config.loop.maxAutoRetries,
    },
    'Auto-retry limit reached — marking as error',
  )

  try {
    const latestIssue = await forge.getIssue(issueRepo, issue.number)
    await transitionLabels(
      forge,
      issueRepo,
      issue.number,
      latestIssue.labels,
      'running',
      'error',
      buildLabelConfig(repoConfig, latestIssue.labels),
    )
  } catch (labelErr) {
    logger.warn(
      { repo: repoConfig.repo, issue: issue.number, err: labelErr },
      'Failed to transition labels after retry exhaustion',
    )
  }

  await postErrorStatusComment({
    forge,
    issueRepo,
    issueNumber: issue.number,
    botUser,
    error: `Failed after ${plan.attemptCount} attempts. Last error: ${plan.errorMessage}`,
    retryCount: plan.attemptCount,
    maxRetries: config.loop.maxAutoRetries,
    nextStep: 'Inspect the failure, then use /orch retry or /orch continue.',
    warnMessage: 'Failed to post retry-exhausted status comment',
  })

  const sanitizedErrorForSummary = sanitizeErrorForComment(plan.errorMessage)
  try {
    await notifier.dispatch(
      makePayload('retry_exhausted', repoConfig.repo, issue, {
        summary: `Failed after ${plan.attemptCount} attempts: ${sanitizedErrorForSummary}`,
      }),
    )
  } catch (notifyErr) {
    logger.warn(
      { repo: repoConfig.repo, issue: issue.number, err: notifyErr },
      'Failed to send retry exhaustion notification',
    )
  }
}
