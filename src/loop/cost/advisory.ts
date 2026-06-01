import { logger } from '../../utils/logger.js'
import { utcDayKey } from '../../utils/time.js'

/** Period key for warning dedup + month lookup: `YYYY-MM-DD` or `YYYY-MM`. */
export function quotaPeriodKey(period: 'day' | 'month'): string {
  const day = utcDayKey()
  return period === 'day' ? day : day.slice(0, 7)
}

export class SubscriptionAdvisoryWarnings {
  private readonly seen = new Set<string>()

  constructor(private readonly maxEntries = 1000) {}

  warnOnce(
    key: string,
    data: Record<string, unknown>,
    message: string,
  ): void {
    if (this.seen.has(key)) return
    if (this.seen.size >= Math.max(1, this.maxEntries)) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) {
        this.seen.delete(oldest)
      }
    }
    this.seen.add(key)
    logger.warn(data, message)
  }
}
