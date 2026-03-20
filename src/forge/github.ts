import { Octokit } from '@octokit/rest'
import type { RepoConfig } from '../config/schema.js'
import type { ForgeAdapter, ForgeIssue, ForgePR, PRParams, ForgeAuthInfo } from './types.js'
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
      this.checkRateLimit()
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

  private mapPR(data: Record<string, unknown>): ForgePR {
    const d = data as {
      number: number
      title: string
      body: string | null
      state: string
      merged: boolean
      head: { ref: string }
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
      headBranch: d.head.ref,
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
