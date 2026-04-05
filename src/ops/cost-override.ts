import type Database from 'better-sqlite3'
import { CostTracker } from '../loop/cost.js'
import { RunManager } from '../state/runs.js'
import { logger } from '../utils/logger.js'

export interface CostOverrideResult {
  runId: string
  repo: string
  issueNumber: number
  previousOverrideUsd: number | null
  overrideUsd: number | null
}

/**
 * Set or clear the cost budget override on the latest run for an issue.
 * Pass `overrideUsd = null` to clear.
 *
 * Throws if no run exists for the issue, or if the amount is non-positive.
 */
export function setIssueCostOverride(
  db: Database.Database,
  repo: string,
  issueNumber: number,
  overrideUsd: number | null,
): CostOverrideResult {
  const runManager = new RunManager(db)
  const run = runManager.getByRepoAndIssue(repo, issueNumber)
  if (!run) {
    throw new Error(`No run found for ${repo}#${issueNumber}`)
  }

  const costTracker = new CostTracker(db)
  const previous = costTracker.getRunBudgetOverride(run.id)
  costTracker.setRunBudgetOverride(run.id, overrideUsd)

  logger.info(
    { runId: run.id, repo, issueNumber, previousOverrideUsd: previous, overrideUsd },
    overrideUsd === null ? 'Cleared run cost budget override' : 'Set run cost budget override',
  )

  return {
    runId: run.id,
    repo,
    issueNumber,
    previousOverrideUsd: previous,
    overrideUsd,
  }
}
