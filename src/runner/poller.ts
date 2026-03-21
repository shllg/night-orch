import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager } from '../state/runs.js'
import { discoverEligibleIssues } from '../discovery/discover.js'
import { resolveRoles } from '../discovery/roles.js'
import { adjustLimitsForTriage } from '../discovery/triage.js'
import { getOrPinSlug, buildWorktreePath } from '../git/slug.js'
import { createWorktreeManager } from '../git/worktree.js'
import { createWorkerAdapter } from '../workers/factory.js'
import { executeLoop } from '../loop/engine.js'
import { publishPR } from '../publishing/publisher.js'
import { transitionLabels } from '../labels/manager.js'
import { NotificationDispatcher } from '../notify/dispatcher.js'
import { createChannels } from '../notify/factory.js'
import { branchName } from '../utils/ids.js'
import { logger } from '../utils/logger.js'
import type { RunContext } from '../loop/types.js'
import type { NotificationPayload } from '../notify/types.js'

export interface PollResult {
  processed: number
  errors: number
}

/**
 * Process one poll cycle: discover eligible issues, claim and process.
 * Serial processing — one issue at a time.
 */
export async function pollOnce(
  config: Config,
  db: Database.Database,
  dryRun: boolean,
): Promise<PollResult> {
  const leaseManager = new LeaseManager(db)
  const runManager = new RunManager(db)
  const channels = createChannels(config.notifications)
  const notifier = new NotificationDispatcher(channels, config.notifications.events)
  const worktreeManager = createWorktreeManager()

  let processed = 0
  let errors = 0

  // Clean expired leases
  leaseManager.cleanExpired()

  for (const repoConfig of config.repos) {
    const forge = createForgeAdapter(repoConfig, config)
    const discovered = await discoverEligibleIssues(repoConfig, forge, leaseManager)

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

    try {
      const roles = resolveRoles(first.issue.labels, repoConfig.defaults)
      const slug = getOrPinSlug(db, repoConfig.repo, first.issue.number, first.issue.title)
      const branch = branchName(repoConfig.branchPrefix, first.issue.number, slug)
      const worktreePath = buildWorktreePath(config.storage.worktreeRoot, repoConfig.repo, first.issue.number)

      // Create run
      const run = runManager.create({
        repo: repoConfig.repo,
        issueNumber: first.issue.number,
        issueNodeId: first.issue.nodeId,
        planner: roles.planner,
        coder: roles.coder,
        reviewer: roles.reviewer,
      })
      runManager.update(run.id, { status: 'running', branchName: branch, branchSlug: slug, worktreePath })

      // Label transition
      const labelConfig = {
        ready: repoConfig.labels.ready,
        running: repoConfig.labels.running,
        blocked: repoConfig.labels.blocked,
        reviewReady: repoConfig.labels.reviewReady,
        error: repoConfig.labels.error,
        retry: repoConfig.labels.retry,
      }
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
        phaseHistory: [],
        dryRun: false,
      }

      // Execute loop
      const finalCtx = await executeLoop(initialCtx, {
        db,
        config,
        plannerAdapter: createWorkerAdapter(plannerProfile),
        coderAdapter: createWorkerAdapter(coderProfile),
        reviewerAdapter: createWorkerAdapter(reviewerProfile),
      })

      // Handle result
      if (finalCtx.currentPhase === 'publish') {
        // Publish PR
        try {
          const publishResult = await publishPR(finalCtx, forge, db)
          runManager.update(run.id, {
            status: 'review_ready',
            prNumber: publishResult.prNumber,
            endedAt: new Date().toISOString(),
          })
          await transitionLabels(forge, repoConfig.repo, first.issue.number, first.issue.labels, 'running', 'review_ready', labelConfig)
          await notifier.dispatch(makePayload('pr_ready', repoConfig.repo, first.issue, {
            prUrl: publishResult.prUrl,
            prNumber: publishResult.prNumber,
            summary: `PR ready: ${publishResult.prUrl}`,
          }))
        } catch (err) {
          logger.error({ err }, 'Failed to publish PR')
          runManager.update(run.id, { status: 'error', lastError: String(err), endedAt: new Date().toISOString() })
          await transitionLabels(forge, repoConfig.repo, first.issue.number, first.issue.labels, 'running', 'error', labelConfig)
          await notifier.dispatch(makePayload('error', repoConfig.repo, first.issue, {
            summary: `Failed to publish PR: ${(err as Error).message}`,
          }))
        }
        processed++
      } else if (finalCtx.currentPhase === 'decision') {
        runManager.update(run.id, { status: 'blocked', endedAt: new Date().toISOString() })
        await transitionLabels(forge, repoConfig.repo, first.issue.number, first.issue.labels, 'running', 'blocked', labelConfig)
        await notifier.dispatch(makePayload('blocked', repoConfig.repo, first.issue, {
          summary: 'Issue blocked during processing',
        }))
        processed++
      } else {
        runManager.update(run.id, { status: 'error', lastError: 'Loop ended in unexpected state', endedAt: new Date().toISOString() })
        await transitionLabels(forge, repoConfig.repo, first.issue.number, first.issue.labels, 'running', 'error', labelConfig)
        await notifier.dispatch(makePayload('error', repoConfig.repo, first.issue, {
          summary: `Error: loop ended in ${finalCtx.currentPhase}`,
        }))
        errors++
      }
    } catch (err) {
      logger.error({ repo: repoConfig.repo, issue: first.issue.number, err }, 'Failed to process issue')
      errors++
    } finally {
      leaseManager.release(repoConfig.repo, first.issue.number)
    }
  }

  return { processed, errors }
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
