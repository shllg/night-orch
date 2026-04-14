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
import { postPlanSummaryComment } from '../loop/plan-summary-comment.js'
import { isPlanningIssue } from '../planning/mode.js'
import { finalizeRunOutcome } from '../runner/run-finalizer.js'
import {
  applyRecoveryPlan,
  classifyInfraError,
} from './error-recovery.js'
import { clearResumeDecisionArtifacts } from '../loop/checkpoint.js'
import { PollerNotifier } from './notify-dispatcher.js'
import {
  coerceAgentName,
  isImmediateFollowupStatus,
  applyWorkflowAgentOverrides,
  applyWorkflowRoleDefaults,
  resolveWorkerProfileForAgent,
  extractFollowupPromptFeedback,
  resolveControlPayload,
  resolveOperationIntent,
  selectReplayableRun,
  shouldResetBranch,
  postStatusComment,
} from '../runner/helpers.js'
import { missingCommentCommandIssues } from '../runner/comment-commands.js'
import { reactionCursors } from '../runner/reaction-scan.js'
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
    metrics,
  } = params
  const pollerNotifier = new PollerNotifier(innerNotifier)

  const issueRepo = discoveredIssue.issueRepo || discoveredIssue.issue.repo || repoConfig.repo

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
        const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
        await transitionLabels(
          forge,
          issueRepo,
          discoveredIssue.issue.number,
          latestIssue.labels,
          replayableRun.status,
          'blocked',
          buildLabelConfig(repoConfig, latestIssue.labels),
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

    if (replayableRun && !queuedRun && replayableRun.status === 'review_ready') {
      logger.info(
        { repo: repoConfig.repo, issue: discoveredIssue.issue.number, runId: replayableRun.id },
        'Skipping review_ready run with no queued control action',
      )
      const labelCfg = buildLabelConfig(repoConfig, discoveredIssue.issue.labels)
      const staleAdds = [labelCfg.reviewReady].filter(
        (label) => !discoveredIssue.issue.labels.includes(label),
      )
      const staleRemoves = [
        ...labelCfg.ready,
        labelCfg.running,
        labelCfg.blocked,
        labelCfg.needsHuman,
        labelCfg.error,
        labelCfg.retry,
      ].filter((label) => discoveredIssue.issue.labels.includes(label))
      if (staleAdds.length > 0 || staleRemoves.length > 0) {
        try {
          if (staleAdds.length > 0) {
            await forge.addLabels(issueRepo, discoveredIssue.issue.number, staleAdds)
          }
          if (staleRemoves.length > 0) {
            await forge.removeLabels(issueRepo, discoveredIssue.issue.number, staleRemoves)
          }
        } catch (err) {
          logger.warn(
            { repo: repoConfig.repo, issue: discoveredIssue.issue.number, err },
            'Failed to reconcile labels for skipped review_ready run',
          )
        }
      }
      return { outcome: 'skipped', immediateFollowupRepo: null }
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
    runManager.update(run.id, {
      status: 'running',
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
    })

    // Label transition
    await transitionLabels(
      forge,
      issueRepo,
      discoveredIssue.issue.number,
      discoveredIssue.issue.labels,
      previousRunStatus,
      'running',
      buildLabelConfig(repoConfig, discoveredIssue.issue.labels),
    )

    // Notify
    await pollerNotifier.runStarted(repoConfig.repo, discoveredIssue.issue)

    const operationIntent = resolveOperationIntent(activeRun)
    const controlPayload = resolveControlPayload(activeRun)
    const updateStrategyOverride = resolveUpdateStrategyOverride(controlPayload)
    const isRebaseRun = operationIntent === 'rebase'
    const isContinueRun = operationIntent === 'continue'
    const isFreshRetry = operationIntent === 'retry'
    const followupPromptFeedback = extractFollowupPromptFeedback(activeRun?.phaseData)

    // Check if prior run left tainted work that should be discarded
    const planningMode = isPlanningIssue(discoveredIssue.issue.labels, repoConfigForRun)
    const preserveBranchState = Boolean(controlPayload?.preserveBranchState)
      || isRebaseRun
      || (isContinueRun && updateStrategyOverride === undefined)
    const resetToBase = isFreshRetry
      || (operationIntent === 'auto'
        && !isRebaseRun
        && (planningMode || shouldResetBranch(runManager, repoConfig.repo, discoveredIssue.issue.number, run.id)))

    // Create worktree
    await worktreeManager.ensure({
      repoLocalPath: repoConfig.localPath,
      baseBranch: repoConfig.baseBranch,
      branchName: branch,
      worktreePath,
      resetToBase,
      preserveBranchState,
      updateStrategy: updateStrategyOverride ?? repoConfig.updateStrategy,
    })

    // Execute rebase if this is a rebase-queued run
    if (isRebaseRun) {
      const rebaseOutcome = await handleRebaseRun({
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
        metrics,
      })
      if (rebaseOutcome !== 'continue-to-loop') {
        outcome = rebaseOutcome
        return {
          outcome,
          immediateFollowupRepo: computeImmediateFollowup(runManager, runId),
        }
      }
      logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Rebase done but verify failed — entering code loop to fix')
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
      repoConfig: repoConfigForRun,
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
      iteration: startingIteration,
      totalAgentPasses: 0,
      estimatedCostUsd: 0,
      currentPhase: workflow.steps[0]?.id ?? 'plan',
      terminalStatus: 'running',
      phaseHistory: [],
      dryRun: false,
      runMode: isRebaseRun ? 'rebase' : isContinueRun || followupPromptFeedback ? 'followup' : 'fresh',
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
          runManager.update(run.id, { status: 'review_ready', endedAt: nowUtcIso() })
          const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
          await transitionLabels(
            forge,
            issueRepo,
            discoveredIssue.issue.number,
            latestIssue.labels,
            'running',
            'review_ready',
            buildLabelConfig(repoConfig, latestIssue.labels),
          )
          await pollerNotifier.prReady(repoConfig.repo, discoveredIssue.issue, {
            summary: `Decomposed into ${decomposition.subtasks.length} sub-tasks, all completed`,
          })
          outcome = 'processed'
        } else {
          const failed = subResults.filter((r) => !r.success).length
          runManager.update(run.id, {
            status: 'blocked',
            lastError: `${failed}/${decomposition.subtasks.length} sub-tasks failed`,
            endedAt: nowUtcIso(),
          })
          const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
          await transitionLabels(
            forge,
            issueRepo,
            discoveredIssue.issue.number,
            latestIssue.labels,
            'running',
            'blocked',
            buildLabelConfig(repoConfig, latestIssue.labels),
          )
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
    const finalCtx = await executeLoop(initialCtx, {
      db,
      config,
      adapters: {
        planner: createWorkerAdapter(plannerProfile),
        coder: createWorkerAdapter(coderProfile),
        reviewer: createWorkerAdapter(reviewerProfile),
      },
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
    })

    outcome = finalizerOutcome === 'processed' ? 'processed' : 'errored'

    try {
      await observability.closeRun(run.id)
    } catch (closeErr) {
      logger.debug({ runId: run.id, err: closeErr }, 'closeRun failed (best-effort)')
    }
    cleanupRunCaches(repoConfig.repo, discoveredIssue.issue.number)

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
function cleanupRunCaches(repo: string, issueNumber: number): void {
  const key = `${repo}#${issueNumber}`
  missingCommentCommandIssues.delete(key)
  reactionCursors.delete(key)
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

// --- Rebase flow extracted from the inline body for readability ---

interface HandleRebaseRunParams {
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
  controlPayload: Record<string, unknown> | null
  updateStrategyOverride?: UpdateStrategy
  metrics?: MetricsService
}

type RebaseOutcome = 'continue-to-loop' | 'processed' | 'errored'

async function handleRebaseRun(params: HandleRebaseRunParams): Promise<RebaseOutcome> {
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
    updateStrategyOverride,
    metrics,
  } = params

  logger.info(
    { repo: repoConfig.repo, issue: discoveredIssue.issue.number, runId },
    'Executing rebase for queued rebase run',
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
    controlPayload?.['checkAfter'] !== false,
    updateStrategyOverride ?? 'rebase',
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
    runManager.update(runId, {
      status: 'blocked',
      blockReason: 'merge_conflict',
      operationIntent: 'rebase',
      manualState: 'awaiting_rebase_resolution',
      controlPayload: {
        issueRepo,
        preserveBranchState: true,
        conflictSummary: rebaseResult.conflictAnalysis?.summary ?? 'Rebase conflicted with the latest base branch changes.',
        conflictFiles: rebaseResult.conflictAnalysis?.files ?? [],
        conflictExcerpts: rebaseResult.conflictAnalysis?.excerpts ?? [],
        resolutionAttempted: rebaseResult.resolution?.attempted ?? false,
        resolutionOutcome: rebaseResult.resolution?.outcome ?? null,
        resolvedFiles: rebaseResult.resolution?.files ?? [],
        requestedAt: nowUtcIso(),
      },
      lastError: rebaseResult.conflictAnalysis?.summary
        ?? 'Rebase failed due to merge conflicts. Continue will keep the branch and resolve them; retry will reset to base and re-implement.',
      endedAt: nowUtcIso(),
    })
    const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
    await transitionLabels(
      forge,
      issueRepo,
      discoveredIssue.issue.number,
      latestIssue.labels,
      'running',
      'blocked',
      buildLabelConfig(repoConfig, latestIssue.labels),
      blocked({
        type: 'mergeConflict',
        files: rebaseResult.conflictAnalysis?.files ?? [],
        summary: rebaseResult.conflictAnalysis?.summary
          ?? 'Rebase failed due to merge conflicts',
      }).reason,
    )
    await postStatusComment({
      forge,
      issueRepo,
      issueNumber: discoveredIssue.issue.number,
      botUser,
      body: formatStatusComment({
        blockReason: rebaseResult.conflictAnalysis?.summary
          ?? 'Rebase failed due to merge conflicts while replaying the branch onto the latest base.',
        nextStep: 'Use /orch continue to keep the existing branch and resolve the conflicts, or /orch retry to reset the branch and re-implement from scratch.',
      }),
      warnMessage: 'Failed to post rebase merge-conflict status comment',
    })
    await pollerNotifier.blocked(repoConfig.repo, discoveredIssue.issue, {
      summary: 'Rebase failed due to merge conflicts',
      blockingReason: 'merge_conflict',
    })
    return 'errored'
  }

  if (rebaseResult.error) {
    runManager.update(runId, {
      status: 'error',
      operationIntent: 'rebase',
      lastError: rebaseResult.error,
      endedAt: nowUtcIso(),
    })
    const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
    await transitionLabels(
      forge,
      issueRepo,
      discoveredIssue.issue.number,
      latestIssue.labels,
      'running',
      'error',
      buildLabelConfig(repoConfig, latestIssue.labels),
    )
    await postStatusComment({
      forge,
      issueRepo,
      issueNumber: discoveredIssue.issue.number,
      botUser,
      body: formatStatusComment({
        blockReason: rebaseResult.error,
        nextStep: 'Retry the rebase after fixing the underlying git or push error.',
      }),
      warnMessage: 'Failed to post rebase error status comment',
    })
    await pollerNotifier.error(repoConfig.repo, discoveredIssue.issue, {
      summary: rebaseResult.error,
    })
    return 'errored'
  }

  if (rebaseResult.rebased && rebaseResult.verifyPassed) {
    logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Rebase succeeded, verify passed — returning to review_ready')
    runManager.update(runId, {
      status: 'review_ready',
      endedAt: nowUtcIso(),
      lastError: null,
    })
    const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
    await transitionLabels(
      forge,
      issueRepo,
      discoveredIssue.issue.number,
      latestIssue.labels,
      'running',
      'review_ready',
      buildLabelConfig(repoConfig, latestIssue.labels),
    )
    await pollerNotifier.prReady(repoConfig.repo, discoveredIssue.issue, {
      summary: 'Rebased successfully, verify passed',
    })
    return 'processed'
  }

  if (!rebaseResult.rebased && rebaseResult.verifyPassed) {
    logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Branch already up to date — returning to review_ready')
    runManager.update(runId, {
      status: 'review_ready',
      endedAt: nowUtcIso(),
      lastError: null,
    })
    const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
    await transitionLabels(
      forge,
      issueRepo,
      discoveredIssue.issue.number,
      latestIssue.labels,
      'running',
      'review_ready',
      buildLabelConfig(repoConfig, latestIssue.labels),
    )
    return 'processed'
  }

  return 'continue-to-loop'
}

function resolveUpdateStrategyOverride(
  controlPayload: Record<string, unknown> | null,
): UpdateStrategy | undefined {
  const raw = controlPayload?.['updateStrategy']
  return raw === 'merge' || raw === 'rebase' ? raw : undefined
}
