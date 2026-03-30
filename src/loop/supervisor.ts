import { logger } from '../utils/logger.js'

export interface SupervisorHandle {
  cancel(): void
}

/**
 * Timer-based worker supervision.
 * Logs a warning at 80% of timeout, calls onStuck at 100%.
 */
export function superviseWorker(
  role: string,
  timeoutMs: number,
  onStuck: () => void,
): SupervisorHandle {
  const warningMs = Math.floor(timeoutMs * 0.8)

  const warningTimer = setTimeout(() => {
    logger.warn({ role, timeoutMs, elapsedMs: warningMs }, `${role} worker may be stuck — approaching timeout`)
  }, warningMs)

  const stuckTimer = setTimeout(() => {
    logger.error({ role, timeoutMs }, `${role} worker appears stuck — triggering timeout`)
    onStuck()
  }, timeoutMs)

  return {
    cancel() {
      clearTimeout(warningTimer)
      clearTimeout(stuckTimer)
    },
  }
}
