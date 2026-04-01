import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { MetricsService } from '../metrics/service.js'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager } from '../state/runs.js'
import { discoverEligibleIssues } from '../discovery/discover.js'
import { resolveRoles, type ResolvedRoles } from '../discovery/roles.js'
import { adjustLimitsForTriage } from '../discovery/triage.js'
import { getOrPinSlug, buildWorktreePath } from '../git/slug.js'
import { createWorktreeManager } from '../git/worktree.js'
import {
  resolveEnvironmentMode,
  setupEnvironment,
  teardownEnvironment,
  type EnvSetupResult,
} from '../environment/manager.js'
import { createWorkerAdapter } from '../workers/factory.js'
import { executeLoop } from '../loop/engine.js'
import { resolveWorkflow } from '../loop/workflow.js'
import { publishPR } from '../publishing/publisher.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { NotificationDispatcher } from '../notify/dispatcher.js'
import { createChannels } from '../notify/factory.js'
import { CostTracker } from '../loop/cost.js'
import { branchName } from '../utils/ids.js'
import { logger } from '../utils/logger.js'
import type { RunContext } from '../loop/types.js'
import type { NotificationPayload } from '../notify/types.js'
import { postPlanSummaryComment } from '../loop/plan-summary-comment.js'
import { executeRebase } from '../ops/rebase-and-check.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'
import { scanForReactions } from '../reactions/scanner.js'
import { handleReaction } from '../reactions/handler.js'
import type { ReactionCursor } from '../reactions/types.js'
import { processMergeQueue } from '../merge-queue/runner.js'
import { decomposeIssue, shouldAttemptDecompose } from '../discovery/decomposer.js'
import { executeParallelSubtasks } from '../loop/parallel.js'
import { buildWorkerEnv } from '../workers/env.js'
import { isPlanningIssue } from '../planning/mode.js'
import {
  AgentObservability,
  setActiveAgentObservability,
  clearActiveAgentObservability,
} from '../events/observability.js'
import type { AgentEvent } from '../events/types.js'

const STATUS_MARKER = markerTag('status')

export interface PollResult {
  processed: number
  errors: number
}

export interface PollTargetIssue {
  repo: string
  issueNumber: number
}

/**
 * Process one poll cycle: discover eligible issues, claim and process.
 * Serial processing — one issue at a time.
 */
