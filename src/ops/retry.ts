import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { createForgeAdapter } from '../forge/factory.js'
import { buildLabelConfig } from '../labels/config.js'
import { transitionLabels } from '../labels/manager.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager, type RunStatus } from '../state/runs.js'
import { pollOnce } from '../runner/poller.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { logger } from '../utils/logger.js'

export interface RetryOptions {
  immediate: boolean
  resetPlan: boolean
  resetBranch: boolean
  dryRun: boolean
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
      resetPlan: options.resetPlan ?? false,
      resetBranch: options.resetBranch ?? false,
      dryRun: options.dryRun ?? false,
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

    logger.info({ runId: run.id, repo, issue: issueNumber, status: run.status, opts }, 'Retrying run')
    const issueRepo = resolveIssueRepo(run.phaseData, repo)

    if (opts.dryRun) {
      logger.info({ runId: run.id }, '[dry-run] Would reset run to queued')
      return
    }

    // Reset run to queued
    const resetFields: Parameters<RunManager['update']>[1] = {
      status: 'queued',
      currentPhase: null,
      lastError: null,
      endedAt: null,
      // Reset cost accumulators so retry doesn't immediately re-block on per-run limit
      estimatedCostUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
    }

    if (opts.resetPlan || opts.resetBranch) {
      resetFields.phaseData = null
    }

    if (opts.resetBranch) {
      // Signal the poller to hard-reset the branch to base on next pickup
      resetFields.blockReason = 'merge_conflict'
    }

    // Atomic state transition: release leases AND reset the run in a
    // single DB transaction. Without this, a crash between the two steps
    // leaves the issue queued-but-leased until stale cleanup runs.
    const transition = this.db.transaction(() => {
      runManager.update(run.id, resetFields)
      this.leaseManager.release(repo, issueNumber)
      if (issueRepo !== repo) {
        this.leaseManager.release(issueRepo, issueNumber)
      }
    })
    transition()

    // Apply label mutations
    await this.updateLabels(repo, issueRepo, issueNumber, run.status)

    logger.info({ runId: run.id, repo, issue: issueNumber }, 'Run reset to queued for retry')

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
