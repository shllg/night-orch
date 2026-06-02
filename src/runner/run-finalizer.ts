import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { MetricsService } from '../metrics/service.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { RunManager } from '../state/runs.js'
import { publishPR } from '../publishing/publisher.js'
import { MergeConflictError } from '../publishing/push.js'
import { handleReaction } from '../reactions/handler.js'
import type { ReactionEnvelope } from '../reactions/types.js'
import { buildConflictSnapshot } from '../ops/conflict-snapshot.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'
import { formatReviewSummary } from '../loop/review-results.js'
import type { NotificationDispatcher } from '../notify/dispatcher.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'
import type { RunContext } from '../loop/types.js'
import { executePostPublishSteps } from '../loop/engine.js'
import { handlePostPublishReview, type PostPublishReviewDeps } from '../loop/post-publish.js'
import { blocked, blockedReasonFromLegacy } from '../loop/state.js'
import {
  STATUS_MARKER,
  buildBlockReason,
  formatBlockComment,
  postStatusComment,
  postErrorStatusComment,
  toErrorMessage,
  sanitizeErrorForComment,
} from './comment-formatting.js'
import { makePayload } from '../notify/payload.js'

export interface FinalizeRunOutcomeParams {
  finalCtx: RunContext
  runId: string
  issue: {
    number: number
    title: string
    url?: string
  }
  runDurationSec: number
  repo: string
  repoConfig: Config['repos'][0]
  issueRepo: string
  issueNumber: number
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  notifier: NotificationDispatcher
  metrics?: MetricsService
  maxAutoRetries: number
  botUser: string
  postPublish?: PostPublishReviewDeps
}