export async function pollOnce(
  config: Config,
  db: Database.Database,
  dryRun: boolean,
  metrics?: MetricsService,
  targetIssue?: PollTargetIssue,
): Promise<PollResult> {
  const leaseManager = new LeaseManager(db)
  const runManager = new RunManager(db)
  const worktreeManager = createWorktreeManager()
  const costTracker = new CostTracker(db)

  let processed = 0
  let errors = 0
  const observability = new AgentObservability(db, config)
  setActiveAgentObservability(observability)

  try {

  // Update active runs gauge
  try {
    const activeRuns = runManager.getActive()
    metrics?.setActiveRuns(activeRuns.length)
    metrics?.setDailyCost(costTracker.getDailyCost())
  } catch { /* best-effort */ }

  // Clean expired leases
  leaseManager.cleanExpired()

  for (const repoConfig of config.repos) {
    if (targetIssue && repoConfig.repo !== targetIssue.repo) {
      continue
    }

    const forge = createForgeAdapter(repoConfig, config)
    const channels = createChannels(config.notifications, forge)
    const notifier = new NotificationDispatcher(channels, config.notifications.events)
    const usedPortsInPass: number[] = []

    // Resolve bot user for comment upserts (best-effort, fallback to empty string)
    let botUser = ''
    try {
      const authInfo = await forge.validateAuth()
      botUser = authInfo.user
    } catch {
      logger.debug({ repo: repoConfig.repo }, 'Could not resolve bot user for comment upserts')
    }

    const labelConfig = buildLabelConfig(repoConfig)

    // --- Reaction scan: check review_ready PRs for CI failures or human reviews ---
    try {
      await scanAndHandleReactions({
        db, forge, runManager, repoConfig, labelConfig, botUser,
      })
    } catch (err) {
      logger.warn({ repo: repoConfig.repo, err }, 'Reaction scan failed — continuing with issue discovery')
    }

    // --- Merge queue: process pending merges before discovering new work ---
    try {
      await processMergeQueue(db, forge, repoConfig)
    } catch (err) {
      logger.warn({ repo: repoConfig.repo, err }, 'Merge queue processing failed — continuing')
    }

    const discoveredAll = await discoverEligibleIssues(repoConfig, forge, leaseManager)
    const discovered = targetIssue
      ? discoveredAll.filter((d) => d.issue.number === targetIssue.issueNumber)
      : discoveredAll
    try { metrics?.setEligibleIssues(repoConfig.repo, discovered.length) } catch { /* best-effort */ }

    if (discovered.length === 0) {
      logger.info({ repo: repoConfig.repo }, 'No eligible issues')
      continue
    }

    if (dryRun) {
      for (const d of discovered) {
        logger.info({ issue: d.issue.number, triage: d.triage.level, title: d.issue.title }, '[dry-run] Discovered issue')
      }
      continue
    }

    // Process all currently eligible issues serially for this repo.
    for (const discoveredIssue of discovered) {
      if (discoveredIssue.triage.level === 'architectural') {
        await forge.addLabels(repoConfig.repo, discoveredIssue.issue.number, ['orch:needs-human'])
        const archBody = formatStatusComment({ blockReason: 'This issue is classified as architectural and requires human guidance.' })
        if (botUser) {
          await upsertBotComment(forge, repoConfig.repo, discoveredIssue.issue.number, STATUS_MARKER, archBody, botUser)
        } else {
          await forge.commentOnIssue(repoConfig.repo, discoveredIssue.issue.number, `🏗️ **night-orch**: This issue is classified as architectural and requires human guidance.`)
        }
        continue
      }

      if (!leaseManager.acquire(repoConfig.repo, discoveredIssue.issue.number, 'poller', 7200)) {
        continue
      }

      let runId: string | null = null
      let envSetup: EnvSetupResult | null = null
      let activeWorktreePath: string | null = null

      try {
        const resolvedRoles = resolveRoles(discoveredIssue.issue.labels, repoConfig.defaults)
        const queuedRun = runManager.getLatestQueuedByIssue(repoConfig.repo, discoveredIssue.issue.number)
        const roles = queuedRun
          ? {
              planner: coerceAgentName(queuedRun.planner, resolvedRoles.planner),
              coder: coerceAgentName(queuedRun.coder, resolvedRoles.coder),
              reviewer: coerceAgentName(queuedRun.reviewer, resolvedRoles.reviewer),
            }
          : resolvedRoles
        const slug = getOrPinSlug(db, repoConfig.repo, discoveredIssue.issue.number, discoveredIssue.issue.title)
        const branch = branchName(repoConfig.branchPrefix, discoveredIssue.issue.number, slug)
        const worktreePath = buildWorktreePath(config.storage.worktreeRoot, repoConfig.repo, discoveredIssue.issue.number)
        activeWorktreePath = worktreePath

        const run = queuedRun ?? runManager.create({
          repo: repoConfig.repo,
          issueNumber: discoveredIssue.issue.number,
          issueTitle: discoveredIssue.issue.title,
          issueNodeId: discoveredIssue.issue.nodeId,
          planner: roles.planner,
          coder: roles.coder,
          reviewer: roles.reviewer,
        })
        runId = run.id
        runManager.update(run.id, {
          status: 'running',
          issueTitle: discoveredIssue.issue.title,
          branchName: branch,
          branchSlug: slug,
          worktreePath,
          endedAt: null,
          lastError: null,
        })

        // Label transition
        await transitionLabels(
          forge,
          repoConfig.repo,
          discoveredIssue.issue.number,
          discoveredIssue.issue.labels,
          'queued',
          'running',
          labelConfig,
        )

        // Notify
        await notifier.dispatch(makePayload('run_started', repoConfig.repo, discoveredIssue.issue))

        // Detect rebase mode from queued run's phaseData
        const isRebaseRun = queuedRun?.phaseData?.reactionType === 'rebase'

        // Check if prior run left tainted work that should be discarded
        // Never reset to base for rebase runs — we need the existing branch
        const planningMode = isPlanningIssue(discoveredIssue.issue.labels, repoConfig)
        const resetToBase = !isRebaseRun && (planningMode || shouldResetBranch(runManager, repoConfig.repo, discoveredIssue.issue.number, run.id))

        // Create worktree
        await worktreeManager.ensure({
          repoLocalPath: repoConfig.localPath,
          baseBranch: repoConfig.baseBranch,
          branchName: branch,
          worktreePath,
          resetToBase,
        })

        // Execute rebase if this is a rebase-queued run
        if (isRebaseRun) {
          logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, runId: run.id }, 'Executing rebase for queued rebase run')
          const verifyCommands = repoConfig.verify ?? []
          const rebaseResult = await executeRebase(
            repoConfig.localPath,
            worktreePath,
            branch,
            repoConfig.baseBranch,
            repoConfig.repo,
            discoveredIssue.issue.number,
            verifyCommands,
          )

          if (rebaseResult.conflict) {
            // Rebase had conflicts — block the run, needs human intervention
            runManager.update(run.id, {
              status: 'blocked',
              lastError: 'Rebase failed due to merge conflicts — requires manual resolution',
              endedAt: new Date().toISOString(),
            })
            const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
            await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'blocked', labelConfig)
            await notifier.dispatch(makePayload('blocked', repoConfig.repo, discoveredIssue.issue, {
              summary: 'Rebase failed due to merge conflicts',
              blockingReason: 'merge_conflict',
            }))
            leaseManager.release(repoConfig.repo, discoveredIssue.issue.number)
            errors++
            continue
          }

          if (rebaseResult.rebased && rebaseResult.verifyPassed) {
            // Rebase succeeded and verify passes — done, transition back to review_ready
            logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Rebase succeeded, verify passed — returning to review_ready')
            runManager.update(run.id, {
              status: 'review_ready',
              endedAt: new Date().toISOString(),
              lastError: null,
            })
            const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
            await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'review_ready', labelConfig)
            await notifier.dispatch(makePayload('pr_ready', repoConfig.repo, discoveredIssue.issue, {
              summary: 'Rebased successfully, verify passed',
            }))
            leaseManager.release(repoConfig.repo, discoveredIssue.issue.number)
            processed++
            continue
          }

          if (!rebaseResult.rebased && rebaseResult.verifyPassed) {
            // Already up-to-date and verify passes — nothing to do
            logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Branch already up to date — returning to review_ready')
            runManager.update(run.id, {
              status: 'review_ready',
              endedAt: new Date().toISOString(),
              lastError: null,
            })
            const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
            await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'review_ready', labelConfig)
            leaseManager.release(repoConfig.repo, discoveredIssue.issue.number)
            processed++
            continue
          }

          // Rebase succeeded but verify failed — fall through to the loop engine
          // so the coder can fix the issues introduced by upstream changes
          logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Rebase done but verify failed — entering code loop to fix')
        }

        if (repoConfig.environment) {
          const mode = resolveEnvironmentMode(discoveredIssue.issue.labels, repoConfig)
          envSetup = await setupEnvironment({
            worktreePath,
            issueNumber: discoveredIssue.issue.number,
            repoConfig,
            mode,
            usedPorts: usedPortsInPass,
          })
        }

        // Get worker adapters
        const adjustedLimits = adjustLimitsForTriage(
          config.loop,
          config.workerProfiles[repoConfig.agents[roles.planner] ?? '']?.workerTimeoutSeconds ?? 1800,
          discoveredIssue.triage,
        )

        const plannerProfile = config.workerProfiles[repoConfig.agents[roles.planner] ?? '']
        const coderProfile = config.workerProfiles[repoConfig.agents[roles.coder] ?? '']
        const reviewerProfile = config.workerProfiles[repoConfig.agents[roles.reviewer] ?? '']

        if (!plannerProfile || !coderProfile || !reviewerProfile) {
          throw new Error('Missing worker profiles for resolved roles')
        }

        const initialCtx: RunContext = {
          runId: run.id,
          repo: repoConfig.repo,
          issueNumber: discoveredIssue.issue.number,
          issue: discoveredIssue.issue,
          repoConfig,
          roles,
          triageResult: discoveredIssue.triage,
          adjustedLimits,
          branchName: branch,
          worktreePath,
          plan: null,
          codeResult: null,
          diff: null,
          verifyResults: [],
          reviewResult: null,
          reviewFindings: [],
          iteration: 1,
          totalAgentPasses: 0,
          estimatedCostUsd: 0,
          currentPhase: 'plan',
          terminalStatus: 'running',
          phaseHistory: [],
          dryRun: false,
          runMode: isRebaseRun ? 'rebase' : 'fresh',
          blockReason: null,
          prReviewFeedback: null,
          sessionIds: {},
          stepOutputs: {},
        }

        // Check if decomposition is enabled and appropriate
        const shouldDecompose = config.loop.decompose
          && discoveredIssue.triage.level === 'standard'
          && !planningMode
          && shouldAttemptDecompose(discoveredIssue.issue)

        if (shouldDecompose) {
          logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Attempting issue decomposition')
          const decomposition = await decomposeIssue(
            discoveredIssue.issue,
            createWorkerAdapter(plannerProfile),
            plannerProfile,
            buildWorkerEnv(plannerProfile, envSetup?.envOverrides ?? {}),
            worktreePath,
            config.loop.maxSubtasks,
          )

          if (decomposition.shouldDecompose && decomposition.subtasks.length > 1) {
            logger.info(
              { repo: repoConfig.repo, issue: discoveredIssue.issue.number, subtasks: decomposition.subtasks.length },
              'Decomposed issue into sub-tasks — executing in parallel',
            )

            const loopDeps = {
              db, config,
              adapters: {
                planner: createWorkerAdapter(plannerProfile),
                coder: createWorkerAdapter(coderProfile),
                reviewer: createWorkerAdapter(reviewerProfile),
              },
              workflow: resolveWorkflow(repoConfig, config, discoveredIssue.issue.labels, discoveredIssue.triage.level),
              envOverrides: envSetup?.envOverrides ?? {},
              metrics,
              onAgentEvent: (event: AgentEvent) => observability.record(event),
            }

            const subResults = await executeParallelSubtasks(
              initialCtx,
              decomposition.subtasks,
              loopDeps,
              config.loop.maxConcurrentSubtasks,
            )

            const allSucceeded = subResults.every((r) => r.success)
            if (allSucceeded) {
              runManager.update(run.id, { status: 'review_ready', endedAt: new Date().toISOString() })
              const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
              await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'review_ready', labelConfig)
              await notifier.dispatch(makePayload('pr_ready', repoConfig.repo, discoveredIssue.issue, {
                summary: `Decomposed into ${decomposition.subtasks.length} sub-tasks, all completed`,
              }))
              processed++
            } else {
              const failed = subResults.filter((r) => !r.success).length
              runManager.update(run.id, {
                status: 'blocked',
                lastError: `${failed}/${decomposition.subtasks.length} sub-tasks failed`,
                endedAt: new Date().toISOString(),
              })
              const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
              await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'blocked', labelConfig)
              errors++
            }
            continue
          }
        }

        // Execute loop (single-issue path)
        const loopStart = Date.now()
        const finalCtx = await executeLoop(initialCtx, {
          db,
          config,
          adapters: {
            planner: createWorkerAdapter(plannerProfile),
            coder: createWorkerAdapter(coderProfile),
            reviewer: createWorkerAdapter(reviewerProfile),
          },
          workflow: resolveWorkflow(repoConfig, config, discoveredIssue.issue.labels, discoveredIssue.triage.level),
          envOverrides: envSetup?.envOverrides ?? {},
          metrics,
          onAgentEvent: (event) => observability.record(event),
          onPlanReady: async (ctx) => {
            await postPlanSummaryComment(forge, ctx.repo, ctx.issueNumber, ctx.plan, botUser)
          },
        })

        const runDurationSec = (Date.now() - loopStart) / 1000
        const outcome = await finalizeRunOutcome({
          finalCtx,
          runId: run.id,
          issue: discoveredIssue.issue,
          runDurationSec,
          repo: repoConfig.repo,
          issueNumber: discoveredIssue.issue.number,
          labelConfig,
          db,
          forge,
          runManager,
          notifier,
          metrics,
          maxAutoRetries: config.loop.maxAutoRetries,
          botUser,
        })

        if (outcome === 'processed') processed++
        else errors++
      } catch (err) {
        logger.error({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err }, 'Failed to process issue')
        if (runId) {
          const recentErrors = runManager.countRecentErrors(repoConfig.repo, discoveredIssue.issue.number)
          const maxRetries = config.loop.maxAutoRetries
          const canAutoRetry = recentErrors < maxRetries

          runManager.update(runId, {
            status: 'error',
            lastError: String(err),
            endedAt: new Date().toISOString(),
          })

          if (canAutoRetry) {
            // Auto-retry: transition back to queued so the next poll picks it up
            logger.info(
              { repo: repoConfig.repo, issue: discoveredIssue.issue.number, recentErrors, maxRetries },
              'Infra error — auto-retrying (transitioning back to ready)',
            )
            try {
              const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
              await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'queued', labelConfig)
            } catch (labelErr) {
              logger.warn({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err: labelErr }, 'Failed to transition labels for auto-retry')
            }
          } else {
            // Retries exhausted: mark as error, require human
            logger.warn(
              { repo: repoConfig.repo, issue: discoveredIssue.issue.number, recentErrors, maxRetries },
              'Auto-retry limit reached — marking as error',
            )
            try {
              const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
              await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'error', labelConfig)
              const errorBody = formatStatusComment({
                error: `Failed after ${recentErrors + 1} attempts. Last error: ${(err as Error).message}`,
                retryCount: recentErrors + 1,
                maxRetries: maxRetries,
              })
              if (botUser) {
                await upsertBotComment(forge, repoConfig.repo, discoveredIssue.issue.number, STATUS_MARKER, errorBody, botUser)
              } else {
                await forge.commentOnIssue(repoConfig.repo, discoveredIssue.issue.number, `⚠️ **night-orch**: Failed after ${recentErrors + 1} attempts. Last error: ${(err as Error).message}\n\nRemove \`orch:error\` and add \`orch:ready\` to retry.`)
              }
            } catch (labelErr) {
              logger.warn({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err: labelErr }, 'Failed to transition labels after retry exhaustion')
            }
            try {
              await notifier.dispatch(makePayload('retry_exhausted', repoConfig.repo, discoveredIssue.issue, {
                summary: `Failed after ${recentErrors + 1} attempts: ${(err as Error).message}`,
              }))
            } catch (notifyErr) {
              logger.warn({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err: notifyErr }, 'Failed to send retry exhaustion notification')
            }
          }
        }
        errors++
      } finally {
        if (envSetup && activeWorktreePath) {
          try {
            await teardownEnvironment({
              worktreePath: activeWorktreePath,
              issueNumber: discoveredIssue.issue.number,
              repoConfig,
              mode: envSetup.mode,
              composeProjectName: envSetup.composeProjectName,
            })
          } catch (envErr) {
            logger.warn({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err: envErr }, 'Failed to tear down environment')
          }
        }
        leaseManager.release(repoConfig.repo, discoveredIssue.issue.number)
      }
    }
  }

    return { processed, errors }
  } finally {
    clearActiveAgentObservability(observability)
    await observability.close()
  }
}

