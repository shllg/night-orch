import type { RepoConfig } from '../config/schema.js'

export interface ForgeIssue {
  number: number
  nodeId: string | null
  title: string
  body: string
  labels: string[]
  assignees: string[]
  state: 'open' | 'closed'
  createdAt: string
  updatedAt: string
  url: string
}

export interface ForgePR {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  headBranch: string
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

  // PR methods (Phase 6 — stubs for now)

  /** Create a pull request. */
  createPR(repo: string, params: PRParams): Promise<ForgePR>

  /** Update a pull request. */
  updatePR(repo: string, prNumber: number, params: Partial<PRParams>): Promise<ForgePR>

  /** Find an open PR by head branch. */
  findPRByBranch(repo: string, branch: string): Promise<ForgePR | null>

  /** Get PR diff. */
  getPRDiff(repo: string, prNumber: number): Promise<string>
}
