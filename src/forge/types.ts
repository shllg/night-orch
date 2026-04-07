import type { RepoConfig } from '../config/schema.js'

export interface ForgeComment {
  id: number
  body: string
  user: string
  createdAt: string
  updatedAt: string
}

export type PRReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed'

export interface ForgePRReview {
  id: number
  user: string
  state: PRReviewState
  body: string
  submittedAt: string
}

export interface ForgePRReviewComment {
  id: number
  user: string
  body: string
  path: string | null
  line: number | null
  createdAt: string
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** Normalized issue representation shared across forge backends. */
export interface ForgeIssue {
  number: number
  nodeId: string | null
  /** Canonical owner/name source repo for this issue (can differ from run repo). */
  repo?: string
  title: string
  body: string
  labels: string[]
  assignees: string[]
  state: 'open' | 'closed'
  createdAt: string
  updatedAt: string
  url: string
}

/** Normalized pull request representation shared across forge backends. */
export interface ForgePR {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  /** Null/undefined means unknown; false indicates merge conflicts with base. */
  mergeable?: boolean | null
  headBranch: string
  headSha: string
  baseBranch: string
  url: string
  diff?: string
}

export interface PRParams {
  title: string
  body: string
  headBranch: string
  baseBranch: string
  draft?: boolean
}

export interface ForgeAuthInfo {
  user: string
  scopes: string[]
}

/**
 * Platform-agnostic interface for issue trackers and code forges.
 * Implemented by GitHub and Forgejo adapters. All forge access MUST go through
 * this interface — never call Octokit or Forgejo APIs directly outside their adapter.
 */
export interface ForgeAdapter {
  /** List open issues matching label selectors for a repo. */
  listEligibleIssues(repo: RepoConfig): Promise<ForgeIssue[]>

  /** Get a single issue by number. */
  getIssue(repo: string, issueNumber: number): Promise<ForgeIssue>

  /** Add labels to an issue. Idempotent. */
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>

  /** Remove labels from an issue. No-op if label not present. */
  removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>

  /** Post a comment on an issue. */
  commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void>

  /** Validate auth — used by `doctor`. */
  validateAuth(): Promise<ForgeAuthInfo>

  /** Check whether a user is a repository collaborator. */
  isCollaborator?(repo: string, username: string): Promise<boolean>

  // PR methods (Phase 6 — stubs for now)

  /** Create a pull request. */
  createPR(repo: string, params: PRParams): Promise<ForgePR>

  /** Update a pull request. */
  updatePR(repo: string, prNumber: number, params: Partial<PRParams>): Promise<ForgePR>

  /** Find an open PR by head branch. */
  findPRByBranch(repo: string, branch: string): Promise<ForgePR | null>

  /** Get a PR by number. */
  getPR?(repo: string, prNumber: number): Promise<ForgePR>

  /** Get PR diff. */
  getPRDiff(repo: string, prNumber: number): Promise<string>

  /** List comments on an issue (includes PR conversation comments). */
  listIssueComments(repo: string, issueNumber: number): Promise<ForgeComment[]>

  /** Update an existing comment by ID. */
  updateComment(repo: string, commentId: number, body: string): Promise<void>

  /** List reviews on a pull request. */
  listPRReviews(repo: string, prNumber: number): Promise<ForgePRReview[]>

  /** List review-level comments on a pull request (inline code comments). */
  listPRReviewComments(repo: string, prNumber: number): Promise<ForgePRReviewComment[]>

  /** Merge a pull request. */
  mergePR(repo: string, prNumber: number, method: MergeMethod): Promise<void>

  /** Close a pull request without merging. */
  closePR(repo: string, prNumber: number): Promise<void>

  /** Get combined CI/check status for a PR's head commit. */
  getPRCheckStatus?(repo: string, prNumber: number): Promise<PRCheckStatus>

  /** Get CI/check status for an arbitrary ref or SHA. */
  getRefCheckStatus?(repo: string, ref: string): Promise<PRCheckStatus>

  /** Update a git reference (fast-forward merge via API). */
  updateRef?(repo: string, ref: string, sha: string, force?: boolean): Promise<void>
}

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'cancelled'

export interface PRCheckRun {
  name: string
  conclusion: CheckConclusion
  detailsUrl: string | null
}

export interface PRCheckStatus {
  overall: CheckConclusion
  checks: PRCheckRun[]
}
