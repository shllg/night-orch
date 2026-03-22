import type { RepoConfig } from '../config/schema.js'
import type { ForgeAdapter, ForgeIssue, ForgePR, PRParams, ForgeAuthInfo } from './types.js'
import { ForgejoClient, ForgejoApiError } from './forgejo-client.js'
import { LabelCache } from './forgejo-labels.js'

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`)
  return { owner, repo: name }
}

interface ForgejoIssueData {
  number: number
  title: string
  body: string | null
  labels: Array<{ name: string; id: number }>
  assignees: Array<{ login: string }> | null
  state: string
  created_at: string
  updated_at: string
  html_url: string
  pull_request?: unknown
}

interface ForgejoPRData {
  number: number
  title: string
  body: string | null
  state: string
  merged: boolean
  head: { ref: string }
  base: { ref: string }
  html_url: string
  diff_url?: string
}

export class ForgejoForgeAdapter implements ForgeAdapter {
  private readonly client: ForgejoClient
  private readonly labelCache: LabelCache
  private readonly apiBaseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(apiBaseUrl: string, token: string, timeoutMs = 30_000) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
    this.client = new ForgejoClient(apiBaseUrl, token, timeoutMs)
    this.labelCache = new LabelCache(this.client)
  }

  async listEligibleIssues(repoConfig: RepoConfig): Promise<ForgeIssue[]> {
    const { owner, repo } = splitRepo(repoConfig.repo)
    const includeLabels = repoConfig.selectors.includeLabelsAny

    const seenNumbers = new Set<number>()
    const allIssues: ForgeIssue[] = []

    if (includeLabels.length === 0) {
      const issues = await this.client.getPaginated<ForgejoIssueData>(
        `/repos/${owner}/${repo}/issues`,
        { state: 'open', type: 'issues' },
      )
      for (const issue of issues) {
        if (issue.pull_request) continue
        if (seenNumbers.has(issue.number)) continue
        seenNumbers.add(issue.number)
        allIssues.push(this.mapIssue(issue, repoConfig.repo))
      }
      return allIssues
    }

    for (const label of includeLabels) {
      const issues = await this.client.getPaginated<ForgejoIssueData>(
        `/repos/${owner}/${repo}/issues`,
        { state: 'open', labels: label, type: 'issues' },
      )

      for (const issue of issues) {
        if (issue.pull_request) continue
        if (seenNumbers.has(issue.number)) continue
        seenNumbers.add(issue.number)
        allIssues.push(this.mapIssue(issue, repoConfig.repo))
      }
    }

    return allIssues
  }

  async getIssue(repo: string, issueNumber: number): Promise<ForgeIssue> {
    const { owner, repo: repoName } = splitRepo(repo)
    const data = await this.client.get<ForgejoIssueData>(
      `/repos/${owner}/${repoName}/issues/${issueNumber}`,
    )
    return this.mapIssue(data, repo)
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    const { owner, repo: repoName } = splitRepo(repo)
    this.labelCache.invalidate(repo)

    const ids: number[] = []
    for (const name of labels) {
      const id = await this.labelCache.getIdByName(repo, name)
      if (id !== null) ids.push(id)
    }

    if (ids.length === 0) return

    await this.client.post(
      `/repos/${owner}/${repoName}/issues/${issueNumber}/labels`,
      { labels: ids },
    )
  }

  async removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    this.labelCache.invalidate(repo)

    for (const name of labels) {
      const id = await this.labelCache.getIdByName(repo, name)
      if (id === null) continue

      try {
        await this.client.delete(
          `/repos/${owner}/${repoName}/issues/${issueNumber}/labels/${id}`,
        )
      } catch (err: unknown) {
        // 404 means label wasn't present — that's fine (idempotent)
        if (err instanceof ForgejoApiError && err.status === 404) continue
        throw err
      }
    }
  }

  async commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void> {
    const { owner, repo: repoName } = splitRepo(repo)
    await this.client.post(
      `/repos/${owner}/${repoName}/issues/${issueNumber}/comments`,
      { body },
    )
  }

  async validateAuth(): Promise<ForgeAuthInfo> {
    const data = await this.client.get<{ login: string }>('/user')
    return { user: data.login, scopes: [] }
  }

  // --- PR methods ---

  async createPR(repo: string, params: PRParams): Promise<ForgePR> {
    const { owner, repo: repoName } = splitRepo(repo)
    const data = await this.client.post<ForgejoPRData>(
      `/repos/${owner}/${repoName}/pulls`,
      {
        title: params.title,
        body: params.body,
        head: params.headBranch,
        base: params.baseBranch,
      },
    )
    return this.mapPR(data)
  }

  async updatePR(repo: string, prNumber: number, params: Partial<PRParams>): Promise<ForgePR> {
    const { owner, repo: repoName } = splitRepo(repo)
    const data = await this.client.patch<ForgejoPRData>(
      `/repos/${owner}/${repoName}/pulls/${prNumber}`,
      {
        title: params.title,
        body: params.body,
      },
    )
    return this.mapPR(data)
  }

  async findPRByBranch(repo: string, branch: string): Promise<ForgePR | null> {
    const { owner, repo: repoName } = splitRepo(repo)
    const pulls = await this.client.get<ForgejoPRData[]>(
      `/repos/${owner}/${repoName}/pulls`,
      { state: 'open', limit: '50' },
    )
    const match = pulls.find((p) => p.head.ref === branch)
    return match ? this.mapPR(match) : null
  }

  async getPRDiff(repo: string, prNumber: number): Promise<string> {
    const { owner, repo: repoName } = splitRepo(repo)
    const url = `/repos/${owner}/${repoName}/pulls/${prNumber}.diff`
    const res = await fetch(
      `${this.apiBaseUrl}${url}`,
      {
        headers: {
          Authorization: `token ${this.token}`,
          Accept: 'text/plain',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    )
    if (!res.ok) {
      throw new ForgejoApiError(res.status, res.statusText, `Failed to get diff for PR #${prNumber}`)
    }
    return res.text()
  }

  // --- Internal mapping ---

  private mapIssue(data: ForgejoIssueData, _repoSlug: string): ForgeIssue {
    return {
      number: data.number,
      nodeId: null,
      title: data.title,
      body: data.body ?? '',
      labels: data.labels.map((l) => l.name).filter(Boolean),
      assignees: (data.assignees ?? []).map((a) => a.login),
      state: data.state === 'open' ? 'open' : 'closed',
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      url: data.html_url,
    }
  }

  private mapPR(data: ForgejoPRData): ForgePR {
    let state: ForgePR['state'] = 'open'
    if (data.merged) state = 'merged'
    else if (data.state === 'closed') state = 'closed'
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      state,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      url: data.html_url,
    }
  }
}
