import type Database from 'better-sqlite3'
import { LeaseManager } from '../state/leases.js'
import { logger } from '../utils/logger.js'

const SHUTDOWN_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export class ShutdownHandler {
  private shutdownRequested = false
  private currentRunPromise: Promise<void> | null = null

  constructor(
    private db: Database.Database,
    private timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
  ) {}

  get isShuttingDown(): boolean {
    return this.shutdownRequested
  }

  /**
   * Register signal handlers for graceful shutdown.
   * Returns cleanup function to remove handlers.
   */
  register(onShutdown?: () => Promise<void>): () => void {
    const handler = () => {
      if (this.shutdownRequested) {
        logger.warn('Forced shutdown — second signal received')
        process.exit(1)
      }
      this.shutdownRequested = true
      logger.info('Graceful shutdown requested — waiting for current run to complete')

      this.waitAndExit(onShutdown).catch((err) => {
        logger.error({ err }, 'Error during shutdown')
        process.exit(1)
      })
    }

    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)

    return () => {
      process.removeListener('SIGINT', handler)
      process.removeListener('SIGTERM', handler)
    }
  }

  /**
   * Track a running operation. The shutdown handler will wait for it to complete.
   */
  trackRun(promise: Promise<void>): void {
    this.currentRunPromise = promise
    promise.finally(() => {
      if (this.currentRunPromise === promise) {
        this.currentRunPromise = null
      }
    }).catch(() => {
      // Intentionally ignored: caller handles run errors.
    })
  }

  private async waitAndExit(onShutdown?: () => Promise<void>): Promise<void> {
    // Wait for current run or timeout
    if (this.currentRunPromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.warn({ timeoutMs: this.timeoutMs }, 'Shutdown timeout — forcing exit')
          resolve()
        }, this.timeoutMs)
      })

      await Promise.race([this.currentRunPromise, timeout])
    }

    // Release all leases
    try {
      const leaseManager = new LeaseManager(this.db)
      const cleared = leaseManager.releaseAll('poller')
      logger.debug({ cleared }, 'Released leases on shutdown')
    } catch {
      // DB may already be closed
    }

    // Custom shutdown hook
    if (onShutdown) {
      try {
        await onShutdown()
      } catch (err) {
        logger.warn({ err }, 'Error in shutdown hook')
      }
    }

    // Close DB
    try {
      this.db.close()
      logger.info('Database closed')
    } catch {
      // Already closed
    }

    logger.info('Shutdown complete')
    process.exit(0)
  }
}
