import type { RunManager } from '../state/runs.js'
import { resolveOperationIntent } from '../runner/intent.js'
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

  const operationIntent = resolveOperationIntent(queuedRun)
  if (operationIntent === 'rebase' || operationIntent === 'refresh') return 0
  if (operationIntent === 'continue' || operationIntent === 'retry') return 1
  return 2
}
