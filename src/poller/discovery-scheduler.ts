import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { LeaseManager } from '../state/leases.js'
import type { RunManager } from '../state/runs.js'
import type { IssueManager } from '../state/issues.js'
import type { MetricsService } from '../metrics/service.js'
import { discoverEligibleIssues, type DiscoveredIssue } from '../discovery/discover.js'
import { prioritizeDiscoveredIssues } from '../runner/helpers.js'
import { buildLabelConfig } from '../labels/config.js'
import { computeLabelMutation } from '../labels/transitions.js'
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
        return d.issue.number === targetIssue.issueNumber && d.issueRepo === targetIssue.repo
      })
    : prioritizeDiscoveredIssues(runManager, repoConfig.repo, discoveredAll)

  const dispatchable = await filterDispatchableIssues({
    discovered,
    forge,
    repoConfig,
    runManager,
  })

  issueManager.upsertDiscovered(
    dispatchable.map((d) => ({
      repo: d.issueRepo,
      issueNumber: d.issue.number,
      issueNodeId: d.issue.nodeId,
      issueTitle: d.issue.title,
    })),
  )

  try { metrics?.setEligibleIssues(repoConfig.repo, dispatchable.length) } catch { /* best-effort */ }

  if (dispatchable.length === 0) {
    logger.debug({ repo: repoConfig.repo }, 'No eligible issues')
  }

  return dispatchable
}

interface FilterDispatchableIssuesParams {
  discovered: DiscoveredIssue[]
  forge: ForgeAdapter
  repoConfig: Config['repos'][number]
  runManager: RunManager
}

async function filterDispatchableIssues(
  params: FilterDispatchableIssuesParams,
): Promise<DiscoveredIssue[]> {
  const { discovered, forge, repoConfig, runManager } = params
  const out: DiscoveredIssue[] = []

  for (const item of discovered) {
    const queuedRun = runManager.getLatestQueuedByIssue(repoConfig.repo, item.issue.number)
    if (queuedRun) {
      out.push(item)
      continue
    }

    const latestRun = runManager.getByRepoAndIssue(repoConfig.repo, item.issue.number)
    if (!latestRun || latestRun.status !== 'review_ready') {
      out.push(item)
      continue
    }

    logger.info(
      { repo: repoConfig.repo, issue: item.issue.number, runId: latestRun.id },
      'Skipping review_ready run with no queued control action',
    )

    const labelCfg = buildLabelConfig(repoConfig, item.issue.labels)
    const mutation = computeLabelMutation(
      'review_ready',
      'review_ready',
      item.issue.labels,
      labelCfg,
    )

    if (mutation.add.length > 0 || mutation.remove.length > 0) {
      try {
        if (mutation.add.length > 0) {
          await forge.addLabels(item.issueRepo, item.issue.number, mutation.add)
        }
        if (mutation.remove.length > 0) {
          await forge.removeLabels(item.issueRepo, item.issue.number, mutation.remove)
        }
      } catch (err) {
        logger.warn(
          { repo: item.issueRepo, issue: item.issue.number, err },
          'Failed to reconcile labels for skipped review_ready run',
        )
      }
    }
  }

  return out
}
