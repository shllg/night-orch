import type { RunManager } from '../state/runs.js'

export const TAINTED_BLOCK_REASONS = new Set([
  'agent_pass_limit',
  'merge_conflict',
  'auth_failure',
  'empty_diff',
])

export function shouldResetBranch(
  runManager: RunManager,
  repo: string,
  issueNumber: number,
  currentRunId: string,
): boolean {
  const prior = runManager.getLatestFinishedByIssue(repo, issueNumber, currentRunId)
  if (!prior) return false
  if (prior.status === 'error') return true
  if (prior.status === 'blocked' && prior.blockReason && TAINTED_BLOCK_REASONS.has(prior.blockReason)) return true
  return false
}
