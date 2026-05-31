import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { MetricsService } from '../metrics/service.js'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager } from '../state/runs.js'
import { IssueManager } from '../state/issues.js'
import { createWorktreeManager } from '../git/worktree.js'
import { NotificationDispatcher } from '../notify/dispatcher.js'
import { createChannels } from '../notify/factory.js'
import { CostTracker } from '../loop/cost.js'
import { logger } from '../utils/logger.js'
import {
  AgentObservability,
  setActiveAgentObservability,
  clearActiveAgentObservability,
} from '../events/observability.js'
import { dispatchAttempt } from '../poller/attempt-dispatcher.js'
import { discoverIssuesForRepo } from '../poller/discovery-scheduler.js'
import { runPreflightDriftCheck } from '../loop/preflight.js'
import { processRepoReactions } from '../poller/reaction-processor.js'
import { FileLoopEngine } from '../fileloop/engine.js'
import { createOrchestrationCache, type OrchestrationCache } from './orchestration-cache.js'

/**
 * R6 wiring-only poller.
 *
 * This file used to be an 800-line god object that mixed discovery,
 * reaction processing, lease management, attempt lifecycle, error
 * recovery, and notification routing. The R6 decomposition split
 * those concerns into `src/poller/*`:
 *
 *   - `discovery-scheduler.ts`   — issue discovery + prioritization
 *   - `reaction-processor.ts`    — comment commands + reactions + merge queue
 *   - `attempt-dispatcher.ts`    — per-issue lifecycle (lease → loop → finalize)
 *   - `notify-dispatcher.ts`     — typed facade over NotificationDispatcher
 *   - `error-recovery.ts`        — typed worker-error classification (R2)
 *
 * What remains here is the top-level poll cycle: set up shared state,
 * fan out over repos, and aggregate results.
 */

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
  cache?: OrchestrationCache,
): Promise<PollResult> {
  const leaseManager = new LeaseManager(db)
  const runManager = new RunManager(db)
  const issueManager = new IssueManager(db)
  const worktreeManager = createWorktreeManager()
  const fileLoopEngine = new FileLoopEngine(db, config, worktreeManager)
  const costTracker = new CostTracker(db)
  const orchestrationCache = cache ?? createOrchestrationCache()

  let processed = 0
  let errors = 0
  const immediateFollowupRepos = new Set<string>()
  const observability = new AgentObservability(db, config)
  setActiveAgentObservability(observability)

  try {
    // Phase 4 gate: refresh the operator-health metrics at every poll.
    try {
      const activeRuns = runManager.getActive()
      metrics?.setActiveRuns(activeRuns.length)
      metrics?.setDailyCost(costTracker.getDailyCost())
      try {
        const quarantineCount = db
          .prepare('SELECT COUNT(*) AS c FROM checkpoint_quarantine')
          .get() as { c: number }
        metrics?.setCheckpointQuarantineRows(quarantineCount.c)
      } catch { /* best-effort */ }
    } catch { /* best-effort */ }

    leaseManager.cleanExpired()

    const reposToProcess = targetIssue
      ? config.repos.filter((repoConfig) => {
          const issueRepos = new Set([repoConfig.repo, ...(repoConfig.linkedProjects ?? [])])
          return issueRepos.has(targetIssue.repo)
        })
      : config.repos
    const usedPortsInPass: number[] = []

    const repoResults = await Promise.all(
      reposToProcess.map((repoConfig): Promise<PollResult> =>
        pollRepo({
          config,
          db,
          repoConfig,
          runManager,
          leaseManager,
          issueManager,
          worktreeManager,
          fileLoopEngine,
          costTracker,
          observability,
          metrics,
          dryRun,
          targetIssue,
          usedPortsInPass,
          cache: orchestrationCache,
        }),
      ),
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

interface PollRepoParams {
  config: Config
  db: Database.Database
  repoConfig: Config['repos'][number]
  runManager: RunManager
  leaseManager: LeaseManager
  issueManager: IssueManager
  worktreeManager: ReturnType<typeof createWorktreeManager>
  fileLoopEngine: FileLoopEngine
  costTracker: CostTracker
  observability: AgentObservability
  metrics?: MetricsService
  dryRun: boolean
  targetIssue?: PollTargetIssue
  usedPortsInPass: number[]
  cache: OrchestrationCache
}

async function pollRepo(params: PollRepoParams): Promise<PollResult> {
  const {
    config,
    db,
    repoConfig,
    runManager,
    leaseManager,
    issueManager,
    worktreeManager,
    fileLoopEngine,
    observability,
    metrics,
    dryRun,
    targetIssue,
    usedPortsInPass,
    cache,
  } = params

  let repoProcessed = 0
  let repoErrors = 0
  const repoImmediateFollowupRepos = new Set<string>()

  try {
    const forge = createForgeAdapter(repoConfig, config)
    const channels = createChannels(config.notifications, forge, db)
    const notifier = new NotificationDispatcher(channels, config.notifications.events)

    let botUser = ''
    try {
      const authInfo = await forge.validateAuth()
      botUser = authInfo.user
    } catch {
      logger.debug({ repo: repoConfig.repo }, 'Could not resolve bot user for comment upserts')
    }

    await processRepoReactions({
      config, db, forge, repoConfig, runManager, leaseManager, botUser, cache,
    })

    const discovered = await discoverIssuesForRepo({
      repoConfig,
      forge,
      leaseManager,
      runManager,
      issueManager,
      metrics,
      targetIssue,
    })

    const fileLoopSession = fileLoopEngine.getActiveSession(repoConfig.repo)
    if (!dryRun && fileLoopSession) {
      await fileLoopEngine.tickRepo(repoConfig, forge)
    }

    if (discovered.length === 0 && !fileLoopSession) {
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

    // Preflight drift gate: when enabled, verify the base branch is green
    // before dispatching fresh work. A red base means drift unrelated to
    // any queued issue — dispatch onto it would fail every issue in series
    // and inject stale-base reverts into diffs. Skipped for targeted runs
    // (the operator explicitly asked for that one issue).
    if (!targetIssue && repoConfig.preflight?.enabled) {
      const preflight = await runPreflightDriftCheck({
        config,
        repoConfig,
        worktreeManager,
        worktreeRoot: config.storage.worktreeRoot,
      })
      if (!preflight.ok) {
        logger.warn(
          { repo: repoConfig.repo, reason: preflight.reason, failedCommand: preflight.failedCommand },
          'Preflight drift gate blocked the batch — base branch is red; skipping all dispatch this cycle',
        )
        return {
          processed: repoProcessed,
          errors: repoErrors,
          immediateFollowupRepos: [],
        }
      }
    }

    const maxConcurrentRuns = targetIssue ? 1 : (repoConfig.maxConcurrentRuns ?? 1)
    const discoveredQueue = [...discovered]
    const workerCount = Math.min(maxConcurrentRuns, discoveredQueue.length)

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const discoveredIssue = discoveredQueue.shift()
          if (!discoveredIssue) break

          const result = await dispatchAttempt({
            config,
            db,
            forge,
            repoConfig,
            discoveredIssue,
            runManager,
            leaseManager,
            worktreeManager,
            notifier,
            observability,
            botUser,
            usedPortsInPass,
            cache,
            metrics,
          })

          if (result.outcome === 'processed') repoProcessed++
          else if (result.outcome === 'errored') repoErrors++
          if (result.immediateFollowupRepo) {
            repoImmediateFollowupRepos.add(result.immediateFollowupRepo)
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
}
