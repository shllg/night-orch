import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { createForgeAdapter } from '../forge/factory.js'
import { LeaseManager } from '../state/leases.js'
import { RunManager, type RunStatus } from '../state/runs.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { computeLabelMutation } from '../labels/transitions.js'
import { createWorktreeManager } from '../git/worktree.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'

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
  phase_data: string | null
}

export class SyncEngine {
  private leaseManager: LeaseManager
  private runManager: RunManager

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
    this.runManager = new RunManager(db)
  }

  async reconcile(dryRun: boolean): Promise<SyncResult> {
    const result: SyncResult = {
      reconciledRuns: [],
      expiredLeases: 0,
      orphanedWorktrees: [],
      labelCorrections: [],
    }

    // 1. Find all non-completed runs that can drift from forge state.
    // Prefer canonical issue rows, but fall back to runs-only rows during transitional states.
    const activeRuns = this.loadActiveRuns()

    for (const run of activeRuns) {
      if (run.status === 'running') {
        // Running runs require an active lease; if lease expired, reconcile.
        const issueRepo = resolveIssueRepoFromRun(run)
        const leased = this.leaseManager.isLeased(issueRepo, run.issue_number)
          || (issueRepo !== run.repo && this.leaseManager.isLeased(run.repo, run.issue_number))
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
      } else if (run.status === 'blocked' || run.status === 'review_ready' || run.status === 'error') {
        const action = await this.reconcileNonTerminalRun(run, dryRun)
        if (action) {
          result.reconciledRuns.push(action)
        }
      }
    }

    // 2. Check label mismatches for active, non-completed statuses
    const labelCorrections = await this.checkLabelMismatches(dryRun)
    result.labelCorrections = labelCorrections

    // 3. Clean expired leases
    if (!dryRun) {
      result.expiredLeases = this.leaseManager.cleanExpired()
    } else {
      // Count without deleting
      const count = this.db
        .prepare('SELECT COUNT(*) as c FROM leases WHERE leased_until < datetime(?)')
        .get(nowUtcIso()) as { c: number }
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

    // Check if PR exists and its state.
    const prState = await this.resolvePRState(forge, run)
    if (prState === 'merged') {
      return this.markCompleted(run, dryRun, 'PR merged', forge)
    }
    if (prState === 'open') {
      // PR exists and is open — mark as review_ready.
      return this.markReviewReady(run, dryRun, 'PR open but run stale', forge)
    }

    const issueState = await this.resolveIssueState(forge, run)
    if (issueState === 'closed') {
      return this.markClosed(run, dryRun, 'Issue closed externally', forge)
    }
    if (issueState === 'missing') {
      return this.markClosed(run, dryRun, 'Issue deleted or no longer accessible', forge)
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
    const issueState = await this.resolveIssueState(forge, run)
    if (issueState === 'closed') {
      return this.markClosed(run, dryRun, 'Issue closed while queued', forge)
    }
    if (issueState === 'missing') {
      return this.markClosed(run, dryRun, 'Issue deleted while queued', forge)
    }

    return null
  }

  private async reconcileNonTerminalRun(run: ActiveRunRow, dryRun: boolean): Promise<SyncAction | null> {
    let forge: ForgeAdapter
    try {
      forge = this.forgeFactory(run.repo)
    } catch {
      logger.warn({ repo: run.repo }, 'Cannot create forge adapter for non-terminal run reconciliation')
      return null
    }

    const prState = await this.resolvePRState(forge, run)
    if (prState === 'merged') {
      return this.markCompleted(run, dryRun, `PR merged while run was ${run.status}`, forge)
    }

    const issueState = await this.resolveIssueState(forge, run)
    if (issueState === 'closed') {
      return this.markClosed(run, dryRun, `Issue closed while run was ${run.status}`, forge)
    }
    if (issueState === 'missing') {
      return this.markClosed(run, dryRun, `Issue deleted while run was ${run.status}`, forge)
    }

    return null
  }

  private async resolveIssueState(
    forge: ForgeAdapter,
    run: Pick<ActiveRunRow, 'repo' | 'issue_number' | 'phase_data'>,
  ): Promise<'open' | 'closed' | 'missing' | 'unknown'> {
    const issueRepo = resolveIssueRepoFromRun(run)
    try {
      const issue = await forge.getIssue(issueRepo, run.issue_number)
      return issue.state === 'closed' ? 'closed' : 'open'
    } catch (err) {
      if (isNotFoundError(err)) {
        return 'missing'
      }
      logger.warn({ repo: issueRepo, issue: run.issue_number, err }, 'Failed to check issue state')
      return 'unknown'
    }
  }

  private async resolvePRState(
    forge: ForgeAdapter,
    run: Pick<ActiveRunRow, 'repo' | 'pr_number' | 'branch_name'>,
  ): Promise<'open' | 'closed' | 'merged' | 'missing' | 'unknown' | null> {
    if (!run.pr_number && !run.branch_name) {
      return null
    }

    let stateByNumber: 'open' | 'closed' | 'merged' | 'missing' | 'unknown' | null = null

    if (run.pr_number && forge.getPR) {
      try {
        const pr = await forge.getPR(run.repo, run.pr_number)
        stateByNumber = pr.state
      } catch (err) {
        if (isNotFoundError(err)) {
          stateByNumber = 'missing'
        } else {
          logger.warn({ repo: run.repo, prNumber: run.pr_number, err }, 'Failed to check PR state by number')
          stateByNumber = 'unknown'
        }
      }
    }

    const shouldFallbackToBranch = Boolean(run.branch_name) && (
      stateByNumber === null ||
      stateByNumber === 'missing' ||
      stateByNumber === 'closed' ||
      stateByNumber === 'unknown'
    )

    if (run.branch_name && shouldFallbackToBranch) {
      try {
        const pr = await forge.findPRByBranch(run.repo, run.branch_name)
        if (pr) {
          return pr.state
        }
      } catch (err) {
        logger.warn({ repo: run.repo, branch: run.branch_name, err }, 'Failed to check PR state by branch')
        return stateByNumber ?? 'unknown'
      }
    }

    return stateByNumber
  }

  private markCompleted(run: ActiveRunRow, dryRun: boolean, reason: string, forge: ForgeAdapter): SyncAction {
    if (!dryRun) {
      this.runManager.update(run.id, {
        status: 'completed',
        endedAt: nowUtcIso(),
      })
      const issueRepo = resolveIssueRepoFromRun(run)
      this.leaseManager.release(issueRepo, run.issue_number)
      if (issueRepo !== run.repo) {
        this.leaseManager.release(run.repo, run.issue_number)
      }
      this.updateLabels(forge, run, 'completed').catch((err) => {
        logger.debug({ repo: run.repo, issue: run.issue_number, err }, 'Label update failed while marking run completed')
      })
    }
    logger.info({ runId: run.id, repo: run.repo, issue: run.issue_number }, reason)
    return { repo: run.repo, issueNumber: run.issue_number, action: 'completed', reason, prNumber: run.pr_number }
  }

  private markClosed(run: ActiveRunRow, dryRun: boolean, reason: string, forge: ForgeAdapter): SyncAction {
    if (!dryRun) {
      this.runManager.update(run.id, {
        status: 'completed',
        endedAt: nowUtcIso(),
      })
      const issueRepo = resolveIssueRepoFromRun(run)
      this.leaseManager.release(issueRepo, run.issue_number)
      if (issueRepo !== run.repo) {
        this.leaseManager.release(run.repo, run.issue_number)
      }
      this.updateLabels(forge, run, 'completed').catch((err) => {
        logger.debug({ repo: run.repo, issue: run.issue_number, err }, 'Label update failed while marking run closed')
      })
    }
    logger.info({ runId: run.id, repo: run.repo, issue: run.issue_number }, reason)
    return { repo: run.repo, issueNumber: run.issue_number, action: 'closed', reason, prNumber: run.pr_number }
  }

  private markReviewReady(run: ActiveRunRow, dryRun: boolean, reason: string, forge: ForgeAdapter): SyncAction {
    if (!dryRun) {
      this.runManager.update(run.id, {
        status: 'review_ready',
      })
      const issueRepo = resolveIssueRepoFromRun(run)
      this.leaseManager.release(issueRepo, run.issue_number)
      if (issueRepo !== run.repo) {
        this.leaseManager.release(run.repo, run.issue_number)
      }
      this.updateLabels(forge, run, 'review_ready').catch((err) => {
        logger.debug({ repo: run.repo, issue: run.issue_number, err }, 'Label update failed while marking run review_ready')
      })
    }
    logger.info({ runId: run.id, repo: run.repo, issue: run.issue_number }, reason)
    return { repo: run.repo, issueNumber: run.issue_number, action: 'label_corrected', reason, prNumber: run.pr_number }
  }

  private async markStale(run: ActiveRunRow, dryRun: boolean, reason: string): Promise<SyncAction> {
    if (!dryRun) {
      this.runManager.update(run.id, {
        status: 'queued',
        currentPhase: null,
        lastError: reason,
      })
      const issueRepo = resolveIssueRepoFromRun(run)
      this.leaseManager.release(issueRepo, run.issue_number)
      if (issueRepo !== run.repo) {
        this.leaseManager.release(run.repo, run.issue_number)
      }

      // Transition labels back to queued (ready) so the poller picks it up
      const repoConfig = this.config.repos.find((r) => r.repo === run.repo)
      if (repoConfig) {
        try {
          const forge = this.forgeFactory(run.repo)
          const issue = await forge.getIssue(issueRepo, run.issue_number)
          const labelConfig = buildLabelConfig(repoConfig, issue.labels)
          await transitionLabels(forge, issueRepo, run.issue_number, issue.labels, 'running', 'queued', labelConfig)
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
      const issueRepo = resolveIssueRepoFromRun(run)
      const issue = await forge.getIssue(issueRepo, run.issue_number)
      const labelConfig = buildLabelConfig(repoConfig, issue.labels)
      const fromStatus = this.toRunStatus(run.status) ?? 'running'
      await transitionLabels(forge, issueRepo, run.issue_number, issue.labels, fromStatus, targetStatus, labelConfig)
    } catch (err) {
      logger.warn({ repo: run.repo, issue: run.issue_number, err }, 'Failed to update labels during sync')
    }
  }

  private async checkLabelMismatches(dryRun: boolean): Promise<LabelCorrection[]> {
    const corrections: LabelCorrection[] = []

    for (const run of this.loadActiveRuns()) {
      const repoConfig = this.config.repos.find((r) => r.repo === run.repo)
      if (!repoConfig) continue

      let forge: ForgeAdapter
      try {
        forge = this.forgeFactory(run.repo)
      } catch {
        continue
      }

      try {
        const issueRepo = resolveIssueRepoFromRun(run)
        const issue = await forge.getIssue(issueRepo, run.issue_number)
        const labelConfig = buildLabelConfig(repoConfig, issue.labels)

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
              await forge.removeLabels(issueRepo, run.issue_number, mutation.remove)
            }
            if (mutation.add.length > 0) {
              await forge.addLabels(issueRepo, run.issue_number, mutation.add)
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
    if (status === 'queued' || status === 'running' || status === 'blocked' || status === 'review_ready' || status === 'error' || status === 'completed') {
      return status
    }
    return null
  }

  private loadActiveRuns(): ActiveRunRow[] {
    return this.db
      .prepare(
         `WITH canonical_active AS (
           SELECT
             i.current_run_id AS id,
             i.repo,
             i.issue_number,
             i.status,
             i.pr_number,
             i.branch_name,
             i.worktree_path,
             r.phase_data
           FROM issues i
           LEFT JOIN runs r ON r.id = i.current_run_id
           WHERE i.status IN ('running', 'queued', 'blocked', 'review_ready', 'error')
             AND i.current_run_id IS NOT NULL
         ),
         fallback_active AS (
           SELECT
             r.id,
             r.repo,
             r.issue_number,
             r.status,
             r.pr_number,
             r.branch_name,
             r.worktree_path,
             r.phase_data
           FROM runs r
           WHERE r.status IN ('running', 'queued', 'blocked', 'review_ready', 'error')
             AND NOT EXISTS (
               SELECT 1
               FROM issues i
               WHERE i.repo = r.repo
                 AND i.issue_number = r.issue_number
                 AND i.current_run_id = r.id
                 AND i.status = r.status
             )
         )
         SELECT id, repo, issue_number, status, pr_number, branch_name, worktree_path, phase_data
         FROM canonical_active
         UNION ALL
         SELECT id, repo, issue_number, status, pr_number, branch_name, worktree_path, phase_data
         FROM fallback_active`,
      )
      .all() as ActiveRunRow[]
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

function getHttpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { status?: unknown; response?: { status?: unknown } }
  if (typeof e.status === 'number') return e.status
  if (typeof e.response?.status === 'number') return e.response.status
  return null
}

function isNotFoundError(err: unknown): boolean {
  return getHttpStatus(err) === 404
}

function resolveIssueRepoFromRun(run: Pick<ActiveRunRow, 'repo' | 'phase_data'>): string {
  if (!run.phase_data) return run.repo
  try {
    const phaseData = JSON.parse(run.phase_data) as Record<string, unknown>
    return resolveIssueRepo(phaseData, run.repo)
  } catch {
    // Ignore malformed phase data and fall back to run repo.
  }
  return run.repo
}
