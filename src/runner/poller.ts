import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { MetricsService } from '../metrics/service.js'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager, type RunRecord } from '../state/runs.js'
import { IssueManager } from '../state/issues.js'
import { discoverEligibleIssues, type DiscoveredIssue } from '../discovery/discover.js'
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
import { resolveWorkflow, type ResolvedWorkflow } from '../loop/workflow.js'
import { publishPR } from '../publishing/publisher.js'
import { MergeConflictError } from '../publishing/push.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { NotificationDispatcher } from '../notify/dispatcher.js'
import { createChannels } from '../notify/factory.js'
import { CostTracker } from '../loop/cost.js'
import { branchName } from '../utils/ids.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import type { RunContext, BlockReason } from '../loop/types.js'
import type { NotificationPayload } from '../notify/types.js'
import { postPlanSummaryComment } from '../loop/plan-summary-comment.js'
import { executeRebase, queueRebase } from '../ops/rebase-and-check.js'
import { queueContinue } from '../ops/continue.js'
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
import { resolveIssueRepo } from '../utils/issue-repo.js'
import {
  isCommandProcessed,
  markCommandProcessed,
  parseOrchCommands,
  type OrchCommand,
} from '../discovery/commands.js'
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
  immediateFollowupRepos: string[]
}

export interface PollTargetIssue {
  repo: string
  issueNumber: number
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

                // Lease duration is deliberately short (30 min) so a
                // crashed poller's leases expire promptly. The engine
                // bumps the deadline on every phase checkpoint via
                // leaseHeartbeat below, so a long run is not at risk of
                // expiring mid-work.
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
                  // If force-resetting, ignore stale rebase context — we're starting fresh
                  const reactionType = activeRun?.phaseData?.reactionType
                  const isRebaseRun = !forceReset && (reactionType === 'rebase' || reactionType === 'merge_conflict')
                  const followupPromptFeedback = extractFollowupPromptFeedback(activeRun?.phaseData)

