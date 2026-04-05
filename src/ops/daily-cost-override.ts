import type Database from 'better-sqlite3'
import { CostTracker } from '../loop/cost.js'
import { utcDayKey } from '../utils/time.js'
import { logger } from '../utils/logger.js'

export interface DailyCostOverrideResult {
  date: string
  previousUsd: number | null
  overrideUsd: number | null
}

/**
 * Set or clear the daily cost cap override for today (UTC).
 * Pass `overrideUsd = null` to clear.
 *
 * The override auto-expires at 00:00 UTC — operators do not need to reset
 * it. Throws if the amount is non-positive.
 */
export function setDailyCostCapOverride(
  db: Database.Database,
  overrideUsd: number | null,
): DailyCostOverrideResult {
  const date = utcDayKey()
  const costTracker = new CostTracker(db)
  const previous = costTracker.getDailyCapOverride(date)
  costTracker.setDailyCapOverride(overrideUsd, date)

  logger.info(
    { date, previousUsd: previous, overrideUsd },
    overrideUsd === null ? 'Cleared daily cost cap override' : 'Set daily cost cap override',
  )

  return {
    date,
    previousUsd: previous,
    overrideUsd,
  }
}
