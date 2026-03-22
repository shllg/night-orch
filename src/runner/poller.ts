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

    // Process first eligible (serial)
    const first = discovered[0]!

    if (first.triage.level === 'architectural') {
      await forge.addLabels(repoConfig.repo, first.issue.number, ['orch:needs-human'])
      await forge.commentOnIssue(
        repoConfig.repo,
        first.issue.number,
        '🏗️ **night-orch**: This issue is classified as architectural and requires human guidance.',
      )
      continue
    }

    if (!leaseManager.acquire(repoConfig.repo, first.issue.number, 'poller', 7200)) {
      continue
    }

    let runId: string | null = null
    let envSetup: EnvSetupResult | null = null
    let activeWorktreePath: string | null = null
    const labelConfig = buildLabelConfig(repoConfig)

    try {
      const resolvedRoles = resolveRoles(first.issue.labels, repoConfig.defaults)
      const queuedRun = runManager.getLatestQueuedByIssue(repoConfig.repo, first.issue.number)
      const roles = queuedRun
        ? {
            planner: coerceAgentName(queuedRun.planner, resolvedRoles.planner),
            coder: coerceAgentName(queuedRun.coder, resolvedRoles.coder),
            reviewer: coerceAgentName(queuedRun.reviewer, resolvedRoles.reviewer),
          }
        : resolvedRoles
      const slug = getOrPinSlug(db, repoConfig.repo, first.issue.number, first.issue.title)
      const branch = branchName(repoConfig.branchPrefix, first.issue.number, slug)
      const worktreePath = buildWorktreePath(config.storage.worktreeRoot, repoConfig.repo, first.issue.number)
      activeWorktreePath = worktreePath

      const run = queuedRun ?? runManager.create({
        repo: repoConfig.repo,
        issueNumber: first.issue.number,
        issueNodeId: first.issue.nodeId,
        planner: roles.planner,
        coder: roles.coder,
        reviewer: roles.reviewer,
      })
      runId = run.id
      runManager.update(run.id, {
        status: 'running',
        branchName: branch,
        branchSlug: slug,
        worktreePath,
        endedAt: null,
        lastError: null,
      })

      // Label transition
      await transitionLabels(forge, repoConfig.repo, first.issue.number, first.issue.labels, 'queued', 'running', labelConfig)

      // Notify
      await notifier.dispatch(makePayload('run_started', repoConfig.repo, first.issue))

      // Create worktree
      await worktreeManager.ensure({
        repoLocalPath: repoConfig.localPath,
        baseBranch: repoConfig.baseBranch,
        branchName: branch,
        worktreePath,
      })

      if (repoConfig.environment) {
        const mode = resolveEnvironmentMode(first.issue.labels, repoConfig)
        envSetup = await setupEnvironment({
          worktreePath,
          issueNumber: first.issue.number,
          repoConfig,
          mode,
          usedPorts: usedPortsInPass,
        })
      }

      // Get worker adapters
      const adjustedLimits = adjustLimitsForTriage(
        config.loop,
        config.workerProfiles[repoConfig.agents[roles.planner] ?? '']?.workerTimeoutSeconds ?? 1800,
        first.triage,
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
        issueNumber: first.issue.number,
        issue: first.issue,
        repoConfig,
        roles,
        triageResult: first.triage,
        adjustedLimits,
        branchName: branch,
        worktreePath,
        plan: null,
        codeResult: null,
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
      }

      // Execute loop
      const loopStart = Date.now()
      const finalCtx = await executeLoop(initialCtx, {
        db,
        config,
        plannerAdapter: createWorkerAdapter(plannerProfile),
        coderAdapter: createWorkerAdapter(coderProfile),
        reviewerAdapter: createWorkerAdapter(reviewerProfile),
        envOverrides: envSetup?.envOverrides ?? {},
        metrics,
      })

      const runDurationSec = (Date.now() - loopStart) / 1000
      const outcome = await finalizeRunOutcome({
        finalCtx,
        runId: run.id,
        issue: first.issue,
        runDurationSec,
        repo: repoConfig.repo,
        issueNumber: first.issue.number,
        labelConfig,
        db,
        forge,
        runManager,
        notifier,
        metrics,
      })

      if (outcome === 'processed') processed++
      else errors++
    } catch (err) {
      logger.error({ repo: repoConfig.repo, issue: first.issue.number, err }, 'Failed to process issue')
      if (runId) {
        runManager.update(runId, {
          status: 'error',
          lastError: String(err),
          endedAt: new Date().toISOString(),
        })
        try {
          const latestIssue = await forge.getIssue(repoConfig.repo, first.issue.number)
          await transitionLabels(
            forge,
            repoConfig.repo,
            first.issue.number,
            latestIssue.labels,
            'running',
            'error',
            labelConfig,
          )
        } catch (labelErr) {
          logger.warn({ repo: repoConfig.repo, issue: first.issue.number, err: labelErr }, 'Failed to transition labels after poller error')
        }
        try {
          await notifier.dispatch(makePayload('error', repoConfig.repo, first.issue, {
            summary: `Failed to process issue: ${(err as Error).message}`,
          }))
        } catch (notifyErr) {
          logger.warn({ repo: repoConfig.repo, issue: first.issue.number, err: notifyErr }, 'Failed to send error notification after poller error')
        }
      }
      errors++
    } finally {
      if (envSetup && activeWorktreePath) {
        try {
          await teardownEnvironment({
            worktreePath: activeWorktreePath,
            issueNumber: first.issue.number,
            repoConfig,
            mode: envSetup.mode,
            composeProjectName: envSetup.composeProjectName,
          })
        } catch (envErr) {
          logger.warn({ repo: repoConfig.repo, issue: first.issue.number, err: envErr }, 'Failed to tear down environment')
        }
      }
      leaseManager.release(repoConfig.repo, first.issue.number)
    }
  }

  return { processed, errors }
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
  } = params

  if (finalCtx.terminalStatus === 'publish') {
    try {
      const publishResult = await publishPR(finalCtx, forge, db)
      runManager.update(runId, {
        status: 'review_ready',
        prNumber: publishResult.prNumber,
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
      const latestIssue = await forge.getIssue(repo, issueNumber)
      await transitionLabels(
        forge,
        repo,
        issueNumber,
        latestIssue.labels,
        'running',
        'error',
        labelConfig,
      )
      const notifyResult = await notifier.dispatch(makePayload('error', repo, issue, {
        summary: `Failed to publish PR: ${(err as Error).message}`,
      }))
      try {
        metrics?.incRunsTotal('error')
        metrics?.observeRunDuration(runDurationSec)
        for (const s of notifyResult.sent) {
          metrics?.incNotifications(s.channel, s.success ? 'sent' : 'failed')
        }
      } catch { /* best-effort */ }
      return 'error'
    }
  }

  if (finalCtx.terminalStatus === 'blocked') {
    runManager.update(runId, { status: 'blocked', endedAt: new Date().toISOString() })
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
    const notifyResult = await notifier.dispatch(makePayload('blocked', repo, issue, {
      summary: 'Issue blocked during processing',
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

  runManager.update(runId, { status: 'error', lastError: 'Loop ended in unexpected state', endedAt: new Date().toISOString() })
  const latestIssue = await forge.getIssue(repo, issueNumber)
  await transitionLabels(
    forge,
    repo,
    issueNumber,
    latestIssue.labels,
    'running',
    'error',
    labelConfig,
  )
  const notifyResult = await notifier.dispatch(makePayload('error', repo, issue, {
    summary: `Error: loop ended in ${finalCtx.terminalStatus}/${finalCtx.currentPhase}`,
  }))
  try {
    metrics?.incRunsTotal('error')
    metrics?.observeRunDuration(runDurationSec)
    for (const s of notifyResult.sent) {
      metrics?.incNotifications(s.channel, s.success ? 'sent' : 'failed')
    }
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
