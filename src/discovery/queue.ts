import type { RunManager, RunOperationIntent, RunRecord } from '../state/runs.js'
import type { DiscoveredIssue } from './discover.js'

/**
 * Prioritize discovered issues so queued follow-up control actions are
 * drained before fresh work.
 */
export function prioritizeDiscoveredIssues(
  runManager: RunManager,
  repo: string,
  discovered: DiscoveredIssue[],
): DiscoveredIssue[] {
  const ranked = discovered.map((item) => ({
    item,
    rank: getIssueQueuePriority(runManager, repo, item.issue.number),
  }))

  ranked.sort((a, b) => a.rank - b.rank)
  return ranked.map((entry) => entry.item)
}

function getIssueQueuePriority(
  runManager: RunManager,
  repo: string,
  issueNumber: number,
): number {
  const queuedRun = runManager.getLatestQueuedByIssue(repo, issueNumber)
  if (!queuedRun) return 3

  const operationIntent = resolveQueuedOperationIntent(queuedRun)
  if (operationIntent === 'rebase' || operationIntent === 'refresh') return 0
  if (operationIntent === 'continue' || operationIntent === 'retry') return 1
  return 2
}

function resolveQueuedOperationIntent(run: RunRecord): RunOperationIntent {
  if (run.operationIntent !== 'auto') return run.operationIntent
  if (run.blockReason === 'merge_conflict') return 'retry'

  const reactionType = run.phaseData?.reactionType
  if (reactionType === 'rebase') return 'rebase'
  if (reactionType === 'merge_conflict' || reactionType === 'refresh') return 'refresh'
  if (typeof reactionType === 'string' && reactionType.trim().length > 0) return 'continue'

  return 'auto'
}
