import { Octokit } from '@octokit/rest'
import type { RepoConfig } from '../config/schema.js'
import type {
  ForgeAdapter, ForgeIssue, ForgePR, PRParams, ForgeAuthInfo,
  ForgeComment, ForgePRReview, ForgePRReviewComment, PRReviewState, MergeMethod,
  PRCheckStatus, PRCheckRun, CheckConclusion,
} from './types.js'
import { logger } from '../utils/logger.js'

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`)
  return { owner, repo: name }
}

export class GitHubForgeAdapter implements ForgeAdapter {
  private octokit: Octokit

  constructor(token: string, baseUrl?: string) {
    this.octokit = new Octokit({
      auth: token,
      baseUrl: baseUrl ?? 'https://api.github.com',
    })
  }

  async listEligibleIssues(repoConfig: RepoConfig): Promise<ForgeIssue[]> {
    const { owner, repo } = splitRepo(repoConfig.repo)
    const includeLabels = repoConfig.selectors.includeLabelsAny

    // GitHub API filters by labels (AND), so we fetch with each include label
    // and deduplicate. For OR semantics with few labels, this is efficient enough.
    const seenNumbers = new Set<number>()
    const allIssues: ForgeIssue[] = []

    if (includeLabels.length === 0) {
      const issues = await this.octokit.paginate(
        this.octokit.rest.issues.listForRepo,
        {
          owner,
          repo,
          state: 'open',
          per_page: 100,
        },
      )
      for (const issue of issues) {
        if (issue.pull_request) continue
        if (seenNumbers.has(issue.number)) continue
        seenNumbers.add(issue.number)
        allIssues.push(this.mapIssue(issue, repoConfig.repo))
      }
      await this.checkRateLimit()
      return allIssues
    }

    for (const label of includeLabels) {
      const issues = await this.octokit.paginate(
        this.octokit.rest.issues.listForRepo,
        {
          owner,
          repo,
          state: 'open',
          labels: label,
          per_page: 100,
        },
      )

      for (const issue of issues) {
        // Skip pull requests (GitHub API includes them in issues)
        if (issue.pull_request) continue
        if (seenNumbers.has(issue.number)) continue
        seenNumbers.add(issue.number)

        allIssues.push(this.mapIssue(issue, repoConfig.repo))
      }

      // Check rate limit
      await this.checkRateLimit()
    }

    return allIssues
  }

  async getIssue(repo: string, issueNumber: number): Promise<ForgeIssue> {
    const { owner, repo: repoName } = splitRepo(repo)
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo: repoName,
      issue_number: issueNumber,
    })
    return this.mapIssue(data, repo)
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    const { owner, repo: repoName } = splitRepo(repo)
    await this.octokit.rest.issues.addLabels({
      owner,
      repo: repoName,
      issue_number: issueNumber,
      labels,
    })
  }

  async removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    for (const label of labels) {
      try {
        await this.octokit.rest.issues.removeLabel({
          owner,
          repo: repoName,
          issue_number: issueNumber,
          name: label,
        })
      } catch (err: unknown) {
        // 404 means label wasn't present — that's fine (idempotent)
        if (isOctokitError(err) && err.status === 404) continue
        throw err
      }
    }
  }

  async commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    await this.octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: issueNumber,
      body,
    })
  }

  async validateAuth(): Promise<ForgeAuthInfo> {
    const { data, headers } = await this.octokit.rest.users.getAuthenticated()
    const scopes = (headers['x-oauth-scopes'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
    return { user: data.login, scopes }
  }

  async isCollaborator(repo: string, username: string): Promise<boolean> {
    const { owner, repo: repoName } = splitRepo(repo)
    try {
      await this.octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo: repoName,
        username,
      })
      return true
    } catch (err: unknown) {
      if (isOctokitError(err) && err.status === 404) return false
      throw err
    }
  }

  // --- PR methods ---

  async createPR(repo: string, params: PRParams): Promise<ForgePR> {
    const { owner, repo: repoName } = splitRepo(repo)
    const { data } = await this.octokit.rest.pulls.create({
      owner,
      repo: repoName,
      title: params.title,
      body: params.body,
      head: params.headBranch,
      base: params.baseBranch,
      draft: params.draft ?? false,
    })
    return this.mapPR(data)
  }

  async updatePR(repo: string, prNumber: number, params: Partial<PRParams>): Promise<ForgePR> {
    const { owner, repo: repoName } = splitRepo(repo)
    const { data } = await this.octokit.rest.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      title: params.title,
      body: params.body,
    })
    return this.mapPR(data)
  }

  async findPRByBranch(repo: string, branch: string): Promise<ForgePR | null> {
    const { owner, repo: repoName } = splitRepo(repo)
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo: repoName,
      head: `${owner}:${branch}`,
      state: 'open',
      per_page: 1,
    })
    if (data.length === 0) return null
    return this.mapPR(data[0]!)
  }

  async getPR(repo: string, prNumber: number): Promise<ForgePR> {
    const { owner, repo: repoName } = splitRepo(repo)
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    })
    return this.mapPR(data)
  }

  async getPRDiff(repo: string, prNumber: number): Promise<string> {
    const { owner, repo: repoName } = splitRepo(repo)
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    })
    return data as unknown as string
  }

  async listIssueComments(repo: string, issueNumber: number): Promise<ForgeComment[]> {
    const { owner, repo: repoName } = splitRepo(repo)
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      { owner, repo: repoName, issue_number: issueNumber, per_page: 100 },
    )
    return comments.map((c) => ({
      id: c.id,
      body: c.body ?? '',
      user: c.user?.login ?? '',
      createdAt: c.created_at ?? '',
      updatedAt: c.updated_at ?? '',
    }))
  }

  async updateComment(repo: string, commentId: number, body: string): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    await this.octokit.rest.issues.updateComment({
      owner,
      repo: repoName,
      comment_id: commentId,
      body,
    })
  }

  async listPRReviews(repo: string, prNumber: number): Promise<ForgePRReview[]> {
    const { owner, repo: repoName } = splitRepo(repo)
    const reviews = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviews,
      { owner, repo: repoName, pull_number: prNumber, per_page: 100 },
    )
    return reviews.map((r) => ({
      id: r.id,
      user: r.user?.login ?? '',
      state: mapReviewState(r.state),
      body: r.body ?? '',
      submittedAt: r.submitted_at ?? '',
    }))
  }

  async listPRReviewComments(repo: string, prNumber: number): Promise<ForgePRReviewComment[]> {
    const { owner, repo: repoName } = splitRepo(repo)
    const comments = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviewComments,
      { owner, repo: repoName, pull_number: prNumber, per_page: 100 },
    )
    return comments.map((c) => ({
      id: c.id,
      user: c.user?.login ?? '',
      body: c.body ?? '',
      path: c.path ?? null,
      line: c.line ?? null,
      createdAt: c.created_at ?? '',
    }))
  }

  async mergePR(repo: string, prNumber: number, method: MergeMethod): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    await this.octokit.rest.pulls.merge({
      owner,
      repo: repoName,
      pull_number: prNumber,
      merge_method: method,
    })
  }

  async closePR(repo: string, prNumber: number): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    await this.octokit.rest.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      state: 'closed',
    })
  }

  async getPRCheckStatus(repo: string, prNumber: number): Promise<PRCheckStatus> {
    const { owner, repo: repoName } = splitRepo(repo)

    // Get the PR to find the head SHA
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    })
    const sha = pr.head.sha

    // Get combined status (legacy status API)
    const { data: combined } = await this.octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo: repoName,
      ref: sha,
    })

    // Get check runs (checks API)
    const { data: checkRuns } = await this.octokit.rest.checks.listForRef({
      owner,
      repo: repoName,
      ref: sha,
      per_page: 100,
    })

    const checks: PRCheckRun[] = []

    // Map legacy statuses
    for (const status of combined.statuses) {
      checks.push({
        name: status.context,
        conclusion: mapStatusState(status.state),
        detailsUrl: status.target_url ?? null,
      })
    }

    // Map check runs
    for (const run of checkRuns.check_runs) {
      checks.push({
        name: run.name,
        conclusion: mapCheckConclusion(run.status, run.conclusion),
        detailsUrl: run.details_url ?? null,
      })
    }

    // Determine overall status
    let overall: CheckConclusion = 'success'
    if (checks.length === 0) {
      overall = 'pending'
    } else if (checks.some((c) => c.conclusion === 'failure')) {
      overall = 'failure'
    } else if (checks.some((c) => c.conclusion === 'pending')) {
      overall = 'pending'
    }

    return { overall, checks }
  }

  async getRefCheckStatus(repo: string, ref: string): Promise<PRCheckStatus> {
    const { owner, repo: repoName } = splitRepo(repo)

    const { data: combined } = await this.octokit.rest.repos.getCombinedStatusForRef({
      owner, repo: repoName, ref,
    })

    const { data: checkRuns } = await this.octokit.rest.checks.listForRef({
      owner, repo: repoName, ref, per_page: 100,
    })

    const checks: PRCheckRun[] = []
    for (const status of combined.statuses) {
      checks.push({
        name: status.context,
        conclusion: mapStatusState(status.state),
        detailsUrl: status.target_url ?? null,
      })
    }
    for (const run of checkRuns.check_runs) {
      checks.push({
        name: run.name,
        conclusion: mapCheckConclusion(run.status, run.conclusion),
        detailsUrl: run.details_url ?? null,
      })
    }

    let overall: CheckConclusion = 'success'
    if (checks.length === 0) overall = 'pending'
    else if (checks.some((c) => c.conclusion === 'failure')) overall = 'failure'
    else if (checks.some((c) => c.conclusion === 'pending')) overall = 'pending'

    return { overall, checks }
  }

  async updateRef(repo: string, ref: string, sha: string, force = false): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    await this.octokit.rest.git.updateRef({
      owner,
      repo: repoName,
      ref: ref.replace(/^refs\//, ''),
      sha,
      force,
    })
  }

  private mapPR(data: Record<string, unknown>): ForgePR {
    const d = data as {
      number: number
      title: string
      body: string | null
      state: string
      merged: boolean
      mergeable?: boolean | null
      head: { ref: string; sha?: string }
      base: { ref: string }
      html_url: string
    }
    let state: ForgePR['state'] = 'open'
    if (d.merged) state = 'merged'
    else if (d.state === 'closed') state = 'closed'
    return {
      number: d.number,
      title: d.title,
      body: d.body ?? '',
      state,
      mergeable: typeof d.mergeable === 'boolean' ? d.mergeable : null,
      headBranch: d.head.ref,
      headSha: d.head.sha ?? '',
      baseBranch: d.base.ref,
      url: d.html_url,
    }
  }

  // --- Internals ---

  private mapIssue(data: Record<string, unknown>, _repoSlug: string): ForgeIssue {
    const d = data as {
      number: number
      node_id: string
      title: string
      body: string | null
      labels: Array<{ name?: string } | string>
      assignees?: Array<{ login: string }> | null
      state: string
      created_at: string
      updated_at: string
      html_url: string
    }
    return {
      number: d.number,
      nodeId: d.node_id,
      title: d.title,
      body: d.body ?? '',
      labels: d.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
      assignees: (d.assignees ?? []).map((a) => a.login),
      state: d.state === 'open' ? 'open' : 'closed',
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      url: d.html_url,
    }
  }

  private async checkRateLimit(): Promise<void> {
    try {
      const { data } = await this.octokit.rest.rateLimit.get()
      const core = data.resources.core
      const remaining = core.remaining
      const limit = core.limit
      const pct = remaining / limit

      if (pct < 0.2) {
        const resetAt = new Date(core.reset * 1000).toISOString()
        logger.warn(
          { remaining, limit, resetAt },
          `GitHub API rate limit low: ${remaining}/${limit} remaining (resets at ${resetAt})`,
        )
      }
    } catch {
      // Rate limit check itself failed — don't block on this
    }
  }
}

function isOctokitError(err: unknown): err is { status: number } {
  return typeof err === 'object' && err !== null && 'status' in err
}

function mapStatusState(state: string): CheckConclusion {
  switch (state) {
    case 'success': return 'success'
    case 'failure': case 'error': return 'failure'
    case 'pending': return 'pending'
    default: return 'pending'
  }
}

function mapCheckConclusion(status: string, conclusion: string | null): CheckConclusion {
  if (status !== 'completed') return 'pending'
  switch (conclusion) {
    case 'success': return 'success'
    case 'failure': case 'timed_out': return 'failure'
    case 'cancelled': return 'cancelled'
    case 'skipped': return 'skipped'
    case 'neutral': return 'neutral'
    default: return 'pending'
  }
}

function mapReviewState(state: string): PRReviewState {
  switch (state.toLowerCase()) {
    case 'approved': return 'approved'
    case 'changes_requested': return 'changes_requested'
    case 'dismissed': return 'dismissed'
    default: return 'commented'
  }
}
