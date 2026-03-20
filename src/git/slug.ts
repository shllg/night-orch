import type Database from 'better-sqlite3'
import { slugify } from '../utils/ids.js'

/**
 * Get or create a pinned slug for an issue.
 * First call: derives from title, stores in issue_links.
 * Subsequent calls: returns stored slug (title changes don't affect it).
 */
export function getOrPinSlug(
  db: Database.Database,
  repo: string,
  issueNumber: number,
  issueTitle: string,
): string {
  // Check for existing pinned slug
  const existing = db
    .prepare('SELECT branch_slug FROM issue_links WHERE repo = ? AND issue_number = ?')
    .get(repo, issueNumber) as { branch_slug: string } | undefined

  if (existing) return existing.branch_slug

  // Generate and pin
  const slug = slugify(issueTitle, 50) || 'untitled'
  const branchName = '' // Will be set by the caller when branch is actually created

  db.prepare(
    'INSERT OR IGNORE INTO issue_links (repo, issue_number, branch_name, branch_slug) VALUES (?, ?, ?, ?)',
  ).run(repo, issueNumber, branchName, slug)

  return slug
}

/**
 * Deterministic worktree path.
 * Example: ~/code/.night-orch/worktrees/myorg__myrepo/123/
 */
export function buildWorktreePath(
  worktreeRoot: string,
  repo: string,
  issueNumber: number,
): string {
  const safeRepo = repo.replace('/', '__')
  return `${worktreeRoot}/${safeRepo}/${issueNumber}`
}
