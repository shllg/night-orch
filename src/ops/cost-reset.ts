import type Database from 'better-sqlite3'
import { CostTracker } from '../loop/cost.js'
import { RunManager } from '../state/runs.js'
import { logger } from '../utils/logger.js'

export interface CostResetResult {
  runId: string
  repo: string
  issueNumber: number
  wasUnblocked: boolean
}

/**
 * Reset accumulated costs for the latest run of an issue.
 *
 * - Subtracts the run's cost from the daily total
 * - Zeros the run's `estimated_cost_usd`, `prompt_tokens`, `completion_tokens`, `cache_read_tokens`
 * - If the run was blocked with `block_reason = 'cost_limit'`, transitions status to `queued`
 *
 * Throws if no run exists for the issue.
 */
export function resetIssueCost(
  db: Database.Database,
  repo: string,
  issueNumber: number,
): CostResetResult {
  const runManager = new RunManager(db)
  const run = runManager.getByRepoAndIssue(repo, issueNumber)
  if (!run) {
    throw new Error(`No run found for ${repo}#${issueNumber}`)
  }

  const costTracker = new CostTracker(db)
  const result = costTracker.resetRunCost(run.id)

  logger.info(
    { runId: run.id, repo, issueNumber, wasUnblocked: result.wasUnblocked },
    result.wasUnblocked ? 'Reset cost and unblocked run' : 'Reset cost for run',
  )

  return {
    runId: run.id,
    repo,
    issueNumber,
    wasUnblocked: result.wasUnblocked,
  }
}