                  // Check if prior run left tainted work that should be discarded
                  // Never reset to base for rebase runs — we need the existing branch
                  const planningMode = isPlanningIssue(discoveredIssue.issue.labels, repoConfigForRun)
                  const resetToBase = forceReset || (!isRebaseRun && (planningMode || shouldResetBranch(runManager, repoConfig.repo, discoveredIssue.issue.number, run.id)))

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
                    issueRepo,
                    discoveredIssue.issue.number,
                    verifyCommands,
                  )

                  if (rebaseResult.conflict) {
                    // Rebase had conflicts — block the run; retry will reset the branch and re-implement
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
                    // Rebase succeeded and verify passes — done, transition back to review_ready
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
                    // Already up-to-date and verify passes — nothing to do
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

                  // Rebase succeeded but verify failed — fall through to the loop engine
                  // so the coder can fix the issues introduced by upstream changes
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

                // Release per-run observability resources (session log
                // streams + event bus history) once the run has reached
                // a terminal state — without this both Maps grow for the
                // daemon's entire lifetime.
                try {
                  await observability.closeRun(run.id)
                } catch (closeErr) {
                  logger.debug({ runId: run.id, err: closeErr }, 'closeRun failed (best-effort)')
                }
                // Evict per-issue caches so they don't grow unbounded.
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
                      // Bump retry_count on the same row so repeated replay
                      // retries converge on maxRetries. Without this the
                      // same run row cycles error → queued → error forever.
                      runManager.incrementRetryCount(runId)

                      // Auto-retry: transition back to queued so the next poll picks it up
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
                      // Retries exhausted: mark as error, require human
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

interface FinalizeRunOutcomeParams {
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
      runManager.update(runId, {
        status: 'review_ready',
        iterationCount: finalCtx.iteration,
        prNumber: publishResult.prNumber,
        prTitle: publishResult.prTitle,
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

      // Merge conflicts during push get structured block reason so retry resets the branch
      if (err instanceof MergeConflictError) {
        runManager.update(runId, {
          status: 'blocked',
          iterationCount: finalCtx.iteration,
          blockReason: 'merge_conflict',
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
          'merge_conflict',
        )
        await postStatusComment({
          forge,
          issueRepo,
          issueNumber,
          botUser,
          body: formatStatusComment({
            blockReason: 'Publish failed due to merge conflicts while pushing branch updates.',
            nextStep: 'Run /orch retry to reset the branch to base and re-implement on top of latest main.',
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
      runManager.update(runId, { status: 'error', iterationCount: finalCtx.iteration, lastError: errorMessage, endedAt: nowUtcIso() })
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
          nextStep: 'Manual action required: inspect the failure, then run /orch retry or /orch continue.',
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
    runManager.update(runId, {
      status: 'blocked',
      iterationCount: finalCtx.iteration,
      lastError: blockReason,
      blockReason: finalCtx.blockReason ?? null,
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
      finalCtx.blockReason ?? undefined,
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
  runManager.update(runId, { status: 'error', iterationCount: finalCtx.iteration, lastError: unexpectedError, endedAt: nowUtcIso() })
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
      nextStep: 'Manual action required: inspect the failure, then run /orch retry or /orch continue.',
      warnMessage: 'Failed to post unexpected-state retry-exhausted status comment',
    })
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

function isImmediateFollowupStatus(status: RunRecord['status']): boolean {
  return status === 'review_ready'
    || status === 'blocked'
    || status === 'error'
    || status === 'completed'
}

function applyWorkflowAgentOverrides(
  repoConfig: Config['repos'][number],
  workflow: ResolvedWorkflow,
): Config['repos'][number] {
  if (!workflow.agents || Object.keys(workflow.agents).length === 0) {
    return repoConfig
  }

  return {
    ...repoConfig,
    agents: {
      ...repoConfig.agents,
      ...workflow.agents,
    },
  }
}

function applyWorkflowRoleDefaults(
  repoDefaults: Config['repos'][number]['defaults'],
  workflow: ResolvedWorkflow,
  repoConfig: Config['repos'][number],
  config: Config,
): Config['repos'][number]['defaults'] {
  if (!workflow.roles) {
    return repoDefaults
  }

  const merged: Config['repos'][number]['defaults'] = {
    ...repoDefaults,
    ...workflow.roles,
  }

  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const preferredAgent = merged[role]
    if (canResolveAgent(preferredAgent, repoConfig, config)) continue
    merged[role] = repoDefaults[role]
  }

  return merged
}

function canResolveAgent(
  agent: Config['repos'][number]['defaults']['planner'],
  repoConfig: Config['repos'][number],
  config: Config,
): boolean {
  return resolveWorkerProfileForAgent(agent, repoConfig, config) !== null
}

function resolveWorkerProfileForAgent(
  agent: Config['repos'][number]['defaults']['planner'],
  repoConfig: Config['repos'][number],
  config: Config,
): Config['workerProfiles'][string] | null {
  const mappedProfileName = repoConfig.agents[agent]
  if (mappedProfileName) {
    const mappedProfile = config.workerProfiles[mappedProfileName]
    if (mappedProfile) return mappedProfile
  }

  return Object.values(config.workerProfiles).find((profile) => profile.type === agent) ?? null
}

function buildBlockReason(ctx: RunContext): string {
  const blockMessage = ctx.stepOutputs?.['blockMessage']
  if (typeof blockMessage === 'string' && blockMessage.trim().length > 0) {
    return blockMessage
  }

  if (ctx.reviewResult) {
    const findings = ctx.reviewResult.findings
      .filter((f) => f.severity === 'critical' || f.severity === 'major')
      .map((f) => `[${f.severity}] ${f.message}`)
      .join('; ')
    return findings
      ? `${ctx.reviewResult.summary} — ${findings}`
      : ctx.reviewResult.summary
  }

  if (ctx.blockReason) {
    return blockReasonSummary(ctx.blockReason, ctx)
  }

  return `Blocked in phase ${ctx.currentPhase} (no review result available)`
}

function blockReasonSummary(reason: BlockReason, ctx: RunContext): string {
  switch (reason) {
    case 'cost_limit':
      // The engine writes a precise, limit-specific message into stepOutputs.blockMessage
      // (see src/loop/engine.ts cost check). This branch is only reached when that
      // structured message is missing — keep it vague so we do not claim the per-run
      // limit tripped when it might have been the daily cap.
      return `Cost limit exceeded for this run (estimated run cost: $${ctx.estimatedCostUsd.toFixed(4)})`
    case 'iteration_limit':
      return `Maximum review iterations reached (${ctx.iteration}/${ctx.adjustedLimits.maxReviewIterations})`
    case 'agent_pass_limit':
      return `Maximum total agent passes reached (${ctx.totalAgentPasses}/${ctx.adjustedLimits.maxTotalAgentPasses})`
    case 'reviewer_blocked':
      return 'Reviewer marked this run as blocked'
    case 'ambiguous_review':
      return 'Review output was not parseable and blockOnAmbiguousReview is enabled'
    case 'verify_config':
      return 'Verification is required but verify commands or results are unavailable'
    case 'merge_conflict':
      return 'Merge conflict encountered while applying updates'
    default:
      return `Blocked in phase ${ctx.currentPhase}`
  }
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
  issue: { number: number; title: string; url?: string },
  extra: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    event,
    repo,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.url ?? null,
    state: event,
    prUrl: null,
    prNumber: null,
    summary: `${event}: #${issue.number} ${issue.title}`,
    blockingReason: null,
    reviewSummary: null,
    iterationCount: 0,
    timestamp: nowUtcIso(),
    ...extra,
  }
}

interface PostStatusCommentParams {
  forge: ReturnType<typeof createForgeAdapter>
  issueRepo: string
  issueNumber: number
  botUser: string
  body: string
  warnMessage: string
}

async function postStatusComment(params: PostStatusCommentParams): Promise<void> {
  const {
    forge,
    issueRepo,
    issueNumber,
    botUser,
    body,
    warnMessage,
  } = params

  try {
    if (botUser) {
      await upsertBotComment(forge, issueRepo, issueNumber, STATUS_MARKER, body, botUser)
    } else {
      await forge.commentOnIssue(issueRepo, issueNumber, body)
    }
  } catch (commentErr) {
    logger.warn({ repo: issueRepo, issueNumber, err: commentErr }, warnMessage)
  }
}

interface PostErrorStatusCommentParams {
  forge: ReturnType<typeof createForgeAdapter>
  issueRepo: string
  issueNumber: number
  botUser: string
  error: string
  retryCount: number
  maxRetries: number
  nextStep: string
  warnMessage: string
}

const ERROR_COMMENT_MAX_LENGTH = 400
const TOKEN_REDACTION_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
]

async function postErrorStatusComment(params: PostErrorStatusCommentParams): Promise<void> {
  const {
    forge,
    issueRepo,
    issueNumber,
    botUser,
    error,
    retryCount,
    maxRetries,
    nextStep,
    warnMessage,
  } = params

  const sanitizedError = sanitizeErrorForComment(error)
  const body = formatStatusComment({
    error: sanitizedError,
    retryCount,
    maxRetries,
    nextStep,
  })

  await postStatusComment({
    forge,
    issueRepo,
    issueNumber,
    botUser,
    body,
    warnMessage,
  })
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim().length > 0) {
    return err.message
  }
  return String(err)
}

function sanitizeErrorForComment(errorMessage: string): string {
  let sanitized = errorMessage
    .replace(/[\r\n]+/g, ' ')
  sanitized = stripControlChars(sanitized)
  sanitized = sanitized
    .replace(/\b(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .trim()

  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }

  sanitized = sanitized.replace(/\s+/g, ' ').trim()
  if (!sanitized) return 'unknown error'

  const clipped = sanitized.length > ERROR_COMMENT_MAX_LENGTH
    ? `${sanitized.slice(0, ERROR_COMMENT_MAX_LENGTH - 1)}…`
    : sanitized

  return escapeMarkdownForComment(clipped)
}

function escapeMarkdownForComment(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_#[\]])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200B')
}

function stripControlChars(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if ((code >= 0 && code <= 31) || code === 127) {
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

interface ProcessCommentCommandsParams {
  config: Config
  db: Database.Database
  forge: ReturnType<typeof createForgeAdapter>
  runManager: RunManager
  leaseManager: LeaseManager
  repoConfig: Config['repos'][0]
  botUser: string
}

/** Issues that returned 404 during comment scan in this process lifecycle.
 *  Bounded: entries are evicted when the key's run reaches a terminal state
 *  via {@link cleanupRunCaches}. */
const missingCommentCommandIssues = new Set<string>()

function getHttpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { status?: unknown; response?: { status?: unknown } }
  if (typeof e.status === 'number') return e.status
  if (typeof e.response?.status === 'number') return e.response.status
  return null
}

async function processCommentCommands(params: ProcessCommentCommandsParams): Promise<void> {
  const {
    config,
    db,
    forge,
    runManager,
    leaseManager,
    repoConfig,
    botUser,
  } = params

  const commandSettings = config.commentCommands ?? { enabled: true, requireCollaborator: false }
  if (!commandSettings.enabled) return
  // Warn once per poll when comment commands accept non-collaborators —
  // for public repos this means any GitHub user can trigger retry/rebase/
  // continue/delete operations.
  if (!commandSettings.requireCollaborator) {
    logger.warn(
      { repo: repoConfig.repo },
      'commentCommands.requireCollaborator=false — /orch commands accept any commenter. Enable on public repos.',
    )
  }

  const activeRuns = runManager
    .getActive()
    .filter((run) => run.repo === repoConfig.repo)

  const issueRows = [...new Map(
    activeRuns.map((run) => {
      const issueRepo = resolveIssueRepo(run.phaseData, repoConfig.repo)
      return [`${issueRepo}#${run.issueNumber}`, { issue_number: run.issueNumber, issue_repo: issueRepo }] as const
    }),
  ).values()]
    .sort((a, b) => a.issue_repo.localeCompare(b.issue_repo) || a.issue_number - b.issue_number)

  if (issueRows.length === 0) return

  const collaboratorCache = new Map<string, boolean>()

  for (const row of issueRows) {
    const issueKey = `${row.issue_repo}#${row.issue_number}`
    if (missingCommentCommandIssues.has(issueKey)) {
      continue
    }

    let comments: Awaited<ReturnType<typeof forge.listIssueComments>>
    try {
      comments = await forge.listIssueComments(row.issue_repo, row.issue_number)
    } catch (err) {
      if (getHttpStatus(err) === 404) {
        missingCommentCommandIssues.add(issueKey)
        logger.debug(
          { repo: row.issue_repo, issueNumber: row.issue_number },
          'Skipping comment command scan for missing or inaccessible issue',
        )
        continue
      }
      throw err
    }
    const parsed = parseOrchCommands(comments, '1970-01-01T00:00:00Z')

    for (const item of parsed) {
      if (isCommandProcessed(db, row.issue_repo, row.issue_number, item.commentId)) continue

      // Track whether the command reached a terminal outcome — applied,
      // denied (policy decision), or rejected (validated failure). Only
      // terminal outcomes mark the command as processed; transient
      // failures must remain retriable on the next poll cycle.
      let commandStatus: string | null = null
      try {
        const allowed = await canExecuteCommentCommand({
          forge,
          repo: row.issue_repo,
          user: item.user,
          requireCollaborator: commandSettings.requireCollaborator,
          cache: collaboratorCache,
        })

        if (!allowed) {
          commandStatus = 'denied'
          logger.info(
            { repo: repoConfig.repo, issueNumber: row.issue_number, user: item.user, commentId: item.commentId },
            'Ignoring comment command from non-collaborator',
          )
          continue
        }

        const result = await executeCommentCommand({
          command: item.command,
          db,
          forge,
          runManager,
          leaseManager,
          repoConfig,
          issueRepo: row.issue_repo,
          issueNumber: row.issue_number,
          botUser,
          user: item.user,
        })

        if (!result.ok) {
          commandStatus = 'rejected'
          logger.info(
            { repo: repoConfig.repo, issueNumber: row.issue_number, command: item.command.type, reason: result.reason },
            'Comment command rejected',
          )
        } else {
          commandStatus = 'applied'
          logger.info(
            { repo: repoConfig.repo, issueNumber: row.issue_number, command: item.command.type, user: item.user },
            'Comment command applied',
          )
        }
      } catch (err) {
        // Transient failure: leave commandStatus=null so the command
        // remains unprocessed and will be retried on the next poll.
        logger.warn(
          { repo: repoConfig.repo, issueNumber: row.issue_number, commentId: item.commentId, command: item.command.type, err },
          'Comment command failed (transient — will retry)',
        )
      } finally {
        if (commandStatus !== null) {
          markCommandProcessed(
            db,
            row.issue_repo,
            row.issue_number,
            item.commentId,
            `${item.command.type}:${commandStatus}`,
          )
        }
      }
    }
  }
}

interface CanExecuteCommentCommandParams {
  forge: ReturnType<typeof createForgeAdapter>
  repo: string
  user: string
  requireCollaborator: boolean
  cache: Map<string, boolean>
}

async function canExecuteCommentCommand(params: CanExecuteCommentCommandParams): Promise<boolean> {
  const { forge, repo, user, requireCollaborator, cache } = params
  if (!requireCollaborator) return true
  if (!user) return false

  // Cache key must include the repo — a user might be a collaborator on
  // one linked project but not another, and reusing a single-user cache
  // across repos in the same scan would erroneously grant or deny access.
  const cacheKey = `${repo}\n${user}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached

  if (!forge.isCollaborator) {
    logger.warn({ repo, user }, 'requireCollaborator=true but forge adapter has no isCollaborator() implementation')
    cache.set(cacheKey, false)
    return false
  }

  try {
    const allowed = await forge.isCollaborator(repo, user)
    cache.set(cacheKey, allowed)
    return allowed
  } catch (err) {
    logger.warn({ repo, user, err }, 'Failed collaborator check for comment command user')
    cache.set(cacheKey, false)
    return false
  }
}

interface ExecuteCommentCommandParams {
  command: OrchCommand
  db: Database.Database
  forge: ReturnType<typeof createForgeAdapter>
  runManager: RunManager
  leaseManager: LeaseManager
  repoConfig: Config['repos'][0]
  issueRepo: string
  issueNumber: number
  botUser: string
  user: string
}

type CommandExecutionResult = { ok: true } | { ok: false; reason: string }

async function executeCommentCommand(params: ExecuteCommentCommandParams): Promise<CommandExecutionResult> {
  const {
    command,
    db,
    forge,
    runManager,
    leaseManager,
    repoConfig,
    issueRepo,
    issueNumber,
    botUser,
    user,
  } = params

  switch (command.type) {
    case 'retry':
      return queueRetryFromComment({
        runManager,
        leaseManager,
        forge,
        repoConfig,
        issueRepo,
        issueNumber,
        resetPlan: command.resetPlan,
      })
    case 'continue':
      {
        const result = await queueContinue(db, forge, repoConfig, issueNumber, botUser, { issueRepo })
        return result.queued ? { ok: true } : { ok: false, reason: result.reason }
      }
    case 'rebase': {
      // queueRebase currently always verifies after rebase; keep behavior stable.
      const result = await queueRebase(db, forge, repoConfig, issueNumber, botUser)
      return result.queued ? { ok: true } : { ok: false, reason: result.reason }
    }
    case 'cancel':
      return cancelRunFromComment({
        runManager,
        leaseManager,
        forge,
        repoConfig,
        issueRepo,
        issueNumber,
        user,
      })
    default: {
      const exhaustive: never = command
      return { ok: false, reason: `Unsupported command: ${String(exhaustive)}` }
    }
  }
}

interface QueueRetryFromCommentParams {
  runManager: RunManager
  leaseManager: LeaseManager
  forge: ReturnType<typeof createForgeAdapter>
  repoConfig: Config['repos'][0]
  issueRepo: string
  issueNumber: number
  resetPlan: boolean
}

async function queueRetryFromComment(params: QueueRetryFromCommentParams): Promise<CommandExecutionResult> {
  const { runManager, leaseManager, forge, repoConfig, issueRepo, issueNumber, resetPlan } = params
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run) return { ok: false, reason: 'No run found for issue' }
  if (run.status === 'running') return { ok: false, reason: 'Run is currently running' }
  if (!['blocked', 'error', 'review_ready'].includes(run.status)) {
    return { ok: false, reason: `Retry not allowed from status ${run.status}` }
  }

  runManager.update(run.id, {
    status: 'queued',
    currentPhase: null,
    endedAt: null,
    lastError: null,
    phaseData: resetPlan ? null : run.phaseData,
    blockReason: null,
  })
  leaseManager.release(issueRepo, issueNumber)
  if (issueRepo !== repoConfig.repo) {
    leaseManager.release(repoConfig.repo, issueNumber)
  }

  const issue = await forge.getIssue(issueRepo, issueNumber)
  await transitionLabels(
    forge,
    issueRepo,
    issueNumber,
    issue.labels,
    run.status,
    'queued',
    buildLabelConfig(repoConfig, issue.labels),
  )
  return { ok: true }
}

interface CancelRunFromCommentParams {
  runManager: RunManager
  leaseManager: LeaseManager
  forge: ReturnType<typeof createForgeAdapter>
  repoConfig: Config['repos'][0]
  issueRepo: string
  issueNumber: number
  user: string
}

async function cancelRunFromComment(params: CancelRunFromCommentParams): Promise<CommandExecutionResult> {
  const { runManager, leaseManager, forge, repoConfig, issueRepo, issueNumber, user } = params
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run) return { ok: false, reason: 'No run found for issue' }
  if (run.status !== 'running' && run.status !== 'queued') {
    return { ok: false, reason: `Cancel only supports running/queued runs (current: ${run.status})` }
  }

  runManager.update(run.id, {
    status: 'blocked',
    endedAt: nowUtcIso(),
    lastError: `Cancelled by @${user} via comment command`,
    blockReason: null,
  })
  leaseManager.release(issueRepo, issueNumber)
  if (issueRepo !== repoConfig.repo) {
    leaseManager.release(repoConfig.repo, issueNumber)
  }

  const issue = await forge.getIssue(issueRepo, issueNumber)
  await transitionLabels(
    forge,
    issueRepo,
    issueNumber,
    issue.labels,
    run.status,
    'blocked',
    buildLabelConfig(repoConfig, issue.labels),
  )
  return { ok: true }
}

/**
 * Block reasons that indicate the coder's work is broken and the branch
 * should be hard-reset to base on the next attempt. Salvageable states
 * (reviewer_blocked, iteration_limit, ambiguous_review, verify_config)
 * preserve the branch so existing work can be continued.
 */
const TAINTED_BLOCK_REASONS = new Set(['agent_pass_limit', 'cost_limit', 'merge_conflict'])

// --- Reaction scanning ---

/** In-memory reaction cursors, keyed by "repo#issueNumber".
 *  Bounded: entries are evicted via {@link cleanupRunCaches}. */
const reactionCursors = new Map<string, ReactionCursor>()

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

interface ScanAndHandleReactionsParams {
  db: Database.Database
  forge: ReturnType<typeof createForgeAdapter>
  runManager: RunManager
  repoConfig: Config['repos'][0]
  botUser: string
}

async function scanAndHandleReactions(params: ScanAndHandleReactionsParams): Promise<void> {
  const { db, forge, runManager, repoConfig, botUser } = params

  // Find review_ready issues with PRs for this repo.
  const rows = runManager
    .getActive()
    .filter((run) => run.repo === repoConfig.repo && run.status === 'review_ready' && run.prNumber !== null)
    .map((run) => ({
      id: run.id,
      repo: run.repo,
      issue_number: run.issueNumber,
      pr_number: run.prNumber as number,
    }))

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
        await handleReaction(reaction, { db, forge, runManager, repoConfig })
      } catch (err) {
        logger.warn(
          { repo: row.repo, issueNumber: row.issue_number, reactionType: reaction.type, err },
          'Failed to handle reaction',
        )
      }
    }
  }
}

interface FollowupPromptFeedback {
  type: string
  summary: string
  context: string
}

function extractFollowupPromptFeedback(
  phaseData: Record<string, unknown> | null | undefined,
): FollowupPromptFeedback | null {
  if (!phaseData) return null

  const context = phaseData['reactionContext']
  if (typeof context !== 'string' || context.trim().length === 0) return null

  const type = typeof phaseData['reactionType'] === 'string' && phaseData['reactionType'].trim().length > 0
    ? phaseData['reactionType']
    : 'continue'
  const summary = typeof phaseData['reactionSummary'] === 'string' && phaseData['reactionSummary'].trim().length > 0
    ? phaseData['reactionSummary']
    : 'Follow-up context available'

  return { type, summary, context }
}

/**
 * Prioritize follow-up work over fresh issues so reactive runs (especially
 * merge conflict rebases) are handled promptly and don't starve behind newer
 * ready issues.
 */
function prioritizeDiscoveredIssues(
  runManager: RunManager,
  repo: string,
  discovered: DiscoveredIssue[],
): DiscoveredIssue[] {
  const ranked = discovered.map((item) => ({
    item,
    rank: getIssueQueuePriority(runManager, repo, item.issue.number),
  }))

  ranked.sort((a, b) => a.rank - b.rank)
  return ranked.map((entry) => entry.item)
}

function getIssueQueuePriority(
  runManager: RunManager,
  repo: string,
  issueNumber: number,
): number {
  const queuedRun = runManager.getLatestQueuedByIssue(repo, issueNumber)
  if (!queuedRun) return 3

  const reactionType = queuedRun.phaseData?.reactionType
  if (reactionType === 'merge_conflict' || reactionType === 'rebase') return 0
  if (typeof reactionType === 'string' && reactionType.length > 0) return 1
  return 2
}

function selectReplayableRun(run: RunRecord | null): RunRecord | null {
  if (!run) return null
  if (run.status === 'blocked' || run.status === 'review_ready' || run.status === 'error') {
    return run
  }
  return null
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
