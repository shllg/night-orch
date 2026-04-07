import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { MetricsService } from '../metrics/service.js'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager } from '../state/runs.js'
import { IssueManager } from '../state/issues.js'
import { discoverEligibleIssues } from '../discovery/discover.js'
import { resolveRoles } from '../discovery/roles.js'
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
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { NotificationDispatcher } from '../notify/dispatcher.js'
import { createChannels } from '../notify/factory.js'
import { CostTracker } from '../loop/cost.js'
import { branchName } from '../utils/ids.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import type { RunContext } from '../loop/types.js'
import { postPlanSummaryComment } from '../loop/plan-summary-comment.js'
import { executeRebase } from '../ops/rebase-and-check.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'
import { processMergeQueue } from '../merge-queue/runner.js'
import { decomposeIssue, shouldAttemptDecompose } from '../discovery/decomposer.js'
import { executeParallelSubtasks } from '../loop/parallel.js'
import { buildWorkerEnv } from '../workers/env.js'
import { isPlanningIssue } from '../planning/mode.js'
import type { AgentEvent } from '../events/types.js'
import {
  AgentObservability,
  setActiveAgentObservability,
  clearActiveAgentObservability,
} from '../events/observability.js'

// Extracted modules
import { finalizeRunOutcome } from './run-finalizer.js'
import { processCommentCommands, missingCommentCommandIssues } from './comment-commands.js'
import { scanAndHandleReactions, reactionCursors } from './reaction-scan.js'
import {
  coerceAgentName,
  isImmediateFollowupStatus,
  applyWorkflowAgentOverrides,
  applyWorkflowRoleDefaults,
  resolveWorkerProfileForAgent,
  extractFollowupPromptFeedback,
  prioritizeDiscoveredIssues,
  selectReplayableRun,
  shouldResetBranch,
  makePayload,
  postStatusComment,
  postErrorStatusComment,
  toErrorMessage,
  sanitizeErrorForComment,
} from './helpers.js'

const STATUS_MARKER = markerTag('status')

export interface PollResult {
  processed: number
  errors: number
  immediateFollowupRepos: string[]
}

export interface PollTargetIssue {
  repo: string
  issueNumber: number
}

/**
 * Evict entries from process-global caches that are keyed by repo+issue.
 * Called when a run reaches a terminal state so the caches don't grow
 * unbounded over the daemon's lifetime.
 */
function cleanupRunCaches(repo: string, issueNumber: number): void {
  const key = `${repo}#${issueNumber}`
  missingCommentCommandIssues.delete(key)
  reactionCursors.delete(key)
}

