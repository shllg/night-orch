import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { LeaseManager } from '../state/leases.js'
import type { RunManager } from '../state/runs.js'
import type { IssueManager } from '../state/issues.js'
import type { MetricsService } from '../metrics/service.js'
import { discoverEligibleIssues, type DiscoveredIssue } from '../discovery/discover.js'
import { prioritizeDiscoveredIssues } from '../runner/helpers.js'
import { logger } from '../utils/logger.js'

/**
 * R6 boundary: issue discovery, optional targeted filtering,
 * upsert into the local issue cache, and priority ordering.
 *
 * The dispatcher downstream only wants "here's an ordered list of
 * things to work on" — this module handles every step that produces
 * that list and nothing else.
 */

export interface DiscoverIssuesForRepoParams {
  repoConfig: Config['repos'][number]
  forge: ForgeAdapter
  leaseManager: LeaseManager
  runManager: RunManager
  issueManager: IssueManager
  metrics?: MetricsService
  targetIssue?: { repo: string; issueNumber: number }
}

/**
 * Discover eligible issues for a single repo, applying the targeted
 * filter if provided, upserting them into the local issue cache, and
 * returning them in priority order (rebase > continue/retry > fresh).
 *
 * Returns an empty list when nothing is eligible; the caller decides
 * whether to log or short-circuit.
 */
export async function discoverIssuesForRepo(
  params: DiscoverIssuesForRepoParams,
): Promise<DiscoveredIssue[]> {
  const { repoConfig, forge, leaseManager, runManager, issueManager, metrics, targetIssue } = params

  const discoveredAll = await discoverEligibleIssues(repoConfig, forge, leaseManager)

  const discovered = targetIssue
    ? discoveredAll.filter((d) => {
        const issueRepo = d.issueRepo || d.issue.repo || repoConfig.repo
        return d.issue.number === targetIssue.issueNumber && issueRepo === targetIssue.repo
      })
    : prioritizeDiscoveredIssues(runManager, repoConfig.repo, discoveredAll)

  issueManager.upsertDiscovered(
    discovered.map((d) => ({
      repo: d.issueRepo || d.issue.repo || repoConfig.repo,
      issueNumber: d.issue.number,
      issueNodeId: d.issue.nodeId,
      issueTitle: d.issue.title,
    })),
  )

  try { metrics?.setEligibleIssues(repoConfig.repo, discovered.length) } catch { /* best-effort */ }

  if (discovered.length === 0) {
    logger.debug({ repo: repoConfig.repo }, 'No eligible issues')
  }

  return discovered
}
