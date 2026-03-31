import type { RunListRow } from './data.js'

export interface TitleLookup {
  issues: Record<string, string>
  prs: Record<string, string>
}

export interface MissingIssueTitleTarget {
  key: string
  repo: string
  issueNumber: number
}

export interface MissingPrTitleTarget {
  key: string
  repo: string
  prNumber: number
}

export interface MissingTitleTargets {
  issues: MissingIssueTitleTarget[]
  prs: MissingPrTitleTarget[]
}

export function issueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`
}

export function prKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`
}

export function hasReadableTitle(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function resolveIssueTitle(run: RunListRow, lookup: TitleLookup): string | null {
  if (hasReadableTitle(run.issue_title)) {
    return run.issue_title.trim()
  }
  return lookup.issues[issueKey(run.repo, run.issue_number)] ?? null
}

export function resolvePrTitle(run: RunListRow, lookup: TitleLookup): string | null {
  if (run.pr_number === null) return null
  if (hasReadableTitle(run.pr_title)) {
    return run.pr_title.trim()
  }
  return lookup.prs[prKey(run.repo, run.pr_number)] ?? null
}

export function collectMissingTitleTargets(
  runs: RunListRow[],
  lookup: TitleLookup,
  attemptedIssueKeys: ReadonlySet<string>,
  attemptedPrKeys: ReadonlySet<string>,
  maxItems = 8,
): MissingTitleTargets {
  const issueTargets: MissingIssueTitleTarget[] = []
  const prTargets: MissingPrTitleTarget[] = []
  const seenIssue = new Set<string>()
  const seenPr = new Set<string>()

  for (const run of runs) {
    if (issueTargets.length >= maxItems && prTargets.length >= maxItems) {
      break
    }

    if (!hasReadableTitle(run.issue_title) && issueTargets.length < maxItems) {
      const key = issueKey(run.repo, run.issue_number)
      if (!lookup.issues[key] && !attemptedIssueKeys.has(key) && !seenIssue.has(key)) {
        seenIssue.add(key)
        issueTargets.push({ key, repo: run.repo, issueNumber: run.issue_number })
      }
    }

    if (run.pr_number !== null && !hasReadableTitle(run.pr_title) && prTargets.length < maxItems) {
      const key = prKey(run.repo, run.pr_number)
      if (!lookup.prs[key] && !attemptedPrKeys.has(key) && !seenPr.has(key)) {
        seenPr.add(key)
        prTargets.push({ key, repo: run.repo, prNumber: run.pr_number })
      }
    }
  }

  return { issues: issueTargets, prs: prTargets }
}
