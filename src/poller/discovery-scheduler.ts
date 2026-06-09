import type { Config } from '../config/schema.js'
import type { ForgeAdapter, ForgeIssue } from '../forge/types.js'
import type { LeaseManager } from '../state/leases.js'
import type { RunManager, RunRecord } from '../state/runs.js'
import type { IssueManager } from '../state/issues.js'
import type { MetricsService } from '../metrics/service.js'
import { discoverEligibleIssues, type DiscoveredIssue } from '../discovery/discover.js'
import { prioritizeDiscoveredIssues } from '../discovery/queue.js'
import { triageIssue } from '../discovery/triage.js'
import { buildLabelConfig } from '../labels/config.js'
import { computeLabelMutation } from '../labels/transitions.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
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

  const discoveredAll = await includeQueuedDbRuns({
    discovered: await discoverEligibleIssues(repoConfig, forge, leaseManager),
    repoConfig,
    forge,
    runManager,
    leaseManager,
    targetIssue,
  })

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

interface IncludeQueuedDbRunsParams {
  discovered: DiscoveredIssue[]
  repoConfig: Config['repos'][number]
  forge: ForgeAdapter
  runManager: RunManager
  leaseManager: LeaseManager
  targetIssue?: { repo: string; issueNumber: number }
}

/**
 * Augment forge-discovered issues with queued DB runs that label-based
 * discovery may have missed.
 *
 * `retry --immediate` / `queue+signal` write a queued run row and transition
 * the forge label, then trigger a poll — but GitHub frequently hasn't
 * propagated the label yet, so `listEligibleIssues` returns nothing and the
 * queued run strands until a later cycle. Here we read the queued run(s)
 * straight from the DB and fetch each issue directly (`forge.getIssue`,
 * bypassing label filtering) so the run dispatches on the triggered cycle.
 *
 * Deliberately bypasses the include/exclude **label** selectors: those status
 * labels (ready/blocked/…) are exactly what lags propagation, so re-checking
 * them would reintroduce the race. A queued DB run is explicit operator/system
 * dispatch intent and wins over forge label state. The issue must still be
 * **open**, however — a closed issue is never resurrected just because a queued
 * row lingers.
 *
 * Issues already present from label discovery are not duplicated.
 */
async function includeQueuedDbRuns(params: IncludeQueuedDbRunsParams): Promise<DiscoveredIssue[]> {
  const { discovered, repoConfig, forge, runManager, leaseManager, targetIssue } = params

  // Both paths read the same live-top-level-queued predicate
  // (`listQueuedByRepo` excludes terminated rows + sub-runs); the targeted
  // path just narrows to the one issue. Using a single source avoids
  // resurrecting an abnormal terminated `queued` row on the immediate path.
  const queuedRuns: RunRecord[] = runManager
    .listQueuedByRepo(repoConfig.repo)
    .filter((run) => !targetIssue || run.issueNumber === targetIssue.issueNumber)

  if (queuedRuns.length === 0) return discovered

  const seen = new Set(discovered.map((d) => `${d.issueRepo}#${d.issue.number}`))
  const augmented = [...discovered]

  for (const run of queuedRuns) {
    const issueRepo = resolveIssueRepo(run.phaseData, run.repo)
    if (seen.has(`${issueRepo}#${run.issueNumber}`)) continue
    // A leased issue is already being processed by another worker — mirror
    // `discoverEligibleIssues`'s lease exclusion so we never double-dispatch.
    if (leaseManager.isLeased(issueRepo, run.issueNumber)) continue
    let issue: ForgeIssue
    try {
      issue = await forge.getIssue(issueRepo, run.issueNumber)
    } catch (err) {
      // A transient forge error must not strand the rest of the queue or
      // crash the poll cycle — skip this run; the next cycle retries it.
      logger.warn(
        { repo: issueRepo, issue: run.issueNumber, runId: run.id, err },
        'Failed to fetch queued issue for label-independent dispatch — skipping this cycle',
      )
      continue
    }
    if (issue.state !== 'open') {
      logger.info(
        { repo: issueRepo, issue: run.issueNumber, runId: run.id, state: issue.state },
        'Queued run targets a non-open issue — skipping label-independent dispatch',
      )
      continue
    }
    seen.add(`${issueRepo}#${run.issueNumber}`)
    augmented.push({ issue, issueRepo, triage: triageIssue(issue), repoConfig })
  }

  return augmented
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
