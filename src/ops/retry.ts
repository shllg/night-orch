import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { UpdateStrategy } from '../git/worktree.js'
import { createForgeAdapter } from '../forge/factory.js'
import { MergeBatchManager } from '../merge-queue/batch.js'
import { buildLabelConfig } from '../labels/config.js'
import { transitionLabels } from '../labels/manager.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager, type RunStatus } from '../state/runs.js'
import { createFollowupAttempt } from '../state/attempts.js'
import { recordUserAction } from '../state/run-log-events.js'
import { pollOnce } from '../runner/poller.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { logger } from '../utils/logger.js'

export interface RetryOptions {
  immediate: boolean
  resetPlan: boolean
  resetBranch: boolean
  dryRun: boolean
  strategyOverride?: UpdateStrategy
  actor?: string
}

const RETRYABLE_STATUSES: RunStatus[] = ['blocked', 'error', 'review_ready']

export class RetryEngine {
  private leaseManager: LeaseManager

  constructor(
    private db: Database.Database,
    private config: Config,
    private forgeFactory: (repo: string) => ForgeAdapter = (repo) => {
      const repoConfig = config.repos.find((r) => r.repo === repo)
      if (!repoConfig) throw new Error(`No config for repo ${repo}`)
      return createForgeAdapter(repoConfig, config)
    },
  ) {
    this.leaseManager = new LeaseManager(db)
  }

  async retry(repo: string, issueNumber: number, options: Partial<RetryOptions> = {}): Promise<void> {
    const opts: RetryOptions = {
      immediate: options.immediate ?? false,
      resetPlan: options.resetPlan ?? true,
      resetBranch: options.resetBranch ?? true,
      dryRun: options.dryRun ?? false,
      strategyOverride: options.strategyOverride,
      actor: options.actor,
    }

    const runManager = new RunManager(this.db)
    const run = runManager.getByRepoAndIssue(repo, issueNumber)

    if (!run) {
      throw new Error(`No run found for ${repo}#${issueNumber}`)
    }

    if (run.status === 'running') {
      throw new Error(`Run ${run.id} is currently running — cannot retry`)
    }

    if (!RETRYABLE_STATUSES.includes(run.status)) {
      throw new Error(`Run ${run.id} is in status "${run.status}" — can only retry ${RETRYABLE_STATUSES.join(', ')} runs`)
    }

    if (run.prNumber !== null) {
      const activeBatch = new MergeBatchManager(this.db).findActiveBatchContainingPr(repo, run.prNumber)
      if (activeBatch) {
        throw new Error(`Run ${run.id} PR #${run.prNumber} is in active merge-queue batch ${activeBatch.id} — cannot retry`)
      }
    }

    logger.info({ runId: run.id, repo, issue: issueNumber, status: run.status, opts }, 'Retrying run')
    const issueRepo = resolveIssueRepo(run.phaseData, repo)

    if (opts.dryRun) {
      logger.info({ runId: run.id }, '[dry-run] Would reset run to queued')
      return
    }

    // Retry is always a fresh start from the latest base branch tip.
    const requestedAt = new Date().toISOString()
    const nextPhaseData = {
      issueRepo,
      reactionType: 'retry',
      reactionSummary: 'Fresh retry requested',
      reactionContext: 'Retry requested. Start fresh from the latest base branch and re-implement the solution.',
      retryRequestedAt: requestedAt,
    } satisfies Record<string, unknown>

    // Atomic state transition: finalize the previous attempt + INSERT a
    // new one + release leases in a single DB transaction. Previous
    // implementation mutated the same row and had to manually reset
    // iteration/cost/branch fields; createFollowupAttempt starts a fresh
    // row with zeroed counters by construction.
    let newAttemptId: string
    try {
      const transition = this.db.transaction(() => {
        const result = createFollowupAttempt(this.db, {
          previousAttemptId: run.id,
          intent: 'retry',
          resetBranch: true,
          maxSequenceNumber: this.config.loop.maxAttemptChainLength,
          phaseData: nextPhaseData,
          controlPayload: {
            issueRepo,
            preserveBranchState: false,
            resetPlan: true,
            resetBranch: true,
            retryRequestedAt: requestedAt,
            ...(opts.strategyOverride ? { updateStrategy: opts.strategyOverride } : {}),
          },
        })
        this.leaseManager.release(repo, issueNumber)
        if (issueRepo !== repo) {
          this.leaseManager.release(issueRepo, issueNumber)
        }
        return result.attemptId
      })
      newAttemptId = transition()
    } catch (err) {
      throw new Error(`Failed to queue retry for run ${run.id}: ${String(err)}`)
    }

    logger.info(
      { previousRunId: run.id, newRunId: newAttemptId, repo, issue: issueNumber },
      'Queued retry as new attempt',
    )

    recordUserAction(this.db, {
      runId: newAttemptId,
      kind: 'retry',
      actor: opts.actor ?? 'manual',
      details: opts.strategyOverride ? { strategy: opts.strategyOverride } : null,
    })

    // Apply label mutations
    await this.updateLabels(repo, issueRepo, issueNumber, run.status)

      // If --immediate, start processing right away
    if (opts.immediate) {
      logger.info({ runId: run.id }, 'Starting immediate retry')
      await pollOnce(this.config, this.db, false, undefined, { repo: issueRepo, issueNumber })
    }
  }

  private async updateLabels(repo: string, issueRepo: string, issueNumber: number, fromStatus: RunStatus): Promise<void> {
    const repoConfig = this.config.repos.find((r) => r.repo === repo)
    if (!repoConfig) return

    let forge: ForgeAdapter
    try {
      forge = this.forgeFactory(repo)
    } catch {
      logger.warn({ repo }, 'Cannot create forge adapter for label update')
      return
    }

    try {
      const issue = await forge.getIssue(issueRepo, issueNumber)
      const labelConfig = buildLabelConfig(repoConfig, issue.labels)
      await transitionLabels(forge, issueRepo, issueNumber, issue.labels, fromStatus, 'queued', labelConfig)
    } catch (err) {
      logger.warn({ repo: issueRepo, issue: issueNumber, err }, 'Failed to update labels during retry')
    }
  }
}
