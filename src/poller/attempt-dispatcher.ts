import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { LeaseManager } from '../state/leases.js'
import type { RunManager } from '../state/runs.js'
import type { MetricsService } from '../metrics/service.js'
import type { DiscoveredIssue } from '../discovery/discover.js'
import type { AgentEvent } from '../events/types.js'
import type { AgentObservability } from '../events/observability.js'
import type { RunContext } from '../loop/types.js'
import type { EnvSetupResult } from '../environment/manager.js'
import type { UpdateStrategy, WorktreeManager } from '../git/worktree.js'
import type { VerifyResult } from '../workers/types.js'

import { blocked } from '../loop/state.js'
import { executeLoop } from '../loop/engine.js'
import { resolveWorkflow } from '../loop/workflow.js'
import { decomposeIssue, shouldAttemptDecompose } from '../discovery/decomposer.js'
import { executeParallelSubtasks } from '../loop/parallel.js'
import { resolveRoles } from '../discovery/roles.js'
import { adjustLimitsForTriage } from '../discovery/triage.js'
import { getOrPinSlug, buildWorktreePath } from '../git/slug.js'
import {
  resolveEnvironmentMode,
  setupEnvironment,
  teardownEnvironment,
} from '../environment/manager.js'
import { createWorkerAdapter } from '../workers/factory.js'
import { buildWorkerEnv } from '../workers/env.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { branchName } from '../utils/ids.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'
import { executeRebase } from '../ops/rebase-and-check.js'
import { buildConflictSnapshot } from '../ops/conflict-snapshot.js'
import { postPlanSummaryComment } from '../loop/plan-summary-comment.js'
import { isPlanningIssue } from '../planning/mode.js'
import { finalizeRunOutcome } from '../runner/run-finalizer.js'
import {
  applyRecoveryPlan,
  classifyInfraError,
} from './error-recovery.js'
import { clearResumeDecisionArtifacts } from '../loop/checkpoint.js'
import { PollerNotifier } from './notify-dispatcher.js'
import { RunStateController } from './run-state-controller.js'
import {
  applyWorkflowAgentOverrides,
  applyWorkflowRoleDefaults,
  resolveWorkerProfileForAgent,
} from '../runner/workflow-overlay.js'
import { coerceAgentName } from '../discovery/roles.js'
import {
  isImmediateFollowupStatus,
  extractFollowupPromptFeedback,
  buildAttemptHistoryFollowup,
  type RunControlPayload,
  resolveControlPayload,
  deriveBranchPolicy,
  resolveOperationIntent,
  selectReplayableRun,
  shouldResetBranch,
} from '../runner/intent.js'
import { postStatusComment } from '../runner/comment-formatting.js'
import { createWorkItemFromDiscoveredIssue } from '../work-items/types.js'
import type { OrchestrationCache } from '../runner/orchestration-cache.js'
import type { NotificationDispatcher } from '../notify/dispatcher.js'

const STATUS_MARKER = markerTag('status')

/**
 * R6 boundary: own the full lifecycle of a single attempt on a single
 * discovered issue, from lease acquisition through loop execution to
 * finalization, teardown, and error recovery.
 *
 * Extracted from the monolithic `pollOnce` body so the per-issue path
 * has a clear signature, a single return shape, and a dedicated place
 * for the circuit-breaker / worktree / env / decompose / rebase /
 * executeLoop / finalize state machine that used to live inline.
 *
 * Invariants preserved from the pre-R6 code:
 *   - Lease is always released on exit (try/finally).
 *   - Environment is torn down on exit if setup succeeded.
 *   - Follow-up repos are reported back via `immediateFollowupRepo`.
 *   - Process-global caches keyed by (repo, issue) are evicted in
 *     the success path via `cleanupRunCaches`.
 *   - On caught errors, `applyRecoveryPlan` runs with the typed plan
 *     from `classifyInfraError` — this is the only place that
 *     converts infra errors into recovery actions.
 */

