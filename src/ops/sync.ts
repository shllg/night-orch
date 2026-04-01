import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import type { RunStatus } from '../state/runs.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { computeLabelMutation } from '../labels/transitions.js'
import { createWorktreeManager } from '../git/worktree.js'
import { logger } from '../utils/logger.js'

export interface SyncAction {
  repo: string
  issueNumber: number
  action: 'completed' | 'closed' | 'label_corrected' | 'lease_expired' | 'stale_cleared'
  reason: string
  prNumber: number | null
}

export interface LabelCorrection {
  repo: string
  issueNumber: number
  added: string[]
  removed: string[]
  reason: string
}

export interface SyncResult {
  reconciledRuns: SyncAction[]
  expiredLeases: number
  orphanedWorktrees: string[]
  labelCorrections: LabelCorrection[]
}

interface ActiveRunRow {
  id: string
  repo: string
  issue_number: number
  status: string
  pr_number: number | null
  branch_name: string | null
  worktree_path: string | null
}

export class SyncEngine {
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

  async reconcile(dryRun: boolean): Promise<SyncResult> {
    const result: SyncResult = {
      reconciledRuns: [],
      expiredLeases: 0,
      orphanedWorktrees: [],
      labelCorrections: [],
    }

    // 1. Find all active runs that can drift (running/queued)
    const activeRuns = this.db
      .prepare("SELECT id, repo, issue_number, status, pr_number, branch_name, worktree_path FROM runs WHERE status IN ('running', 'queued')")
      .all() as ActiveRunRow[]

    for (const run of activeRuns) {
      if (run.status === 'running') {
        // Running runs require an active lease; if lease expired, reconcile.
        const leased = this.leaseManager.isLeased(run.repo, run.issue_number)
        if (!leased) {
          const action = await this.reconcileStaleRun(run, dryRun)
          if (action) {
            result.reconciledRuns.push(action)
          }
        }
      } else if (run.status === 'queued') {
        const action = await this.reconcileQueuedRun(run, dryRun)
        if (action) {
          result.reconciledRuns.push(action)
        }
      }
    }

    // 2. Check label mismatches for non-running statuses
    const labelCorrections = await this.checkLabelMismatches(dryRun)
    result.labelCorrections = labelCorrections

    // 3. Clean expired leases
    if (!dryRun) {
      result.expiredLeases = this.leaseManager.cleanExpired()
    } else {
      // Count without deleting
      const count = this.db
        .prepare('SELECT COUNT(*) as c FROM leases WHERE leased_until < datetime(?)')
        .get(new Date().toISOString()) as { c: number }
      result.expiredLeases = count.c
    }

    // 4. Detect orphaned worktrees
    result.orphanedWorktrees = await this.detectOrphanedWorktrees()

    return result
  }

  private async reconcileStaleRun(run: ActiveRunRow, dryRun: boolean): Promise<SyncAction | null> {
    let forge: ForgeAdapter
    try {
      forge = this.forgeFactory(run.repo)
    } catch {
      logger.warn({ repo: run.repo }, 'Cannot create forge adapter for reconciliation')
      return await this.markStale(run, dryRun, 'Cannot check GitHub state')
    }

    // Check if PR exists and its state
    if (run.pr_number) {
      try {
        const pr = await forge.findPRByBranch(run.repo, run.branch_name ?? '')
        if (pr && pr.state === 'merged') {
          return this.markCompleted(run, dryRun, 'PR merged', forge)
        }
        if (pr && pr.state === 'open') {
          // PR exists and is open — mark as review_ready
          return this.markReviewReady(run, dryRun, 'PR open but run stale', forge)
        }
      } catch (err) {
        logger.warn({ repo: run.repo, prNumber: run.pr_number, err }, 'Failed to check PR state')
      }
    }

    // Check issue state
    try {
      const issue = await forge.getIssue(run.repo, run.issue_number)
      if (issue.state === 'closed') {
        return this.markClosed(run, dryRun, 'Issue closed externally', forge)
      }
    } catch (err) {
      logger.warn({ repo: run.repo, issue: run.issue_number, err }, 'Failed to check issue state')
    }

    // Issue still open, no PR — mark as queued for retry
    return await this.markStale(run, dryRun, 'Lease expired, no PR found — requeueing')
  }

