import type { RepoConfig } from '../config/schema.js'
import type { ForgeAdapter, ForgeIssue } from '../forge/types.js'
import type { LeaseManager } from '../state/leases.js'
import { filterEligible } from './selector.js'
import { triageIssue, type TriageResult } from './triage.js'
import { logger } from '../utils/logger.js'

export interface DiscoveredIssue {
  issue: ForgeIssue
  triage: TriageResult
  repoConfig: RepoConfig
}

/**
 * Discover eligible issues for a repo:
 * 1. List issues from forge (already filtered by include labels via API)
 * 2. Apply local selector filter (include/exclude)
 * 3. Exclude already-leased issues
 * 4. Triage each issue
 * 5. Sort: trivial first, then standard, architectural last
 */
export async function discoverEligibleIssues(
  repoConfig: RepoConfig,
  forge: ForgeAdapter,
  leaseManager: LeaseManager,
): Promise<DiscoveredIssue[]> {
  logger.info({ repo: repoConfig.repo }, 'Discovering eligible issues')

  // 1. Fetch from forge
  const rawIssues = await forge.listEligibleIssues(repoConfig)
  logger.debug({ repo: repoConfig.repo, count: rawIssues.length }, 'Fetched issues from forge')

  // 2. Local filter
  const eligible = filterEligible(rawIssues, repoConfig.selectors)
  logger.debug({ repo: repoConfig.repo, count: eligible.length }, 'Issues after selector filter')

  // 3. Exclude leased
  const unleased = eligible.filter((issue) => {
    if (leaseManager.isLeased(repoConfig.repo, issue.number)) {
      logger.debug({ repo: repoConfig.repo, issue: issue.number }, 'Skipping leased issue')
      return false
    }
    return true
  })

  // 4. Triage
  const discovered: DiscoveredIssue[] = unleased.map((issue) => ({
    issue,
    triage: triageIssue(issue),
    repoConfig,
  }))

  // 5. Sort: trivial first (quick wins), standard, architectural last
  const order: Record<string, number> = { trivial: 0, standard: 1, architectural: 2 }
  discovered.sort((a, b) => (order[a.triage.level] ?? 1) - (order[b.triage.level] ?? 1))

  logger.info(
    {
      repo: repoConfig.repo,
      total: rawIssues.length,
      eligible: eligible.length,
      unleased: unleased.length,
      triageCounts: {
        trivial: discovered.filter((d) => d.triage.level === 'trivial').length,
        standard: discovered.filter((d) => d.triage.level === 'standard').length,
        architectural: discovered.filter((d) => d.triage.level === 'architectural').length,
      },
    },
    'Discovery complete',
  )

  return discovered
}