export interface DispatchAttemptParams {
  config: Config
  db: Database.Database
  forge: ForgeAdapter
  repoConfig: Config['repos'][number]
  discoveredIssue: DiscoveredIssue
  runManager: RunManager
  leaseManager: LeaseManager
  worktreeManager: WorktreeManager
  notifier: NotificationDispatcher
  observability: AgentObservability
  botUser: string
  usedPortsInPass: number[]
  cache: OrchestrationCache
  metrics?: MetricsService
}

export interface DispatchAttemptResult {
  outcome: 'processed' | 'errored' | 'skipped'
  immediateFollowupRepo: string | null
}

export async function dispatchAttempt(
  params: DispatchAttemptParams,
): Promise<DispatchAttemptResult> {
  const {
    config,
    db,
    forge,
    repoConfig,
    discoveredIssue,
    runManager,
    leaseManager,
    worktreeManager,
    notifier: innerNotifier,
    observability,
    botUser,
    usedPortsInPass,
    cache,
    metrics,
  } = params
  const pollerNotifier = new PollerNotifier(innerNotifier)
  const issueRepo = discoveredIssue.issueRepo
  const runStateController = new RunStateController({
    forge,
    repoConfig,
    issueRepo,
    issue: discoveredIssue.issue,
    runManager,
    pollerNotifier,
    botUser,
  })

  const transitionIssueLabels = createIssueLabelTransitioner(
    forge,
    repoConfig,
    issueRepo,
    discoveredIssue.issue.number,
  )

  if (discoveredIssue.triage.level === 'architectural') {
    const labelConfig = buildLabelConfig(repoConfig, discoveredIssue.issue.labels)
    await forge.addLabels(issueRepo, discoveredIssue.issue.number, [labelConfig.needsHuman])
    const archBody = formatStatusComment({ blockReason: 'This issue is classified as architectural and requires human guidance.' })
    if (botUser) {
      await upsertBotComment(forge, issueRepo, discoveredIssue.issue.number, STATUS_MARKER, archBody, botUser)
    } else {
      await forge.commentOnIssue(issueRepo, discoveredIssue.issue.number, `🏗️ **night-orch**: This issue is classified as architectural and requires human guidance.`)
    }
    return { outcome: 'skipped', immediateFollowupRepo: null }
  }

  if (!leaseManager.acquire(issueRepo, discoveredIssue.issue.number, 'poller', 1800)) {
    return { outcome: 'skipped', immediateFollowupRepo: null }
  }

  let runId: string | null = null
  let envSetup: EnvSetupResult | null = null
  let activeWorktreePath: string | null = null
  let outcome: 'processed' | 'errored' | 'skipped' = 'skipped'

  try {
    const workflow = resolveWorkflow(
      repoConfig,
      config,
      discoveredIssue.issue.labels,
      discoveredIssue.triage.level,
    )
    const repoConfigForRun = applyWorkflowAgentOverrides(repoConfig, workflow)
    const roleDefaults = applyWorkflowRoleDefaults(
      repoConfigForRun.defaults,
      workflow,
      repoConfigForRun,
      config,
    )
    const resolvedRoles = resolveRoles(discoveredIssue.issue.labels, roleDefaults)
    const queuedRun = runManager.getLatestQueuedByIssue(repoConfig.repo, discoveredIssue.issue.number)
    const replayableRun = queuedRun
      ? null
      : selectReplayableRun(runManager.getByRepoAndIssue(repoConfig.repo, discoveredIssue.issue.number))

    // Circuit breaker: stop retrying after N consecutive blocks
    if (replayableRun && !queuedRun) {
      const consecutiveBlocks = runManager.countConsecutiveBlocks(repoConfig.repo, discoveredIssue.issue.number)
      const maxBlocks = config.loop.maxConsecutiveBlocks
      if (consecutiveBlocks >= maxBlocks) {
        logger.warn(
          { repo: repoConfig.repo, issue: discoveredIssue.issue.number, consecutiveBlocks, maxBlocks },
          'Circuit breaker: too many consecutive blocks — skipping issue',
        )
        try { metrics?.incCircuitBreakerTrip(repoConfig.repo) } catch { /* best-effort */ }
        await transitionIssueLabels(
          replayableRun.status,
          'blocked',
        )
        await postStatusComment({
          forge,
          issueRepo,
          issueNumber: discoveredIssue.issue.number,
          botUser,
          body: formatStatusComment({
            blockReason: `Circuit breaker: ${consecutiveBlocks} consecutive blocked runs. This issue needs human intervention — the task may be too large, ambiguous, or hitting a systematic failure. Use /orch retry after addressing the root cause.`,
          }),
          warnMessage: 'Failed to post circuit breaker status comment',
        })
        return { outcome: 'skipped', immediateFollowupRepo: null }
      }
    }

    const activeRun = queuedRun ?? replayableRun
    const roles = activeRun
      ? {
          planner: coerceAgentName(activeRun.planner, resolvedRoles.planner),
          coder: coerceAgentName(activeRun.coder, resolvedRoles.coder),
          reviewer: coerceAgentName(activeRun.reviewer, resolvedRoles.reviewer),
        }
      : resolvedRoles
    const slug = getOrPinSlug(db, repoConfig.repo, discoveredIssue.issue.number, discoveredIssue.issue.title)
    const branch = branchName(repoConfig.branchPrefix, discoveredIssue.issue.number, slug)
    const worktreePath = buildWorktreePath(config.storage.worktreeRoot, repoConfig.repo, discoveredIssue.issue.number)
    activeWorktreePath = worktreePath

    const run = activeRun ?? runManager.create({
      repo: repoConfig.repo,
      issueNumber: discoveredIssue.issue.number,
      issueTitle: discoveredIssue.issue.title,
      issueNodeId: discoveredIssue.issue.nodeId,
      planner: roles.planner,
      coder: roles.coder,
      reviewer: roles.reviewer,
    })
    const startingIteration = activeRun ? Math.max(activeRun.iterationCount, 1) : 1
    const previousRunStatus = run.status
    if (replayableRun) {
      logger.info(
        { repo: repoConfig.repo, issue: discoveredIssue.issue.number, runId: run.id, status: replayableRun.status },
        'Re-queuing active run for rediscovered ready issue',
      )
    }
    runId = run.id
    await runStateController.markRunning(run.id, {
      iterationCount: startingIteration,
      issueTitle: discoveredIssue.issue.title,
      branchName: branch,
      branchSlug: slug,
      worktreePath,
      phaseData: {
        ...clearResumeDecisionArtifacts(run.phaseData),
        issueRepo,
      },
      endedAt: null,
      lastError: null,
      blockReason: null,
    }, previousRunStatus)

    const operationIntent = resolveOperationIntent(activeRun)
    const controlPayload = resolveControlPayload(activeRun)
    const updateStrategyOverride = resolveUpdateStrategyOverride(controlPayload)
    let followupPromptFeedback = extractFollowupPromptFeedback(activeRun?.phaseData)
    if (!followupPromptFeedback) {
      const previousRun = runManager.getLatestFinishedByIssue(
        repoConfig.repo,
        discoveredIssue.issue.number,
        run.id,
      )
      followupPromptFeedback = buildAttemptHistoryFollowup(previousRun)
    }
    let preLoopVerifyResults: VerifyResult[] = []

    // Check if prior run left tainted work that should be discarded
    const planningMode = isPlanningIssue(discoveredIssue.issue.labels, repoConfigForRun)
    const branchPolicy = deriveBranchPolicy({
      operationIntent,
      controlPayload,
      planningMode,
      updateStrategyOverride,
      shouldResetFromHistory: shouldResetBranch(
        runManager,
        repoConfig.repo,
        discoveredIssue.issue.number,
        run.id,
      ),
      hasFollowupPromptFeedback: Boolean(followupPromptFeedback),
    })

    // Create worktree
    const ensuredWorktree = await worktreeManager.ensure({
      repoLocalPath: repoConfig.localPath,
      baseBranch: repoConfig.baseBranch,
      branchName: branch,
      worktreePath,
      resetToBase: branchPolicy.resetToBase,
      preserveBranchState: branchPolicy.preserveBranchState,
      updateStrategy: updateStrategyOverride ?? repoConfig.updateStrategy,
    })

    if (ensuredWorktree.rebaseConflict) {
      const worktreeConflictOutcome = await handleWorktreeRefreshConflict({
        forge,
        repoConfig,
        issueRepo,
        issue: discoveredIssue.issue,
        runId: run.id,
        runManager,
        pollerNotifier,
        botUser,
        branch,
        strategy: updateStrategyOverride ?? repoConfig.updateStrategy,
      })
      return {
        outcome: worktreeConflictOutcome,
        immediateFollowupRepo: computeImmediateFollowup(runManager, runId),
      }
    }

    if (!ensuredWorktree.isClean) {
      const summary = `Cannot start run because worktree is dirty before loop start: ${worktreePath}`
      await runStateController.markBlocked(run.id, {
        from: 'running',
        fields: {
          blockReason: 'verify_config',
          operationIntent,
          lastError: summary,
        },
        labelReason: blocked({
          type: 'verifyConfig',
          detail: summary,
        }).reason,
        comment: {
          body: formatStatusComment({
            blockReason: summary,
            nextStep: 'Use /orch retry to recreate a fresh worktree from the base branch.',
          }),
          warnMessage: 'Failed to post dirty worktree status comment',
        },
        notification: {
          summary,
          blockingReason: 'verify_config',
        },
      })
      return {
        outcome: 'errored',
        immediateFollowupRepo: computeImmediateFollowup(runManager, runId),
      }
    }

    // Execute explicit rebase or automatic branch refresh before entering the loop.
    if (branchPolicy.runMode === 'rebase' || branchPolicy.runMode === 'refresh') {
      const refreshOutcome = await handleBranchRefreshRun({
        forge,
        config,
        db,
        repoConfig,
        issueRepo,
        discoveredIssue,
        worktreePath,
        branch,
        runId: run.id,
        runManager,
        pollerNotifier,
        botUser,
        controlPayload,
        updateStrategyOverride,
        operationIntent: branchPolicy.runMode,
        metrics,
      })
      if (refreshOutcome.outcome !== 'continue-to-loop') {
        outcome = refreshOutcome.outcome
        return {
          outcome,
          immediateFollowupRepo: computeImmediateFollowup(runManager, runId),
        }
      }
      preLoopVerifyResults = refreshOutcome.verifyResults
      logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, operationIntent }, 'Branch refresh completed but verify failed — entering code loop to fix')
    }

    if (repoConfigForRun.environment) {
      const mode = resolveEnvironmentMode(discoveredIssue.issue.labels, repoConfigForRun)
      envSetup = await setupEnvironment({
        worktreePath,
        issueNumber: discoveredIssue.issue.number,
        repoConfig: repoConfigForRun,
        mode,
        usedPorts: usedPortsInPass,
      })
    }

    // Get worker adapters
    const plannerProfile = resolveWorkerProfileForAgent(roles.planner, repoConfigForRun, config)
    const coderProfile = resolveWorkerProfileForAgent(roles.coder, repoConfigForRun, config)
    const reviewerProfile = resolveWorkerProfileForAgent(roles.reviewer, repoConfigForRun, config)

    const adjustedLimits = adjustLimitsForTriage(
      config.loop,
      plannerProfile?.workerTimeoutSeconds ?? 1800,
      discoveredIssue.triage,
    )

    if (!plannerProfile || !coderProfile || !reviewerProfile) {
      throw new Error('Missing worker profiles for resolved roles')
    }

    const initialCtx: RunContext = {
      runId: run.id,
      repo: repoConfig.repo,
      issueRepo,
      issueNumber: discoveredIssue.issue.number,
      issue: discoveredIssue.issue,
      workItem: createWorkItemFromDiscoveredIssue(discoveredIssue, repoConfigForRun, workflow),
      repoConfig: repoConfigForRun,
      roles,
      triageResult: discoveredIssue.triage,
      adjustedLimits,
      branchName: branch,
      worktreePath,
      plan: null,
      codeResult: null,
      diff: null,
      verifyResults: preLoopVerifyResults,
      reviewResult: null,
      reviewResults: {},
      reviewFindings: [],
      iteration: startingIteration,
      totalAgentPasses: 0,
      estimatedCostUsd: 0,
      currentPhase: workflow.steps[0]?.id ?? 'plan',
      terminalStatus: 'running',
      phaseHistory: [],
      dryRun: false,
      runMode: branchPolicy.runMode,
      blockReason: null,
      prReviewFeedback: followupPromptFeedback,
      sessionIds: {},
      stepOutputs: {},
      iterationSnapshots: [],
      diffError: null,
      emptyDiffRetries: 0,
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
          workflow,
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
          await runStateController.markReviewReady(run.id, {
            from: 'running',
            notification: {
              summary: `Decomposed into ${decomposition.subtasks.length} sub-tasks, all completed`,
            },
          })
          outcome = 'processed'
        } else {
          const failed = subResults.filter((r) => !r.success).length
          await runStateController.markBlocked(run.id, {
            from: 'running',
            fields: { lastError: `${failed}/${decomposition.subtasks.length} sub-tasks failed` },
            notification: false,
          })
          outcome = 'errored'
        }
        return {
          outcome,
          immediateFollowupRepo: computeImmediateFollowup(runManager, runId),
        }
      }
    }

    // Execute loop (single-issue path)
    const loopStart = Date.now()
    const adapters = {
      planner: createWorkerAdapter(plannerProfile),
      coder: createWorkerAdapter(coderProfile),
      reviewer: createWorkerAdapter(reviewerProfile),
    }
    const finalCtx = await executeLoop(initialCtx, {
      db,
      config,
      adapters,
      workflow,
      envOverrides: envSetup?.envOverrides ?? {},
      metrics,
      onAgentEvent: (event) => observability.record(event),
      onPlanReady: async (ctx) => {
        await postPlanSummaryComment(forge, ctx.issueRepo ?? ctx.repo, ctx.issueNumber, ctx.plan, botUser)
      },
      leaseHeartbeat: () =>
        leaseManager.heartbeat(
          issueRepo,
          discoveredIssue.issue.number,
          'poller',
          1800,
        ),
    })

    const runDurationSec = (Date.now() - loopStart) / 1000
    const finalizerOutcome = await finalizeRunOutcome({
      finalCtx,
      runId: run.id,
      issue: discoveredIssue.issue,
      runDurationSec,
      repo: repoConfig.repo,
      repoConfig,
      issueRepo,
      issueNumber: discoveredIssue.issue.number,
      db,
      forge,
      runManager,
      notifier: innerNotifier,
      metrics,
      maxAutoRetries: config.loop.maxAutoRetries,
      botUser,
      postPublish: {
        config,
        workflow,
        adapters,
        envOverrides: envSetup?.envOverrides ?? {},
      },
    })

    outcome = finalizerOutcome === 'processed' ? 'processed' : 'errored'

    try {
      await observability.closeRun(run.id)
    } catch (closeErr) {
      logger.debug({ runId: run.id, err: closeErr }, 'closeRun failed (best-effort)')
    }
    cleanupRunCaches(cache, repoConfig.repo, discoveredIssue.issue.number)

    return {
      outcome,
      immediateFollowupRepo: computeImmediateFollowup(runManager, runId),
    }
  } catch (err) {
    logger.error({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err }, 'Failed to process issue')
    if (runId) {
      const existing = runManager.getById(runId)
      const plan = classifyInfraError({
        runId,
        currentRetryCount: existing?.retryCount ?? 0,
        err,
        maxAutoRetries: config.loop.maxAutoRetries,
      })
      await applyRecoveryPlan({
        plan,
        config,
        repoConfig,
        issueRepo,
        issue: discoveredIssue.issue,
        runId,
        botUser,
        forge,
        runManager,
        notifier: innerNotifier,
      })
    }
    return {
      outcome: 'errored',
      immediateFollowupRepo: computeImmediateFollowup(runManager, runId),
    }
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
    leaseManager.release(issueRepo, discoveredIssue.issue.number)
  }
}

