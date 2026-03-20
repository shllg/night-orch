import type { ForgeIssue } from '../forge/types.js'

export interface IssueSelector {
  includeLabelsAny: string[]
  excludeLabelsAny: string[]
}

/**
 * Check if an issue is eligible based on label selectors.
 * - Must have at least one of includeLabelsAny (empty = match all)
 * - Must have none of excludeLabelsAny (empty = exclude nothing)
 */
export function isEligible(issue: ForgeIssue, selector: IssueSelector): boolean {
  const issueLabels = new Set(issue.labels)

  // Exclude check (takes priority)
  if (selector.excludeLabelsAny.length > 0) {
    for (const excluded of selector.excludeLabelsAny) {
      if (issueLabels.has(excluded)) return false
    }
  }

  // Include check
  if (selector.includeLabelsAny.length === 0) return true

  for (const included of selector.includeLabelsAny) {
    if (issueLabels.has(included)) return true
  }

  return false
}

export function filterEligible(issues: ForgeIssue[], selector: IssueSelector): ForgeIssue[] {
  return issues.filter((issue) => isEligible(issue, selector))
}
