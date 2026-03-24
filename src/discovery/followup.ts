import type Database from 'better-sqlite3'
import type { RunMode } from '../loop/types.js'

export interface FollowupContext {
  mode: RunMode
  prNumber: number | null
  branchName: string | null
  previousRunId: string | null
}

interface IssueLinkRow {
  branch_name: string | null
  pr_number: number | null
}

interface RunRow {
  id: string
  status: string
  branch_name: string | null
  pr_number: number | null
}

/**
 * Detect whether an issue should be processed as a fresh run or a followup
 * to an existing PR. Checks issue_links and runs tables for prior work.
 */
export function detectFollowup(
  db: Database.Database,
  repo: string,
  issueNumber: number,
): FollowupContext {
  // Check issue_links for existing PR association
  const link = db
    .prepare('SELECT branch_name, pr_number FROM issue_links WHERE repo = ? AND issue_number = ?')
    .get(repo, issueNumber) as IssueLinkRow | undefined

  if (!link?.pr_number) {
    return { mode: 'fresh', prNumber: null, branchName: null, previousRunId: null }
  }

  // Check for a prior run in review_ready or blocked status
  const run = db
    .prepare(
      "SELECT id, status, branch_name, pr_number FROM runs WHERE repo = ? AND issue_number = ? AND status IN ('review_ready', 'blocked') ORDER BY created_at DESC LIMIT 1",
    )
    .get(repo, issueNumber) as RunRow | undefined

  if (!run) {
    return { mode: 'fresh', prNumber: link.pr_number, branchName: link.branch_name, previousRunId: null }
  }

  return {
    mode: 'followup',
    prNumber: link.pr_number,
    branchName: link.branch_name ?? run.branch_name,
    previousRunId: run.id,
  }
}