interface FinalizeRunOutcomeParams {
  finalCtx: RunContext
  runId: string
  issue: {
    number: number
    title: string
  }
  runDurationSec: number
  repo: string
  issueNumber: number
  labelConfig: ReturnType<typeof buildLabelConfig>
  db: Database.Database
  forge: ReturnType<typeof createForgeAdapter>
  runManager: RunManager
  notifier: NotificationDispatcher
  metrics?: MetricsService
  maxAutoRetries: number
  botUser: string
}

async function finalizeRunOutcome(params: FinalizeRunOutcomeParams): Promise<'processed' | 'error'> {
  const {
    finalCtx,
    runId,
    issue,
    runDurationSec,
    repo,
    issueNumber,
    labelConfig,
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
      runManager.update(runId, {
        status: 'review_ready',
        prNumber: publishResult.prNumber,
        prTitle: publishResult.prTitle,
        endedAt: new Date().toISOString(),
      })
      const latestIssue = await forge.getIssue(repo, issueNumber)
      await transitionLabels(
        forge,
        repo,
        issueNumber,
        latestIssue.labels,
        'running',
        'review_ready',
        labelConfig,
      )
      const notifyResult = await notifier.dispatch(makePayload('pr_ready', repo, issue, {
        prUrl: publishResult.prUrl,
        prNumber: publishResult.prNumber,
        summary: `PR ready: ${publishResult.prUrl}`,
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
      runManager.update(runId, { status: 'error', lastError: String(err), endedAt: new Date().toISOString() })
      const recentErrors = new RunManager(db).countRecentErrors(repo, issueNumber)
      const latestIssue = await forge.getIssue(repo, issueNumber)
      if (recentErrors < maxAutoRetries) {
        await transitionLabels(forge, repo, issueNumber, latestIssue.labels, 'running', 'queued', labelConfig)
        logger.info({ repo, issueNumber, recentErrors }, 'Publish failed — auto-retrying')
      } else {
        await transitionLabels(forge, repo, issueNumber, latestIssue.labels, 'running', 'error', labelConfig)
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
    runManager.update(runId, { status: 'blocked', lastError: blockReason, blockReason: finalCtx.blockReason, endedAt: new Date().toISOString() })
    const latestIssue = await forge.getIssue(repo, issueNumber)
    await transitionLabels(
      forge,
      repo,
      issueNumber,
      latestIssue.labels,
      'running',
      'blocked',
      labelConfig,
    )

    // Upsert status comment with block reason
    try {
      const statusBody = formatStatusComment({
        blockReason,
        iteration: finalCtx.iteration,
        maxIterations: finalCtx.adjustedLimits.maxReviewIterations,
        cost: finalCtx.estimatedCostUsd,
      })
      if (botUser) {
        await upsertBotComment(forge, repo, issueNumber, STATUS_MARKER, statusBody, botUser)
      } else {
        await forge.commentOnIssue(repo, issueNumber, formatBlockComment(blockReason, finalCtx))
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
  runManager.update(runId, { status: 'error', lastError: unexpectedError, endedAt: new Date().toISOString() })
  const recentErrors = new RunManager(db).countRecentErrors(repo, issueNumber)
  const latestIssue = await forge.getIssue(repo, issueNumber)
  if (recentErrors < maxAutoRetries) {
    await transitionLabels(forge, repo, issueNumber, latestIssue.labels, 'running', 'queued', labelConfig)
    logger.info({ repo, issueNumber, recentErrors }, 'Unexpected state — auto-retrying')
  } else {
    await transitionLabels(forge, repo, issueNumber, latestIssue.labels, 'running', 'error', labelConfig)
    try {
      const unexpectedBody = formatStatusComment({ error: `Failed after ${recentErrors + 1} attempts. Last error: ${unexpectedError}` })
      if (botUser) {
        await upsertBotComment(forge, repo, issueNumber, STATUS_MARKER, unexpectedBody, botUser)
      } else {
        await forge.commentOnIssue(repo, issueNumber, `⚠️ **night-orch**: Failed after ${recentErrors + 1} attempts. Last error: ${unexpectedError}`)
      }
    } catch { /* best-effort */ }
  }
  try {
    metrics?.incRunsTotal('error')
    metrics?.observeRunDuration(runDurationSec)
  } catch { /* best-effort */ }
  return 'error'
}

function coerceAgentName(
  value: string,
  fallback: ResolvedRoles['planner'],
): ResolvedRoles['planner'] {
  if (value === 'claude' || value === 'codex') {
    return value
  }
  return fallback
}

function buildBlockReason(ctx: RunContext): string {
  if (ctx.reviewResult) {
    const findings = ctx.reviewResult.findings
      .filter((f) => f.severity === 'critical' || f.severity === 'major')
      .map((f) => `[${f.severity}] ${f.message}`)
      .join('; ')
    return findings
      ? `${ctx.reviewResult.summary} — ${findings}`
      : ctx.reviewResult.summary
  }
  return `Blocked in phase ${ctx.currentPhase} (no review result available)`
}

function formatBlockComment(reason: string, ctx: RunContext): string {
  const parts = [`⛔ **night-orch**: Run blocked.\n\n**Reason:** ${reason}`]
  if (ctx.reviewResult?.findings && ctx.reviewResult.findings.length > 0) {
    parts.push('\n**Findings:**')
    for (const f of ctx.reviewResult.findings) {
      const fix = f.suggestedFix ? ` → ${f.suggestedFix}` : ''
      parts.push(`- **${f.severity}**: ${f.message}${fix}`)
    }
  }
  parts.push(`\n*Iteration ${ctx.iteration}, cost: $${ctx.estimatedCostUsd.toFixed(4)}*`)
  return parts.join('\n')
}

function makePayload(
  event: NotificationPayload['event'],
  repo: string,
  issue: { number: number; title: string },
  extra: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    event,
    repo,
    issueNumber: issue.number,
    issueTitle: issue.title,
    state: event,
    prUrl: null,
    prNumber: null,
    summary: `${event}: #${issue.number} ${issue.title}`,
    blockingReason: null,
    reviewSummary: null,
    iterationCount: 0,
    timestamp: new Date().toISOString(),
    ...extra,
  }
}

/**
 * Block reasons that indicate the coder's work is broken and the branch
 * should be hard-reset to base on the next attempt. Salvageable states
 * (reviewer_blocked, iteration_limit, ambiguous_review, verify_config)
 * preserve the branch so existing work can be continued.
 */
const TAINTED_BLOCK_REASONS = new Set(['agent_pass_limit', 'cost_limit'])

// --- Reaction scanning ---

/** In-memory reaction cursors, keyed by "repo#issueNumber". */
const reactionCursors = new Map<string, ReactionCursor>()

interface ScanAndHandleReactionsParams {
  db: Database.Database
  forge: ReturnType<typeof createForgeAdapter>
  runManager: RunManager
  repoConfig: Config['repos'][0]
  labelConfig: ReturnType<typeof buildLabelConfig>
  botUser: string
}

async function scanAndHandleReactions(params: ScanAndHandleReactionsParams): Promise<void> {
  const { db, forge, runManager, repoConfig, labelConfig, botUser } = params

  // Find review_ready runs with PRs for this repo
  const rows = db
    .prepare(
      "SELECT * FROM runs WHERE repo = ? AND status = 'review_ready' AND pr_number IS NOT NULL",
    )
    .all(repoConfig.repo) as Array<{ id: string; repo: string; issue_number: number; pr_number: number }>

  for (const row of rows) {
    const cursorKey = `${row.repo}#${row.issue_number}`
    const cursor = reactionCursors.get(cursorKey)

    const result = await scanForReactions(
      forge,
      row.repo,
      row.pr_number,
      row.issue_number,
      botUser,
      cursor,
    )

    // Update cursor regardless of reactions
    reactionCursors.set(cursorKey, result.cursor)

    // Handle each reaction
    for (const reaction of result.reactions) {
      try {
        await handleReaction(reaction, { db, forge, runManager, labelConfig })
      } catch (err) {
        logger.warn(
          { repo: row.repo, issueNumber: row.issue_number, reactionType: reaction.type, err },
          'Failed to handle reaction',
        )
      }
    }
  }
}

function shouldResetBranch(
  runManager: RunManager,
  repo: string,
  issueNumber: number,
  currentRunId: string,
): boolean {
  const prior = runManager.getLatestFinishedByIssue(repo, issueNumber, currentRunId)
  if (!prior) return false

  // Infrastructure errors — work is unreliable
  if (prior.status === 'error') return true

  // Blocked with tainted block reason — coder couldn't produce working code
  if (prior.status === 'blocked' && prior.blockReason && TAINTED_BLOCK_REASONS.has(prior.blockReason)) return true

  return false
}
