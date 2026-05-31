import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { MetricsService } from '../metrics/service.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { RunManager } from '../state/runs.js'
import { publishPR } from '../publishing/publisher.js'
import { MergeConflictError } from '../publishing/push.js'
import { buildConflictSnapshot } from '../ops/conflict-snapshot.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'
import type { NotificationDispatcher } from '../notify/dispatcher.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'
import type { RunContext } from '../loop/types.js'
import { blocked, blockedReasonFromLegacy } from '../loop/state.js'
import {
  STATUS_MARKER,
  buildBlockReason,
  formatBlockComment,
  makePayload,
  postStatusComment,
  postErrorStatusComment,
  toErrorMessage,
  sanitizeErrorForComment,
} from './helpers.js'

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
  } = params

  if (finalCtx.terminalStatus === 'publish') {
    try {
      const publishResult = await publishPR(finalCtx, forge, db)
      runManager.updateAndClearCostBudgetOverride(runId, {
        status: 'review_ready',
        iterationCount: finalCtx.iteration,
        prNumber: publishResult.prNumber,
        prTitle: publishResult.prTitle,
        lastError: null,
        endedAt: nowUtcIso(),
      })
      const latestIssue = await forge.getIssue(issueRepo, issueNumber)
      await transitionLabels(
        forge,
        issueRepo,
        issueNumber,
        latestIssue.labels,
        'running',
        'review_ready',
        buildLabelConfig(repoConfig, latestIssue.labels),
      )
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
        const latestIssue = await forge.getIssue(issueRepo, issueNumber)
        await transitionLabels(
          forge,
          issueRepo,
          issueNumber,
          latestIssue.labels,
          'running',
          'blocked',
          buildLabelConfig(repoConfig, latestIssue.labels),
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
      const latestIssue = await forge.getIssue(issueRepo, issueNumber)
      if (currentRetries < maxAutoRetries) {
        runManager.incrementRetryCount(runId)
        await transitionLabels(
          forge,
          issueRepo,
          issueNumber,
          latestIssue.labels,
          'running',
          'queued',
          buildLabelConfig(repoConfig, latestIssue.labels),
        )
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
        await transitionLabels(
          forge,
          issueRepo,
          issueNumber,
          latestIssue.labels,
          'running',
          'error',
          buildLabelConfig(repoConfig, latestIssue.labels),
        )
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
    const latestIssue = await forge.getIssue(issueRepo, issueNumber)
    // Bridge: RunContext still carries the legacy `BlockReason` string
    // (R1d will retype it). Lift it through the documented round-trip
    // helper so labels/transitions only ever sees the typed shape.
    const typedBlockReason = finalCtx.blockReason
      ? blockedReasonFromLegacy(finalCtx.blockReason)
      : undefined
    await transitionLabels(
      forge,
      issueRepo,
      issueNumber,
      latestIssue.labels,
      'running',
      'blocked',
      buildLabelConfig(repoConfig, latestIssue.labels),
      typedBlockReason,
    )

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
      reviewSummary: finalCtx.reviewResult?.summary ?? null,
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
  const latestIssue = await forge.getIssue(issueRepo, issueNumber)
  if (currentRetriesUnexpected < maxAutoRetries) {
    runManager.incrementRetryCount(runId)
    await transitionLabels(
      forge,
      issueRepo,
      issueNumber,
      latestIssue.labels,
      'running',
      'queued',
      buildLabelConfig(repoConfig, latestIssue.labels),
    )
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
    await transitionLabels(
      forge,
      issueRepo,
      issueNumber,
      latestIssue.labels,
      'running',
      'error',
      buildLabelConfig(repoConfig, latestIssue.labels),
    )
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