/**
 * Evict process-global reaction/comment caches keyed by (repo, issue)
 * once a run reaches a terminal state.
 */
function cleanupRunCaches(cache: OrchestrationCache, repo: string, issueNumber: number): void {
  const key = `${repo}#${issueNumber}`
  cache.missingCommentCommandIssues.delete(key)
  cache.reactionCursors.delete(key)
}

function computeImmediateFollowup(
  runManager: RunManager,
  runId: string | null,
): string | null {
  if (!runId) return null
  const finalRun = runManager.getById(runId)
  if (finalRun && isImmediateFollowupStatus(finalRun.status)) {
    return finalRun.repo
  }
  return null
}

function createIssueLabelTransitioner(
  forge: ForgeAdapter,
  repoConfig: Config['repos'][number],
  issueRepo: string,
  issueNumber: number,
): (
    from: Parameters<typeof transitionLabels>[4],
    to: Parameters<typeof transitionLabels>[5],
    blockReason?: Parameters<typeof transitionLabels>[7],
  ) => Promise<void> {
  let latestIssuePromise: ReturnType<ForgeAdapter['getIssue']> | null = null
  const getLatestIssue = (): ReturnType<ForgeAdapter['getIssue']> => {
    latestIssuePromise ??= forge.getIssue(issueRepo, issueNumber)
    return latestIssuePromise
  }

  return async (from, to, blockReason) => {
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
}

// --- Branch refresh flow extracted from the inline body for readability ---

interface HandleWorktreeRefreshConflictParams {
  forge: ForgeAdapter
  repoConfig: Config['repos'][number]
  issueRepo: string
  issue: DiscoveredIssue['issue']
  runId: string
  runManager: RunManager
  pollerNotifier: PollerNotifier
  botUser: string
  branch: string
  strategy: UpdateStrategy
}

async function handleWorktreeRefreshConflict(
  params: HandleWorktreeRefreshConflictParams,
): Promise<'errored'> {
  const {
    forge,
    repoConfig,
    issueRepo,
    issue,
    runId,
    runManager,
    pollerNotifier,
    botUser,
    branch,
    strategy,
  } = params

  const summary = `Refreshing ${branch} against origin/${repoConfig.baseBranch} conflicted before the loop could start.`
  const snapshot = buildConflictSnapshot({
    source: 'branch_refresh',
    kind: strategy === 'rebase' ? 'rebase' : 'merge',
    strategy,
    summary,
    branchName: branch,
    baseBranch: repoConfig.baseBranch,
  })
  const runStateController = new RunStateController({
    forge,
    repoConfig,
    issueRepo,
    issue,
    runManager,
    pollerNotifier,
    botUser,
  })

  await runStateController.markBlocked(runId, {
    from: 'running',
    fields: {
      blockReason: 'merge_conflict',
      operationIntent: 'refresh',
      manualState: 'awaiting_rebase_resolution',
      controlPayload: {
        issueRepo,
        preserveBranchState: true,
        conflictSummary: summary,
        conflictFiles: [],
        conflictExcerpts: [],
        conflictSnapshot: snapshot,
        requestedAt: nowUtcIso(),
      },
      phaseData: {
        issueRepo,
        reactionType: 'refresh_conflict',
        reactionSummary: 'Branch refresh conflicted before planning started',
        reactionContext: summary,
        reactionConflictSnapshot: snapshot,
      },
      lastError: summary,
    },
    labelReason: blocked({
      type: 'mergeConflict',
      files: [],
      summary,
    }).reason,
    comment: {
      body: formatStatusComment({
        blockReason: summary,
        nextStep: 'Use /orch continue to resume with the preserved branch state, or /orch retry to rebuild from the latest base branch.',
      }),
      warnMessage: 'Failed to post worktree refresh conflict status comment',
    },
    notification: {
      summary,
      blockingReason: 'merge_conflict',
    },
  })
  return 'errored'
}

interface HandleBranchRefreshRunParams {
  forge: ForgeAdapter
  config: Config
  db: Database.Database
  repoConfig: Config['repos'][number]
  issueRepo: string
  discoveredIssue: DiscoveredIssue
  worktreePath: string
  branch: string
  runId: string
  runManager: RunManager
  pollerNotifier: PollerNotifier
  botUser: string
  controlPayload: RunControlPayload | null
  operationIntent: 'refresh' | 'rebase'
  updateStrategyOverride?: UpdateStrategy
  metrics?: MetricsService
}

interface BranchRefreshOutcome {
  outcome: 'continue-to-loop' | 'processed' | 'errored'
  verifyResults: VerifyResult[]
}

async function handleBranchRefreshRun(params: HandleBranchRefreshRunParams): Promise<BranchRefreshOutcome> {
  const {
    forge,
    config,
    db,
    repoConfig,
    issueRepo,
    discoveredIssue,
    worktreePath,
    branch,
    runId,
    runManager,
    pollerNotifier,
    botUser,
    controlPayload,
    operationIntent,
    updateStrategyOverride,
    metrics,
  } = params

  const strategy = operationIntent === 'rebase'
    ? updateStrategyOverride ?? 'rebase'
    : updateStrategyOverride ?? repoConfig.updateStrategy
  const isExplicitRebase = operationIntent === 'rebase'
  const modeLabel = isExplicitRebase ? 'rebase' : 'branch refresh'
  const runStateController = new RunStateController({
    forge,
    repoConfig,
    issueRepo,
    issue: discoveredIssue.issue,
    runManager,
    pollerNotifier,
    botUser,
  })

  logger.info(
    { repo: repoConfig.repo, issue: discoveredIssue.issue.number, runId, operationIntent, strategy },
    'Executing branch refresh run',
  )
  const verifyCommands = repoConfig.verify ?? []
  const rebaseResult = await executeRebase(
    repoConfig.localPath,
    worktreePath,
    branch,
    repoConfig.baseBranch,
    issueRepo,
    discoveredIssue.issue.number,
    verifyCommands,
    controlPayload?.checkAfter !== false,
    strategy,
    {
      issueTitle: discoveredIssue.issue.title,
      issueBody: discoveredIssue.issue.body,
      config,
      db,
      runId,
      metrics,
    },
  )

  if (rebaseResult.conflict) {
    const summary = rebaseResult.conflictAnalysis?.summary
      ?? `${isExplicitRebase ? 'Rebase' : 'Branch refresh'} failed due to merge conflicts.`
    const snapshot = buildConflictSnapshot({
      source: isExplicitRebase ? 'manual_rebase' : 'branch_refresh',
      kind: strategy === 'rebase' ? 'rebase' : 'merge',
      strategy,
      summary,
      branchName: branch,
      baseBranch: repoConfig.baseBranch,
      files: rebaseResult.conflictAnalysis?.files ?? [],
      excerpts: rebaseResult.conflictAnalysis?.excerpts ?? [],
      resolution: rebaseResult.resolution,
      branchHeadSha: rebaseResult.conflictAnalysis?.branchHeadSha ?? null,
      baseHeadSha: rebaseResult.conflictAnalysis?.baseHeadSha ?? null,
    })
    await runStateController.markBlocked(runId, {
      from: 'running',
      fields: {
        blockReason: 'merge_conflict',
        operationIntent,
        manualState: 'awaiting_rebase_resolution',
        controlPayload: {
          issueRepo,
          preserveBranchState: true,
          conflictSummary: summary,
          conflictFiles: rebaseResult.conflictAnalysis?.files ?? [],
          conflictExcerpts: rebaseResult.conflictAnalysis?.excerpts ?? [],
          resolutionAttempted: rebaseResult.resolution?.attempted ?? false,
          resolutionOutcome: rebaseResult.resolution?.outcome ?? null,
          resolvedFiles: rebaseResult.resolution?.files ?? [],
          conflictSnapshot: snapshot,
          requestedAt: nowUtcIso(),
        },
        phaseData: {
          issueRepo,
          reactionType: isExplicitRebase ? 'rebase_conflict' : 'refresh_conflict',
          reactionSummary: isExplicitRebase
            ? 'Explicit rebase conflicted with latest base branch changes'
            : 'Automatic branch refresh conflicted with latest base branch changes',
          reactionContext: summary,
          reactionConflictSnapshot: snapshot,
        },
        lastError: summary,
      },
      labelReason: blocked({
        type: 'mergeConflict',
        files: rebaseResult.conflictAnalysis?.files ?? [],
        summary,
      }).reason,
      comment: {
        body: formatStatusComment({
          blockReason: summary,
          nextStep: 'Use /orch continue to keep the existing branch and resolve the conflicts, or /orch retry to reset the branch and re-implement from scratch.',
        }),
        warnMessage: 'Failed to post branch refresh merge-conflict status comment',
      },
      notification: {
        summary,
        blockingReason: 'merge_conflict',
      },
    })
    return { outcome: 'errored', verifyResults: [] }
  }

  if (rebaseResult.error) {
    await runStateController.markError(runId, {
      from: 'running',
      fields: {
        operationIntent,
        lastError: rebaseResult.error,
      },
      comment: {
        body: formatStatusComment({
          blockReason: rebaseResult.error,
          nextStep: `Retry the ${modeLabel} after fixing the underlying git or push error.`,
        }),
        warnMessage: 'Failed to post branch refresh error status comment',
      },
      notification: {
        summary: rebaseResult.error,
      },
    })
    return { outcome: 'errored', verifyResults: [] }
  }

  if (rebaseResult.rebased && rebaseResult.verifyPassed) {
    logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, operationIntent }, 'Branch refresh succeeded, verify passed — returning to review_ready')
    await runStateController.markReviewReady(runId, {
      from: 'running',
      notification: {
        summary: `${isExplicitRebase ? 'Rebased' : 'Refreshed'} successfully, verify passed`,
      },
    })
    return { outcome: 'processed', verifyResults: rebaseResult.verifyResults ?? [] }
  }

  if (!rebaseResult.rebased && rebaseResult.verifyPassed) {
    logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Branch already up to date — returning to review_ready')
    await runStateController.markReviewReady(runId, { from: 'running' })
    return { outcome: 'processed', verifyResults: rebaseResult.verifyResults ?? [] }
  }

  return {
    outcome: 'continue-to-loop',
    verifyResults: rebaseResult.verifyResults ?? [],
  }
}

function resolveUpdateStrategyOverride(
  controlPayload: RunControlPayload | null,
): UpdateStrategy | undefined {
  return controlPayload?.updateStrategy
}
