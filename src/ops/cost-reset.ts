import type Database from 'better-sqlite3'
import { createFollowupAttempt } from '../state/attempts.js'
import { RunManager } from '../state/runs.js'
import { logger } from '../utils/logger.js'

export interface CostResetResult {
  previousRunId: string
  newRunId: string
  repo: string
  issueNumber: number
  wasUnblocked: boolean
}

/**
 * "Reset the cost" of an issue's head attempt by inserting a fresh
 * successor attempt. Under the immutable-attempts model a mutable
 * cost-reset is impossible: the previous row is historical truth and
 * starting a new accounting window means starting a new attempt.
 *
 * The new attempt uses `continue` intent (branch, worktree, PR preserved)
 * so the operator's recovery path is "keep going, fresh cost counter".
 *
 * `wasUnblocked` is true when the previous attempt's status was
 * `blocked` with `cost_limit`, matching the semantics of the old
 * mutation-based cost-reset flow. Callers surface this to decide
 * whether label transitions need to run.
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

  const wasUnblocked = run.status === 'blocked' && run.blockReason === 'cost_limit'

  const result = createFollowupAttempt(db, {
    previousAttemptId: run.id,
    intent: 'continue',
    resetBranch: false,
    phaseData: run.phaseData,
    controlPayload: {
      source: 'cost_reset',
      requestedAt: new Date().toISOString(),
      preserveBranchState: true,
    },
  })

  logger.info(
    { previousRunId: run.id, newRunId: result.attemptId, repo, issueNumber, wasUnblocked },
    wasUnblocked ? 'Cost reset — new continue attempt queued and unblocked' : 'Cost reset — new continue attempt queued',
  )

  return {
    previousRunId: run.id,
    newRunId: result.attemptId,
    repo,
    issueNumber,
    wasUnblocked,
  }
}
