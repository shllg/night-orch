import type { RepoConfig } from '../config/schema.js'
import { slugify } from '../utils/ids.js'

/**
 * Whether this issue should run in planning-only mode.
 */
export function isPlanningIssue(
  issueLabels: string[],
  repoConfig: Pick<RepoConfig, 'labels'>,
): boolean {
  const planningLabel = repoConfig.labels?.planning
  if (!planningLabel) return false
  return issueLabels.includes(planningLabel)
}

/**
 * Deterministic PRD file path for planning-only mode.
 */
export function buildPlanningPrdPath(
  issueNumber: number,
  issueTitle: string,
  repoConfig: Pick<RepoConfig, 'planning'>,
): string {
  const prdDirectory = repoConfig.planning?.prdDirectory ?? 'docs/prd'
  const dir = normalizeRepoRelativePath(prdDirectory).replace(/\/+$/g, '')
  const slug = slugify(issueTitle, 60) || `issue-${issueNumber}`
  const filename = `${issueNumber}-${slug}.md`

  if (!dir || dir === '.') return filename
  return `${dir}/${filename}`
}

/**
 * Normalize repository-relative paths to a canonical git-style form.
 */
export function normalizeRepoRelativePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
}