export async function finalizeRunOutcome(params: FinalizeRunOutcomeParams): Promise<'processed' | 'error'> {
  const {
    finalCtx,
    runId,
    issue,
    runDurationSec,
    repo,
    repoConfig,
    issueRepo,
    issueNumber,
    db,
    forge,
    runManager,
    notifier,
    metrics,
    maxAutoRetries,
    botUser,
    postPublish,
  } = params

  const getLatestIssue = (): ReturnType<ForgeAdapter['getIssue']> => {
    return forge.getIssue(issueRepo, issueNumber)
  }
  const transitionIssueLabels = async (
    from: Parameters<typeof transitionLabels>[4],
    to: Parameters<typeof transitionLabels>[5],
    blockReason?: Parameters<typeof transitionLabels>[7],
  ): Promise<void> => {
    const latestIssue = await getLatestIssue()
    await transitionLabels(
      forge,
      issueRepo,
      issueNumber,
      latestIssue.labels,
      from,
      to,
      buildLabelConfig(repoConfig, latestIssue.labels),
      blockReason,
    )
  }
  const transitionFromRunning = async (
    to: Parameters<typeof transitionLabels>[5],
    blockReason?: Parameters<typeof transitionLabels>[7],
  ): Promise<void> => {
    await transitionIssueLabels('running', to, blockReason)
  }

  if (finalCtx.terminalStatus === 'publish') {
    try {
      const publishResult = await publishPR(finalCtx, forge, db)
      runManager.updatePullRequest(runId, {
        prNumber: publishResult.prNumber,
        prTitle: publishResult.prTitle,
      })
      let readyCtx = finalCtx
      let postPublishReactions: ReactionEnvelope[] = []
      if (postPublish) {
        const postPublishResult = await executePostPublishSteps({
          ...postPublish,
          ctx: finalCtx,
          db,
          prNumber: publishResult.prNumber,
          prUrl: publishResult.prUrl,
          onPostPublishReview: async ({ ctx, step, review }) => handlePostPublishReview({
            ctx,
            step,
            review,
            forge,
            issueRepo,
            issueNumber,
            prNumber: publishResult.prNumber,
            botUser,
            metrics,
          }),
        })
        if (postPublishResult.ctx.terminalStatus === 'blocked') {
          const blockedCtx = postPublishResult.ctx
          const blockReason = buildBlockReason(blockedCtx)
          runManager.updateAndClearCostBudgetOverride(runId, {
            status: 'blocked',
            iterationCount: blockedCtx.iteration,
            lastError: blockReason,
            blockReason: blockedCtx.blockReason ?? null,
            endedAt: nowUtcIso(),
          })
          const typedBlockReason = blockedCtx.blockReason
            ? blockedReasonFromLegacy(blockedCtx.blockReason)
            : undefined
          await transitionFromRunning('blocked', typedBlockReason)
          await postStatusComment({
            forge,
            issueRepo,
            issueNumber,
            botUser,
            body: formatStatusComment({
              blockReason,
              iteration: blockedCtx.iteration,
              maxIterations: blockedCtx.adjustedLimits.maxReviewIterations,
              cost: blockedCtx.estimatedCostUsd,
            }),
            warnMessage: 'Failed to post post-publish block reason comment',
          })
          const notifyResult = await notifier.dispatch(makePayload('blocked', repo, issue, {
            summary: blockReason,
            blockingReason: blockReason,
            reviewSummary: formatReviewSummary(blockedCtx.reviewResults),
          }))
          try {
            metrics?.incRunsTotal('blocked')
            metrics?.observeRunDuration(runDurationSec)
            for (const s of notifyResult.sent) {
              metrics?.incNotifications(s.channel, s.success ? 'sent' : 'failed')
            }
          } catch { /* best-effort */ }
          return 'processed'
        }
        readyCtx = postPublishResult.ctx
        postPublishReactions = postPublishResult.reactions
      }
      runManager.updateAndClearCostBudgetOverride(runId, {
        status: 'review_ready',
        iterationCount: readyCtx.iteration,
        prNumber: publishResult.prNumber,
        prTitle: publishResult.prTitle,
        lastError: null,
        endedAt: nowUtcIso(),
      })
      await transitionFromRunning('review_ready')
      for (const reaction of postPublishReactions) {
        await handleReaction(reaction, {
          db,
          forge,
          runManager,
          repoConfig,
          maxAttemptChainLength: postPublish?.config.loop.maxAttemptChainLength,
        })
      }
      const notificationEvent = publishResult.created ? 'pr_ready' : 'pr_updated'
      const notifyResult = await notifier.dispatch(makePayload(notificationEvent, repo, issue, {
        prUrl: publishResult.prUrl,
        prNumber: publishResult.prNumber,
        summary: publishResult.created
          ? `PR ready: ${publishResult.prUrl}`
          : `PR updated: ${publishResult.prUrl}`,
      }))
      try {
        metrics?.incRunsTotal('completed')
        metrics?.observeRunDuration(runDurationSec)
        metrics?.incPROperations(publishResult.created ? 'created' : 'updated')
        for (const s of notifyResult.sent) {
          metrics?.incNotifications(s.channel, s.success ? 'sent' : 'failed')
        }
      } catch { /* best-effort */ }
      return 'processed'
    } catch (err) {
      logger.error({ err }, 'Failed to publish PR')
      const errorMessage = toErrorMessage(err)

      if (err instanceof MergeConflictError) {
        const snapshot = buildConflictSnapshot({
          source: 'publish_push',
          kind: finalCtx.repoConfig.updateStrategy === 'rebase' ? 'rebase' : 'merge',
          strategy: finalCtx.repoConfig.updateStrategy,
          summary: err.message,
          branchName: finalCtx.branchName,
          baseBranch: finalCtx.repoConfig.baseBranch,
        })
        runManager.updateAndClearCostBudgetOverride(runId, {
          status: 'blocked',
          iterationCount: finalCtx.iteration,
          blockReason: 'merge_conflict',
          manualState: 'awaiting_rebase_resolution',
          controlPayload: {
            issueRepo,
            preserveBranchState: true,
            conflictSummary: err.message,
            conflictFiles: [],
            conflictExcerpts: [],
            conflictSnapshot: snapshot,
            requestedAt: nowUtcIso(),
          },
          phaseData: {
            issueRepo,
            reactionType: 'publish_conflict',
            reactionSummary: 'Publish failed due to branch synchronization conflicts',
            reactionContext: err.message,
            reactionConflictSnapshot: snapshot,
          },
          lastError: err.message,
          endedAt: nowUtcIso(),
        })
        await transitionFromRunning(
          'blocked',
          blocked({
            type: 'mergeConflict',
            files: [],
            summary: err.message,
          }).reason,
        )
        await postStatusComment({
          forge,
          issueRepo,
          issueNumber,
          botUser,
          body: formatStatusComment({
            blockReason: 'Publish failed due to merge conflicts while pushing branch updates.',
            nextStep: 'Use /orch retry to reset the branch and re-implement, or /orch continue to keep the existing branch and resolve the conflicts.',
          }),
          warnMessage: 'Failed to post publish merge-conflict status comment',
        })
        try {
          metrics?.incRunsTotal('blocked')
          metrics?.observeRunDuration(runDurationSec)
        } catch { /* best-effort */ }
        return 'error'
      }

      const currentRun = runManager.getById(runId)
      const currentRetries = currentRun?.retryCount ?? 0
      runManager.updateAndClearCostBudgetOverride(runId, { status: 'error', iterationCount: finalCtx.iteration, lastError: errorMessage, endedAt: nowUtcIso() })
      if (currentRetries < maxAutoRetries) {
        runManager.incrementRetryCount(runId)
        await transitionFromRunning('queued')
        logger.info({ repo, issueNumber, attempt: currentRetries + 1, maxAutoRetries }, 'Publish failed — auto-retrying')
        await postErrorStatusComment({
          forge,
          issueRepo,
          issueNumber,
          botUser,
          error: `Publish failed. Last error: ${errorMessage}`,
          retryCount: currentRetries + 1,
          maxRetries: maxAutoRetries,
          nextStep: 'Automatic retry queued. night-orch will retry this issue on the next poll cycle.',
          warnMessage: 'Failed to post publish auto-retry status comment',
        })
      } else {
        await transitionFromRunning('error')
        const attemptCount = currentRetries + 1
        await postErrorStatusComment({
          forge,
          issueRepo,
          issueNumber,
          botUser,
          error: `Failed after ${attemptCount} attempts. Last error: ${errorMessage}`,
          retryCount: attemptCount,
          maxRetries: maxAutoRetries,
          nextStep: 'Inspect the failure, then use /orch retry or /orch continue.',
          warnMessage: 'Failed to post publish retry-exhausted status comment',
        })
        const sanitizedErrorForSummary = sanitizeErrorForComment(errorMessage)
        try {
          await notifier.dispatch(makePayload('retry_exhausted', repo, issue, {
            summary: `Publish failed after ${attemptCount} attempts: ${sanitizedErrorForSummary}`,
          }))
        } catch (notifyErr) {
          logger.warn({ repo, issueNumber, err: notifyErr }, 'Failed to send publish retry exhaustion notification')
        }
      }
      try {
        metrics?.incRunsTotal('error')
        metrics?.observeRunDuration(runDurationSec)
      } catch { /* best-effort */ }
      return 'error'
    }
  }

  if (finalCtx.terminalStatus === 'blocked') {
    const blockReason = buildBlockReason(finalCtx)
    runManager.updateAndClearCostBudgetOverride(runId, {
      status: 'blocked',
      iterationCount: finalCtx.iteration,
      lastError: blockReason,
      blockReason: finalCtx.blockReason ?? null,
      endedAt: nowUtcIso(),
    })
    // Bridge: RunContext still carries the legacy `BlockReason` string
    // (R1d will retype it). Lift it through the documented round-trip
    // helper so labels/transitions only ever sees the typed shape.
    const typedBlockReason = finalCtx.blockReason
      ? blockedReasonFromLegacy(finalCtx.blockReason)
      : undefined
    await transitionFromRunning('blocked', typedBlockReason)

    try {
      const statusBody = formatStatusComment({
        blockReason,
        iteration: finalCtx.iteration,
        maxIterations: finalCtx.adjustedLimits.maxReviewIterations,
        cost: finalCtx.estimatedCostUsd,
      })
      if (botUser) {
        await upsertBotComment(forge, issueRepo, issueNumber, STATUS_MARKER, statusBody, botUser)
      } else {
        await forge.commentOnIssue(issueRepo, issueNumber, formatBlockComment(blockReason, finalCtx))
      }
    } catch (commentErr) {
      logger.warn({ repo, issueNumber, err: commentErr }, 'Failed to post block reason comment')
    }

    const notifyResult = await notifier.dispatch(makePayload('blocked', repo, issue, {
      summary: blockReason,
      blockingReason: blockReason,
      reviewSummary: formatReviewSummary(finalCtx.reviewResults),
    }))
    try {
      metrics?.incRunsTotal('blocked')
      metrics?.observeRunDuration(runDurationSec)
      for (const s of notifyResult.sent) {
        metrics?.incNotifications(s.channel, s.success ? 'sent' : 'failed')
      }
    } catch { /* best-effort */ }
    return 'processed'
  }

  const unexpectedError = `Loop ended in unexpected state: ${finalCtx.terminalStatus}/${finalCtx.currentPhase}`
  const currentRunForUnexpected = runManager.getById(runId)
  const currentRetriesUnexpected = currentRunForUnexpected?.retryCount ?? 0
  runManager.updateAndClearCostBudgetOverride(runId, { status: 'error', iterationCount: finalCtx.iteration, lastError: unexpectedError, endedAt: nowUtcIso() })
  if (currentRetriesUnexpected < maxAutoRetries) {
    runManager.incrementRetryCount(runId)
    await transitionFromRunning('queued')
    logger.info({ repo, issueNumber, attempt: currentRetriesUnexpected + 1, maxAutoRetries }, 'Unexpected state — auto-retrying')
    await postErrorStatusComment({
      forge,
      issueRepo,
      issueNumber,
      botUser,
      error: `Loop entered unexpected state: ${finalCtx.terminalStatus}/${finalCtx.currentPhase}`,
      retryCount: currentRetriesUnexpected + 1,
      maxRetries: maxAutoRetries,
      nextStep: 'Automatic retry queued. night-orch will retry this issue on the next poll cycle.',
      warnMessage: 'Failed to post unexpected-state auto-retry status comment',
    })
  } else {
    await transitionFromRunning('error')
    const attemptCount = currentRetriesUnexpected + 1
    await postErrorStatusComment({
      forge,
      issueRepo,
      issueNumber,
      botUser,
      error: `Failed after ${attemptCount} attempts. Last error: ${unexpectedError}`,
      retryCount: attemptCount,
      maxRetries: maxAutoRetries,
      nextStep: 'Inspect the failure, then use /orch retry or /orch continue.',
      warnMessage: 'Failed to post unexpected-state retry-exhausted status comment',
    })
  }
  try {
    metrics?.incRunsTotal('error')
    metrics?.observeRunDuration(runDurationSec)
  } catch { /* best-effort */ }
  return 'error'
}