/**
 * Process one poll cycle: discover eligible issues, claim and process.
 * Repositories are processed in parallel; each repo runs up to
 * `repo.maxConcurrentRuns` issues concurrently (default: 1).
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
  const issueManager = new IssueManager(db)
  const worktreeManager = createWorktreeManager()
  const costTracker = new CostTracker(db)

  let processed = 0
  let errors = 0
  const immediateFollowupRepos = new Set<string>()
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

    const reposToProcess = targetIssue
      ? config.repos.filter((repoConfig) => {
          const issueRepos = new Set([repoConfig.repo, ...(repoConfig.linkedProjects ?? [])])
          return issueRepos.has(targetIssue.repo)
        })
      : config.repos
    const usedPortsInPass: number[] = []

    const repoResults = await Promise.all(
      reposToProcess.map(async (repoConfig): Promise<PollResult> => {
        let repoProcessed = 0
        let repoErrors = 0
        const repoImmediateFollowupRepos = new Set<string>()
        try {
          const forge = createForgeAdapter(repoConfig, config)
          const channels = createChannels(config.notifications, forge)
          const notifier = new NotificationDispatcher(channels, config.notifications.events)

          // Resolve bot user for comment upserts (best-effort, fallback to empty string)
          let botUser = ''
          try {
            const authInfo = await forge.validateAuth()
            botUser = authInfo.user
          } catch {
            logger.debug({ repo: repoConfig.repo }, 'Could not resolve bot user for comment upserts')
          }

          // --- Reaction scan: check review_ready PRs for CI failures or human reviews ---
          try {
            await scanAndHandleReactions({
              db, forge, runManager, repoConfig, botUser,
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

          // --- Comment commands: /orch retry|rebase|continue|cancel ---
          try {
            await processCommentCommands({
              config,
              db,
              forge,
              runManager,
              leaseManager,
              repoConfig,
              botUser,
            })
          } catch (err) {
            logger.warn({ repo: repoConfig.repo, err }, 'Comment command processing failed — continuing')
          }

          const discoveredAll = await discoverEligibleIssues(repoConfig, forge, leaseManager)
          const discovered = targetIssue
            ? discoveredAll.filter((d) => {
                const issueRepo = d.issueRepo || d.issue.repo || repoConfig.repo
                return d.issue.number === targetIssue.issueNumber && issueRepo === targetIssue.repo
              })
            : prioritizeDiscoveredIssues(runManager, repoConfig.repo, discoveredAll)

          issueManager.upsertDiscovered(
            discovered.map((d) => ({
              repo: d.issueRepo || d.issue.repo || repoConfig.repo,
              issueNumber: d.issue.number,
              issueNodeId: d.issue.nodeId,
              issueTitle: d.issue.title,
            })),
          )
          try { metrics?.setEligibleIssues(repoConfig.repo, discovered.length) } catch { /* best-effort */ }

          if (discovered.length === 0) {
            logger.debug({ repo: repoConfig.repo }, 'No eligible issues')
            return {
              processed: repoProcessed,
              errors: repoErrors,
              immediateFollowupRepos: [],
            }
          }

          if (dryRun) {
            for (const d of discovered) {
              logger.info({ issue: d.issue.number, triage: d.triage.level, title: d.issue.title }, '[dry-run] Discovered issue')
            }
            return {
              processed: repoProcessed,
              errors: repoErrors,
              immediateFollowupRepos: [],
            }
          }

          const maxConcurrentRuns = targetIssue ? 1 : (repoConfig.maxConcurrentRuns ?? 1)
          const discoveredQueue = [...discovered]
          const workerCount = Math.min(maxConcurrentRuns, discoveredQueue.length)

          await Promise.all(
            Array.from({ length: workerCount }, async () => {
              while (true) {
                const discoveredIssue = discoveredQueue.shift()
                if (!discoveredIssue) {
                  break
                }
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
                  continue
                }

                if (!leaseManager.acquire(issueRepo, discoveredIssue.issue.number, 'poller', 1800)) {
                  continue
                }

                let runId: string | null = null
                let envSetup: EnvSetupResult | null = null
                let activeWorktreePath: string | null = null

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
                      ...(run.phaseData ?? {}),
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
                  await notifier.dispatch(makePayload('run_started', repoConfig.repo, discoveredIssue.issue))

                  // Detect if this queued run needs a forced branch reset (e.g., after merge conflict)
                  const forceReset = activeRun?.blockReason === 'merge_conflict'

                  // Detect rebase mode from queued run's phaseData
                  const reactionType = activeRun?.phaseData?.reactionType
                  const isRebaseRun = !forceReset && (reactionType === 'rebase' || reactionType === 'merge_conflict')
                  const followupPromptFeedback = extractFollowupPromptFeedback(activeRun?.phaseData)

                  // Check if prior run left tainted work that should be discarded
                  const planningMode = isPlanningIssue(discoveredIssue.issue.labels, repoConfigForRun)
                  const resetToBase = forceReset || (!isRebaseRun && (planningMode || shouldResetBranch(runManager, repoConfig.repo, discoveredIssue.issue.number, run.id)))

                  // Create worktree
                  await worktreeManager.ensure({
                    repoLocalPath: repoConfig.localPath,
                    baseBranch: repoConfig.baseBranch,
                    branchName: branch,
                    worktreePath,
                    resetToBase,
                    updateStrategy: repoConfig.updateStrategy,
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
                    issueRepo,
                    discoveredIssue.issue.number,
                    verifyCommands,
                    repoConfig.updateStrategy,
                  )

                  if (rebaseResult.conflict) {
                    runManager.update(run.id, {
                      status: 'blocked',
                      blockReason: 'merge_conflict',
                      lastError: 'Rebase failed due to merge conflicts — retry will reset the branch and re-implement from scratch',
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
                      'merge_conflict',
                    )
                    await postStatusComment({
                      forge,
                      issueRepo,
                      issueNumber: discoveredIssue.issue.number,
                      botUser,
                      body: formatStatusComment({
                        blockReason: 'Rebase failed due to merge conflicts while replaying the branch onto the latest base.',
                        nextStep: 'Run /orch retry to reset the branch to base and re-implement on top of latest main.',
                      }),
                      warnMessage: 'Failed to post rebase merge-conflict status comment',
                    })
                    await notifier.dispatch(makePayload('blocked', repoConfig.repo, discoveredIssue.issue, {
                      summary: 'Rebase failed due to merge conflicts',
                      blockingReason: 'merge_conflict',
                    }))
                    leaseManager.release(issueRepo, discoveredIssue.issue.number)
                    repoErrors++
                    continue
                  }

                  if (rebaseResult.rebased && rebaseResult.verifyPassed) {
                    logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Rebase succeeded, verify passed — returning to review_ready')
                    runManager.update(run.id, {
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
                    await notifier.dispatch(makePayload('pr_ready', repoConfig.repo, discoveredIssue.issue, {
                      summary: 'Rebased successfully, verify passed',
                    }))
                    leaseManager.release(issueRepo, discoveredIssue.issue.number)
                    repoProcessed++
                    continue
                  }

                  if (!rebaseResult.rebased && rebaseResult.verifyPassed) {
                    logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Branch already up to date — returning to review_ready')
                    runManager.update(run.id, {
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
                    leaseManager.release(issueRepo, discoveredIssue.issue.number)
                    repoProcessed++
                    continue
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
                const plannerProfile = resolveWorkerProfileForAgent(
                  roles.planner,
                  repoConfigForRun,
                  config,
                )
                const coderProfile = resolveWorkerProfileForAgent(
                  roles.coder,
                  repoConfigForRun,
                  config,
                )
                const reviewerProfile = resolveWorkerProfileForAgent(
                  roles.reviewer,
                  repoConfigForRun,
                  config,
                )

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
                  runMode: isRebaseRun ? 'rebase' : followupPromptFeedback ? 'followup' : 'fresh',
                  blockReason: null,
                  prReviewFeedback: followupPromptFeedback,
                  sessionIds: {},
                  stepOutputs: {},
                  iterationSnapshots: [],
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
                      await notifier.dispatch(makePayload('pr_ready', repoConfig.repo, discoveredIssue.issue, {
                        summary: `Decomposed into ${decomposition.subtasks.length} sub-tasks, all completed`,
                      }))
                      repoProcessed++
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
                      repoErrors++
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
                const outcome = await finalizeRunOutcome({
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
                  notifier,
                  metrics,
                  maxAutoRetries: config.loop.maxAutoRetries,
                  botUser,
                })

                if (outcome === 'processed') repoProcessed++
                else repoErrors++

                try {
                  await observability.closeRun(run.id)
                } catch (closeErr) {
                  logger.debug({ runId: run.id, err: closeErr }, 'closeRun failed (best-effort)')
                }
                cleanupRunCaches(repoConfig.repo, discoveredIssue.issue.number)
                } catch (err) {
                  logger.error({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err }, 'Failed to process issue')
                  if (runId) {
                    const errorMessage = toErrorMessage(err)
                    const existing = runManager.getById(runId)
                    const currentRetries = existing?.retryCount ?? 0
                    const maxRetries = config.loop.maxAutoRetries
                    const canAutoRetry = currentRetries < maxRetries
                    const attemptCount = currentRetries + 1

                    runManager.update(runId, {
                      status: 'error',
                      lastError: errorMessage,
                      endedAt: nowUtcIso(),
                    })

                    if (canAutoRetry) {
                      runManager.incrementRetryCount(runId)
                      logger.info(
                        { repo: repoConfig.repo, issue: discoveredIssue.issue.number, attempt: attemptCount, maxRetries },
                        'Infra error — auto-retrying (transitioning back to ready)',
                      )
                      try {
                        const latestIssue = await forge.getIssue(issueRepo, discoveredIssue.issue.number)
                        await transitionLabels(
                          forge,
                          issueRepo,
                          discoveredIssue.issue.number,
                          latestIssue.labels,
                          'running',
                          'queued',
                          buildLabelConfig(repoConfig, latestIssue.labels),
                        )
                      } catch (labelErr) {
                        logger.warn({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err: labelErr }, 'Failed to transition labels for auto-retry')
                      }
                      await postErrorStatusComment({
                        forge,
                        issueRepo,
                        issueNumber: discoveredIssue.issue.number,
                        botUser,
                        error: `Attempt ${attemptCount} failed. Last error: ${errorMessage}`,
                        retryCount: attemptCount,
                        maxRetries,
                        nextStep: 'Automatic retry queued. night-orch will retry this issue on the next poll cycle.',
                        warnMessage: 'Failed to post auto-retry status comment',
                      })
                    } else {
                      logger.warn(
                        { repo: repoConfig.repo, issue: discoveredIssue.issue.number, currentRetries, maxRetries },
                        'Auto-retry limit reached — marking as error',
                      )
                      try {
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
                      } catch (labelErr) {
                        logger.warn({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err: labelErr }, 'Failed to transition labels after retry exhaustion')
                      }
                      await postErrorStatusComment({
                        forge,
                        issueRepo,
                        issueNumber: discoveredIssue.issue.number,
                        botUser,
                        error: `Failed after ${attemptCount} attempts. Last error: ${errorMessage}`,
                        retryCount: attemptCount,
                        maxRetries,
                        nextStep: 'Manual action required: inspect the failure, then run /orch retry or /orch continue.',
                        warnMessage: 'Failed to post retry-exhausted status comment',
                      })
                      const sanitizedErrorForSummary = sanitizeErrorForComment(errorMessage)
                      try {
                        await notifier.dispatch(makePayload('retry_exhausted', repoConfig.repo, discoveredIssue.issue, {
                          summary: `Failed after ${attemptCount} attempts: ${sanitizedErrorForSummary}`,
                        }))
                      } catch (notifyErr) {
                        logger.warn({ repo: repoConfig.repo, issue: discoveredIssue.issue.number, err: notifyErr }, 'Failed to send retry exhaustion notification')
                      }
                    }
                  }
                  repoErrors++
                } finally {
                  if (runId) {
                    const finalRun = runManager.getById(runId)
                    if (finalRun && isImmediateFollowupStatus(finalRun.status)) {
                      repoImmediateFollowupRepos.add(finalRun.repo)
                    }
                  }

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
            }),
          )

          return {
            processed: repoProcessed,
            errors: repoErrors,
            immediateFollowupRepos: [...repoImmediateFollowupRepos],
          }
        } catch (err) {
          logger.error({ repo: repoConfig.repo, err }, 'Repository poll failed')
          return {
            processed: repoProcessed,
            errors: repoErrors + 1,
            immediateFollowupRepos: [...repoImmediateFollowupRepos],
          }
        }
      }),
    )

    for (const repoResult of repoResults) {
      processed += repoResult.processed
      errors += repoResult.errors
      for (const repo of repoResult.immediateFollowupRepos) {
        immediateFollowupRepos.add(repo)
      }
    }

    return { processed, errors, immediateFollowupRepos: [...immediateFollowupRepos] }
  } finally {
    clearActiveAgentObservability(observability)
    await observability.close()
  }
}
