import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import { CleanupEngine } from './cleanup.js'
import { RetentionEngine } from './retention.js'
import { logger } from '../utils/logger.js'

/**
 * Time-gated scheduler that runs cleanup and retention at configurable intervals.
 * Designed to be called on every poll cycle — skips when interval hasn't elapsed.
 */
export class AutoCleanupScheduler {
  private lastRunAt = 0

  constructor(
    private config: Config,
    private db: Database.Database,
  ) {}

  /** Swap in a reloaded config without resetting the time-gate. */
  setConfig(config: Config): void {
    this.config = config
  }

  async maybeRun(): Promise<void> {
    if (!this.config.storage.autoCleanup.enabled) return

    const intervalMs = this.config.storage.autoCleanup.intervalMinutes * 60_000
    if (Date.now() - this.lastRunAt < intervalMs) return

    this.lastRunAt = Date.now()
    logger.info('Auto-cleanup: starting scheduled run')

    try {
      const cleanup = new CleanupEngine(this.db, this.config)
      const cleanupResult = await cleanup.run({
        terminalWorktreeAgeDays: this.config.storage.retention.worktreeAgeDays,
        orphanedWorktrees: true,
      })

      logger.info(
        {
          removedWorktrees: cleanupResult.removedWorktrees.length,
          freedMb: cleanupResult.freedDiskMb,
          expiredLeases: cleanupResult.expiredLeases,
        },
        'Auto-cleanup: worktree cleanup complete',
      )
    } catch (err) {
      logger.warn({ err }, 'Auto-cleanup: worktree cleanup failed')
    }

    try {
      const retention = new RetentionEngine(this.db)
      const retentionResult = retention.prune({
        detailDays: this.config.storage.retention.detailDays,
        archiveDays: this.config.storage.retention.archiveDays,
        vacuum: false, // Only vacuum on explicit CLI cleanup
        dryRun: false,
      })

      logger.info(
        {
          compactedRuns: retentionResult.compactedRuns,
          deletedRuns: retentionResult.deletedRuns,
          deletedEvents: retentionResult.deletedEvents,
        },
        'Auto-cleanup: DB retention complete',
      )
    } catch (err) {
      logger.warn({ err }, 'Auto-cleanup: DB retention failed')
    }
  }
}
