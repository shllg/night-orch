import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { CostTracker } from '../loop/cost.js'
import { scanCostBlockedRuns } from './cost-resume.js'
import { logger } from '../utils/logger.js'

export interface DailyCostResetResult {
  date: string
  previousCostUsd: number
  resumedRuns: number
  stillBlocked: number
}

/**
 * Reset today's accumulated daily costs and auto-resume any cost-blocked runs.
 *
 * - Zeros `total_cost_usd`, `total_prompt_tokens`, `total_completion_tokens`,
 *   `total_cache_read_tokens` for today while preserving `daily_cost_cap_override_usd`
 * - Scans for cost-blocked runs and auto-resumes them (via `scanCostBlockedRuns`)
 *
 * Returns the previous daily cost and the number of runs that were resumed.
 */
export async function resetDailyCostsAndResume(
  db: Database.Database,
  config: Config,
  forge: ForgeAdapter,
): Promise<DailyCostResetResult> {
  const date = new Date().toISOString().split('T')[0] ?? ''
  const costTracker = new CostTracker(db)

  // Reset daily cost counters
  const { previousCostUsd } = costTracker.resetDailyCosts(date)

  logger.info({ date, previousCostUsd }, 'Reset daily costs — scanning for blocked runs to resume')

  // Scan and resume cost-blocked runs across all repos
  let totalResumed = 0
  let totalStillBlocked = 0

  const uniqueRepos = [...new Set(config.repos.map((r) => r.repo))]
  for (const repo of uniqueRepos) {
    const repoConfig = config.repos.find((r) => r.repo === repo)
    if (!repoConfig) continue

    try {
      // Pass empty string for botUser — scanCostBlockedRuns handles null/empty gracefully
      const result = await scanCostBlockedRuns(db, config, forge, repoConfig, '')
      totalResumed += result.resumed
      totalStillBlocked += result.stillBlocked
    } catch (err) {
      logger.warn({ repo, err }, 'Failed to scan cost-blocked runs during daily cost reset')
    }
  }

  logger.info(
    { date, previousCostUsd, resumedRuns: totalResumed, stillBlocked: totalStillBlocked },
    'Daily cost reset complete',
  )

  return {
    date,
    previousCostUsd,
    resumedRuns: totalResumed,
    stillBlocked: totalStillBlocked,
  }
}