  private async reconcileQueuedRun(run: ActiveRunRow, dryRun: boolean): Promise<SyncAction | null> {
    let forge: ForgeAdapter
    try {
      forge = this.forgeFactory(run.repo)
    } catch {
      logger.warn({ repo: run.repo }, 'Cannot create forge adapter for queued run reconciliation')
      return null
    }

    // Queued runs should not remain active if the issue has already been closed externally.
    try {
      const issue = await forge.getIssue(run.repo, run.issue_number)
      if (issue.state === 'closed') {
        return this.markClosed(run, dryRun, 'Issue closed while queued', forge)
      }
    } catch (err) {
      logger.warn({ repo: run.repo, issue: run.issue_number, err }, 'Failed to check queued issue state')
    }

    return null
  }

  private markCompleted(run: ActiveRunRow, dryRun: boolean, reason: string, forge: ForgeAdapter): SyncAction {
    if (!dryRun) {
      this.db.prepare("UPDATE runs SET status = 'completed', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(run.id)
      this.leaseManager.release(run.repo, run.issue_number)
      this.updateLabels(forge, run, 'completed').catch((err) => {
        logger.debug({ repo: run.repo, issue: run.issue_number, err }, 'Label update failed while marking run completed')
      })
    }
    logger.info({ runId: run.id, repo: run.repo, issue: run.issue_number }, reason)
    return { repo: run.repo, issueNumber: run.issue_number, action: 'completed', reason, prNumber: run.pr_number }
  }

  private markClosed(run: ActiveRunRow, dryRun: boolean, reason: string, forge: ForgeAdapter): SyncAction {
    if (!dryRun) {
      this.db.prepare("UPDATE runs SET status = 'completed', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(run.id)
      this.leaseManager.release(run.repo, run.issue_number)
      this.updateLabels(forge, run, 'completed').catch((err) => {
        logger.debug({ repo: run.repo, issue: run.issue_number, err }, 'Label update failed while marking run closed')
      })
    }
    logger.info({ runId: run.id, repo: run.repo, issue: run.issue_number }, reason)
    return { repo: run.repo, issueNumber: run.issue_number, action: 'closed', reason, prNumber: run.pr_number }
  }

  private markReviewReady(run: ActiveRunRow, dryRun: boolean, reason: string, forge: ForgeAdapter): SyncAction {
    if (!dryRun) {
      this.db.prepare("UPDATE runs SET status = 'review_ready', updated_at = datetime('now') WHERE id = ?").run(run.id)
      this.leaseManager.release(run.repo, run.issue_number)
      this.updateLabels(forge, run, 'review_ready').catch((err) => {
        logger.debug({ repo: run.repo, issue: run.issue_number, err }, 'Label update failed while marking run review_ready')
      })
    }
    logger.info({ runId: run.id, repo: run.repo, issue: run.issue_number }, reason)
    return { repo: run.repo, issueNumber: run.issue_number, action: 'label_corrected', reason, prNumber: run.pr_number }
  }

  private async markStale(run: ActiveRunRow, dryRun: boolean, reason: string): Promise<SyncAction> {
    if (!dryRun) {
      this.db.prepare("UPDATE runs SET status = 'queued', current_phase = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ?").run(reason, run.id)
      this.leaseManager.release(run.repo, run.issue_number)

      // Transition labels back to queued (ready) so the poller picks it up
      const repoConfig = this.config.repos.find((r) => r.repo === run.repo)
      if (repoConfig) {
        try {
          const forge = this.forgeFactory(run.repo)
          const issue = await forge.getIssue(run.repo, run.issue_number)
          const labelConfig = buildLabelConfig(repoConfig)
          await transitionLabels(forge, run.repo, run.issue_number, issue.labels, 'running', 'queued', labelConfig)
        } catch (err) {
          logger.warn({ repo: run.repo, issue: run.issue_number, err }, 'Failed to transition labels during stale run recovery')
        }
      }
    }
    logger.info({ runId: run.id, repo: run.repo, issue: run.issue_number }, reason)
    return { repo: run.repo, issueNumber: run.issue_number, action: 'stale_cleared', reason, prNumber: null }
  }

  private async updateLabels(forge: ForgeAdapter, run: ActiveRunRow, targetStatus: 'completed' | 'review_ready'): Promise<void> {
    const repoConfig = this.config.repos.find((r) => r.repo === run.repo)
    if (!repoConfig) return

    try {
      const issue = await forge.getIssue(run.repo, run.issue_number)
      const labelConfig = buildLabelConfig(repoConfig)
      await transitionLabels(forge, run.repo, run.issue_number, issue.labels, 'running', targetStatus, labelConfig)
    } catch (err) {
      logger.warn({ repo: run.repo, issue: run.issue_number, err }, 'Failed to update labels during sync')
    }
  }

  private async checkLabelMismatches(dryRun: boolean): Promise<LabelCorrection[]> {
    const corrections: LabelCorrection[] = []

    // Find runs where DB status and labels might be out of sync
    const runs = this.db
      .prepare("SELECT id, repo, issue_number, status FROM runs WHERE status IN ('running', 'blocked', 'error', 'review_ready') AND ended_at IS NULL")
      .all() as Array<{ id: string; repo: string; issue_number: number; status: string }>

    for (const run of runs) {
      const repoConfig = this.config.repos.find((r) => r.repo === run.repo)
      if (!repoConfig) continue

      let forge: ForgeAdapter
      try {
        forge = this.forgeFactory(run.repo)
      } catch {
        continue
      }

      try {
        const issue = await forge.getIssue(run.repo, run.issue_number)
        const labelConfig = buildLabelConfig(repoConfig)

        const targetStatus = this.toRunStatus(run.status)
        if (!targetStatus) continue
        const mutation = computeLabelMutation(targetStatus, targetStatus, issue.labels, labelConfig)
        if (mutation.add.length > 0 || mutation.remove.length > 0) {
          const correction: LabelCorrection = {
            repo: run.repo,
            issueNumber: run.issue_number,
            added: mutation.add,
            removed: mutation.remove,
            reason: `DB status is ${run.status} but labels are out of sync`,
          }
          if (!dryRun) {
            if (mutation.remove.length > 0) {
              await forge.removeLabels(run.repo, run.issue_number, mutation.remove)
            }
            if (mutation.add.length > 0) {
              await forge.addLabels(run.repo, run.issue_number, mutation.add)
            }
          }
          corrections.push(correction)
        }
      } catch (err) {
        logger.debug({ repo: run.repo, issue: run.issue_number, err }, 'Failed to check label mismatch')
      }
    }

    return corrections
  }

  private toRunStatus(status: string): RunStatus | null {
    if (status === 'running' || status === 'blocked' || status === 'review_ready' || status === 'error') {
      return status
    }
    return null
  }

  private async detectOrphanedWorktrees(): Promise<string[]> {
    const orphaned: string[] = []
    const worktreeManager = createWorktreeManager()

    for (const repoConfig of this.config.repos) {
      try {
        const worktrees = await worktreeManager.list(repoConfig.localPath, this.config.storage.worktreeRoot)
        for (const wt of worktrees) {
          const row = this.db
            .prepare('SELECT 1 FROM runs WHERE worktree_path = ?')
            .get(wt.path) as { 1: number } | undefined
          if (!row) {
            orphaned.push(wt.path)
          }
        }
      } catch (err) {
        logger.debug({ repo: repoConfig.repo, err }, 'Failed to list worktrees for orphan detection')
      }
    }

    return orphaned
  }
}
