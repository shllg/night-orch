import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { createForgeAdapter } from '../forge/factory.js'
import { createWorktreeManager } from '../git/worktree.js'
import { LeaseManager } from '../state/leases.js'
import { statSync, readdirSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../utils/logger.js'

export interface CleanupOptions {
  completedWorktrees: boolean
  errorWorktreeAgeDays: number
  terminalWorktreeAgeDays: number
  orphanedWorktrees: boolean
  mergedBranches: boolean
  logArchiveAgeDays: number
  dryRun: boolean
}

export interface CleanupResult {
  removedWorktrees: string[]
  removedBranches: string[]
  expiredLeases: number
  archivedLogs: string[]
  freedDiskMb: number
}

const DEFAULT_OPTIONS: CleanupOptions = {
  completedWorktrees: true,
  errorWorktreeAgeDays: 7,
  terminalWorktreeAgeDays: 7,
  orphanedWorktrees: true,
  mergedBranches: false,
  logArchiveAgeDays: 30,
  dryRun: false,
}

interface WorktreeRunRow {
  status: string
  ended_at: string | null
  branch_name: string | null
  pr_number: number | null
}

export class CleanupEngine {
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

  async run(options: Partial<CleanupOptions> = {}): Promise<CleanupResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const result: CleanupResult = {
      removedWorktrees: [],
      removedBranches: [],
      expiredLeases: 0,
      archivedLogs: [],
      freedDiskMb: 0,
    }

    // 1. Clean expired leases
    if (!opts.dryRun) {
      result.expiredLeases = this.leaseManager.cleanExpired()
    } else {
      const count = this.db
        .prepare('SELECT COUNT(*) as c FROM leases WHERE leased_until < datetime(?)')
        .get(new Date().toISOString()) as { c: number }
      result.expiredLeases = count.c
    }

    // 2. Remove worktrees for completed/error runs
    const worktreeManager = createWorktreeManager()
    for (const repoConfig of this.config.repos) {
      try {
        const worktrees = await worktreeManager.list(repoConfig.localPath, this.config.storage.worktreeRoot)

        for (const wt of worktrees) {
          const row = this.db
            .prepare("SELECT status, ended_at, branch_name, pr_number FROM runs WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1")
            .get(wt.path) as WorktreeRunRow | undefined

          const shouldRemove = this.shouldRemoveWorktree(row, opts)
          if (!shouldRemove) continue

          const sizeMb = await this.estimateDirSizeMb(wt.path)

          const rowStatus = row?.status ?? 'orphaned'
          if (opts.dryRun) {
            logger.info({ path: wt.path, status: rowStatus }, '[dry-run] Would remove worktree')
          } else {
            try {
              await worktreeManager.remove(wt.path, false)
              result.freedDiskMb += sizeMb
              logger.info({ path: wt.path, status: rowStatus }, 'Removed worktree')
            } catch (err) {
              logger.warn({ path: wt.path, err }, 'Failed to remove worktree')
              continue
            }
          }
          result.removedWorktrees.push(wt.path)

          // Branch deletion for merged PRs
          if (opts.mergedBranches && row?.branch_name && row.pr_number && row.status === 'completed') {
            const isMerged = await this.isPrMerged(repoConfig.repo, row.pr_number)
            if (!isMerged) {
              logger.info(
                { repo: repoConfig.repo, prNumber: row.pr_number, branch: row.branch_name },
                'Skipping branch deletion: PR is not merged on forge',
              )
              continue
            }

            if (opts.dryRun) {
              logger.info({ branch: row.branch_name }, '[dry-run] Would delete branch')
            } else {
              try {
                const { execa } = await import('execa')
                await execa('git', ['branch', '-D', row.branch_name], { cwd: repoConfig.localPath })
                logger.info({ branch: row.branch_name }, 'Deleted merged branch')
              } catch (err) {
                logger.warn({ branch: row.branch_name, err }, 'Failed to delete branch')
                continue
              }
            }
            result.removedBranches.push(row.branch_name)
          }
        }
      } catch (err) {
        logger.warn({ repo: repoConfig.repo, err }, 'Failed to list worktrees for cleanup')
      }
    }

    // 3. Log archival
    const archived = this.archiveLogs(opts)
    result.archivedLogs = archived

    return result
  }

  private shouldRemoveWorktree(row: WorktreeRunRow | undefined, opts: CleanupOptions): boolean {
    // No matching run → orphaned worktree
    if (!row) return opts.orphanedWorktrees

    if (row.status === 'completed' && opts.completedWorktrees) {
      return true
    }

    if (row.status === 'error' && row.ended_at) {
      const ageDays = (Date.now() - new Date(row.ended_at).getTime()) / (1000 * 60 * 60 * 24)
      return ageDays >= opts.errorWorktreeAgeDays
    }

    // Blocked and review_ready: clean after terminalWorktreeAgeDays
    if ((row.status === 'blocked' || row.status === 'review_ready') && row.ended_at) {
      const ageDays = (Date.now() - new Date(row.ended_at).getTime()) / (1000 * 60 * 60 * 24)
      return ageDays >= opts.terminalWorktreeAgeDays
    }

    return false
  }

  private async estimateDirSizeMb(dirPath: string): Promise<number> {
    try {
      const { execa: execaFn } = await import('execa')
      const { stdout } = await execaFn('du', ['-sk', dirPath], { timeout: 10_000 })
      const firstField = stdout.split('\t')[0]
      const kb = parseInt(firstField ?? '0', 10)
      return Math.round(kb / 1024 * 100) / 100
    } catch {
      return 0
    }
  }

  private archiveLogs(opts: CleanupOptions): string[] {
    const archived: string[] = []
    const logsRoot = this.config.storage.logsRoot
    const archiveDir = join(dirname(logsRoot), 'logs-archive')

    try {
      const entries = readdirSync(logsRoot)
      const cutoff = Date.now() - opts.logArchiveAgeDays * 24 * 60 * 60 * 1000

      for (const entry of entries) {
        const fullPath = join(logsRoot, entry)
        try {
          const stat = statSync(fullPath)
          if (stat.mtimeMs < cutoff) {
            if (opts.dryRun) {
              logger.info({ path: fullPath }, '[dry-run] Would archive log')
            } else {
              mkdirSync(archiveDir, { recursive: true })
              renameSync(fullPath, join(archiveDir, entry))
              logger.info({ path: fullPath }, 'Archived log')
            }
            archived.push(fullPath)
          }
        } catch {
          // Skip individual file errors
        }
      }
    } catch {
      // Logs dir may not exist yet
      logger.debug({ logsRoot }, 'Logs directory not found for archival')
    }

    return archived
  }

  private async isPrMerged(repo: string, prNumber: number): Promise<boolean> {
    let forge: ForgeAdapter
    try {
      forge = this.forgeFactory(repo)
    } catch (err) {
      logger.warn({ repo, prNumber, err }, 'Cannot create forge adapter for merged-branch cleanup check')
      return false
    }

    if (typeof forge.getPR !== 'function') {
      logger.warn({ repo, prNumber }, 'Forge adapter does not support PR state lookup; skipping branch cleanup')
      return false
    }

    try {
      const pr = await forge.getPR(repo, prNumber)
      return pr.state === 'merged'
    } catch (err) {
      logger.warn({ repo, prNumber, err }, 'Failed to verify PR merge status; skipping branch cleanup')
      return false
    }
  }
}
