import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import { pollOnce } from '../runner/poller.js'
import { logger } from '../utils/logger.js'

export interface RetryOptions {
  immediate: boolean
  resetPlan: boolean
  dryRun: boolean
}

interface RunRow {
  id: string
  status: string
  repo: string
  issue_number: number
}

const RETRYABLE_STATUSES = ['blocked', 'error', 'review_ready']

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
      dryRun: options.dryRun ?? false,
    }

    // Find latest run
    const run = this.db
      .prepare('SELECT id, status, repo, issue_number FROM runs WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC LIMIT 1')
      .get(repo, issueNumber) as RunRow | undefined

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

    if (opts.dryRun) {
      logger.info({ runId: run.id }, '[dry-run] Would reset run to queued')
      return
    }

    // Reset run to queued
    const resetFields: Record<string, unknown> = {
      status: 'queued',
      current_phase: null,
      last_error: null,
      ended_at: null,
    }

    if (opts.resetPlan) {
      resetFields.phase_data = null
    }

    const setClauses = Object.keys(resetFields).map((k) => `${k} = ?`)
    setClauses.push("updated_at = datetime('now')")
    const values = Object.values(resetFields)
    values.push(run.id)

    this.db
      .prepare(`UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values)

    // Release any lease
    this.leaseManager.release(repo, issueNumber)

    // Apply label mutations
    await this.updateLabels(repo, issueNumber)

    logger.info({ runId: run.id, repo, issue: issueNumber }, 'Run reset to queued for retry')

    // If --immediate, start processing right away
    if (opts.immediate) {
      logger.info({ runId: run.id }, 'Starting immediate retry')
      await pollOnce(this.config, this.db, false)
    }
  }

  private async updateLabels(repo: string, issueNumber: number): Promise<void> {
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
      const issue = await forge.getIssue(repo, issueNumber)
      const labelConfig = {
        ready: repoConfig.labels.ready,
        running: repoConfig.labels.running,
        blocked: repoConfig.labels.blocked,
        reviewReady: repoConfig.labels.reviewReady,
        error: repoConfig.labels.error,
        retry: repoConfig.labels.retry,
      }

      // Remove error/blocked labels, add ready label
      const labelsToRemove = [labelConfig.error, ...labelConfig.blocked, labelConfig.reviewReady, labelConfig.running]
      const currentLabels = issue.labels
      const actualRemove = labelsToRemove.filter((l) => currentLabels.includes(l))
      const readyLabel = labelConfig.ready[0]
      const actualAdd = readyLabel && !currentLabels.includes(readyLabel) ? [readyLabel] : []

      if (actualRemove.length > 0) {
        await forge.removeLabels(repo, issueNumber, actualRemove)
      }
      if (actualAdd.length > 0) {
        await forge.addLabels(repo, issueNumber, actualAdd)
      }
    } catch (err) {
      logger.warn({ repo, issue: issueNumber, err }, 'Failed to update labels during retry')
    }
  }
}
