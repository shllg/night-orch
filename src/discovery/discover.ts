import type { RepoConfig } from '../config/schema.js'
import type { ForgeAdapter, ForgeIssue } from '../forge/types.js'
import type { LeaseManager } from '../state/leases.js'
import { isEligible, type IssueSelector } from './selector.js'
import { triageIssue, type TriageResult } from './triage.js'
import { logger } from '../utils/logger.js'
import { isKanbanIssue } from '../labels/config.js'

export interface DiscoveredIssue {
  issue: ForgeIssue
  issueRepo: string
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
  const eligible = rawIssues.filter((issue) => isIssueEligibleForRepo(issue, repoConfig))
  logger.debug({ repo: repoConfig.repo, count: eligible.length }, 'Issues after selector filter')

  // 3. Exclude leased
  const unleased = eligible.filter((issue) => {
    const issueRepo = resolveIssueRepo(issue, repoConfig.repo)
    if (leaseManager.isLeased(issueRepo, issue.number)) {
      logger.debug({ repo: issueRepo, issue: issue.number }, 'Skipping leased issue')
      return false
    }
    return true
  })

  // 4. Triage
  const discovered: DiscoveredIssue[] = unleased.map((issue) => ({
    issue,
    issueRepo: resolveIssueRepo(issue, repoConfig.repo),
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

export function isIssueEligibleForRepo(issue: ForgeIssue, repoConfig: RepoConfig): boolean {
  return isEligible(issue, buildSelectorForIssue(repoConfig, issue))
}

function buildSelectorForIssue(repoConfig: RepoConfig, issue: ForgeIssue): IssueSelector {
  if (!repoConfig.kanban || !isKanbanIssue(issue.labels, repoConfig)) {
    return repoConfig.selectors
  }

  const kanbanReady = Array.isArray(repoConfig.kanban.labels.ready)
    ? [...repoConfig.kanban.labels.ready]
    : [repoConfig.kanban.labels.ready]

  return {
    includeLabelsAny: kanbanReady,
    excludeLabelsAny: [
      repoConfig.kanban.labels.running,
      repoConfig.kanban.labels.blocked,
      repoConfig.kanban.labels.needsHuman,
      repoConfig.kanban.labels.reviewReady,
      repoConfig.kanban.labels.error,
      repoConfig.kanban.labels.retry,
    ],
  }
}

function resolveIssueRepo(
  issue: Pick<ForgeIssue, 'repo' | 'url'>,
  fallbackRepo: string,
): string {
  if (typeof issue.repo === 'string' && issue.repo.length > 0) {
    return issue.repo
  }

  try {
    const pathSegments = new URL(issue.url).pathname.split('/').filter(Boolean)
    const issuesIndex = pathSegments.lastIndexOf('issues')

    if (issuesIndex >= 2) {
      const owner = pathSegments[issuesIndex - 2]
      const repo = pathSegments[issuesIndex - 1]
      if (owner && repo) return `${owner}/${repo}`
    }

    const owner = pathSegments[0]
    const repo = pathSegments[1]
    if (owner && repo) return `${owner}/${repo}`
  } catch {
    // Ignore parse errors and use fallback.
  }

  return fallbackRepo
}
