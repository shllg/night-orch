import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubForgeAdapter } from '../../src/forge/github.js'
import type { RepoConfig } from '../../src/config/schema.js'

// Suppress logger output in tests
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

function makeGitHubIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    node_id: 'MDU6SXNzdWUx',
    title: 'Test issue',
    body: 'Test body',
    labels: [{ name: 'bug' }],
    assignees: [{ login: 'user1' }],
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    html_url: 'https://github.com/org/repo/issues/1',
    ...overrides,
  }
}

function makeGitHubPR(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    title: 'PR title',
    body: 'PR body',
    state: 'open',
    merged: false,
    head: { ref: 'feature-branch', sha: 'sha-feature-branch' },
    base: { ref: 'main' },
    html_url: 'https://github.com/org/repo/pull/10',
    ...overrides,
  }
}

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: ['no:blocked', 'no:needs-human'],
      reviewReady: 'no:review-ready',
      error: 'no:error',
      retry: 'no:retry',
    },
    defaults: {
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
      doneMode: 'pr-ready',
      notifyPriority: 'normal',
      prMentions: [],
    },
    verify: [],
    selectors: {
      includeLabelsAny: ['no:ready'],
      excludeLabelsAny: ['no:blocked', 'no:error'],
    },
    agents: {},
    ...overrides,
  } as RepoConfig
}

// Mock Octokit at the module level
const mockPaginate = vi.fn()
const mockIssuesGet = vi.fn()
const mockIssuesAddLabels = vi.fn()
const mockIssuesRemoveLabel = vi.fn()
const mockIssuesCreateComment = vi.fn()
const mockIssuesListForRepo = vi.fn()
const mockUsersGetAuthenticated = vi.fn()
const mockPullsCreate = vi.fn()
const mockPullsUpdate = vi.fn()
const mockPullsList = vi.fn()
const mockPullsGet = vi.fn()
const mockRateLimitGet = vi.fn()
const mockReposGetCollaboratorPermissionLevel = vi.fn()
const mockOctokitConstructedOptions: unknown[] = []

vi.mock('@octokit/rest', () => {
  class MockOctokit {
    static plugin(..._plugins: unknown[]) {
      return MockOctokit
    }

    paginate = mockPaginate
    rest = {
      issues: {
        listForRepo: mockIssuesListForRepo,
        get: mockIssuesGet,
        addLabels: mockIssuesAddLabels,
        removeLabel: mockIssuesRemoveLabel,
        createComment: mockIssuesCreateComment,
      },
      users: {
        getAuthenticated: mockUsersGetAuthenticated,
      },
      pulls: {
        create: mockPullsCreate,
        update: mockPullsUpdate,
        list: mockPullsList,
        get: mockPullsGet,
      },
      repos: {
        getCollaboratorPermissionLevel: mockReposGetCollaboratorPermissionLevel,
      },
      rateLimit: {
        get: mockRateLimitGet,
      },
    }

    constructor(options?: unknown) {
      mockOctokitConstructedOptions.push(options)
    }
  }

  return {
    Octokit: MockOctokit,
  }
})

vi.mock('@octokit/plugin-throttling', () => ({ throttling: {} }))
vi.mock('@octokit/plugin-retry', () => ({ retry: {} }))

describe('GitHubForgeAdapter', () => {
  let adapter: GitHubForgeAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    mockOctokitConstructedOptions.length = 0
    // Default rate limit to be healthy
    mockRateLimitGet.mockResolvedValue({
      data: { resources: { core: { remaining: 5000, limit: 5000, reset: Date.now() / 1000 + 3600 } } },
    })
    adapter = new GitHubForgeAdapter('fake-token')
  })

  it('passes retry and throttle config to Octokit', () => {
    const options = mockOctokitConstructedOptions.at(-1) as {
      throttle?: { onRateLimit?: unknown; onSecondaryRateLimit?: unknown }
      retry?: { doNotRetry?: number[] }
    }

    expect(options.throttle?.onRateLimit).toEqual(expect.any(Function))
    expect(options.throttle?.onSecondaryRateLimit).toEqual(expect.any(Function))
    expect(options.retry?.doNotRetry).toEqual([400, 401, 403, 404, 422])
  })

  describe('getIssue', () => {
    it('returns a mapped ForgeIssue', async () => {
      mockIssuesGet.mockResolvedValue({ data: makeGitHubIssue() })

      const issue = await adapter.getIssue('org/repo', 1)

      expect(mockIssuesGet).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        issue_number: 1,
      })
      expect(issue).toEqual({
        number: 1,
        nodeId: 'MDU6SXNzdWUx',
        repo: 'org/repo',
        title: 'Test issue',
        body: 'Test body',
        labels: ['bug'],
        assignees: ['user1'],
        state: 'open',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        url: 'https://github.com/org/repo/issues/1',
      })
    })

    it('maps null body to empty string', async () => {
      mockIssuesGet.mockResolvedValue({ data: makeGitHubIssue({ body: null }) })

      const issue = await adapter.getIssue('org/repo', 1)
      expect(issue.body).toBe('')
    })

    it('maps null assignees to empty array', async () => {
      mockIssuesGet.mockResolvedValue({ data: makeGitHubIssue({ assignees: null }) })

      const issue = await adapter.getIssue('org/repo', 1)
      expect(issue.assignees).toEqual([])
    })

    it('handles string labels', async () => {
      mockIssuesGet.mockResolvedValue({ data: makeGitHubIssue({ labels: ['bug', 'enhancement'] }) })

      const issue = await adapter.getIssue('org/repo', 1)
      expect(issue.labels).toEqual(['bug', 'enhancement'])
    })

    it('filters labels with missing name', async () => {
      mockIssuesGet.mockResolvedValue({
        data: makeGitHubIssue({ labels: [{ name: 'bug' }, { name: undefined }, { name: '' }] }),
      })

      const issue = await adapter.getIssue('org/repo', 1)
      expect(issue.labels).toEqual(['bug'])
    })

    it('throws on invalid repo format', async () => {
      await expect(adapter.getIssue('invalid', 1)).rejects.toThrow('Invalid repo format')
    })
  })

  describe('listEligibleIssues', () => {
    it('fetches issues for each include label and deduplicates', async () => {
      const issue1 = makeGitHubIssue({ number: 1 })
      const issue2 = makeGitHubIssue({ number: 2 })

      // First label returns issues 1 and 2, second label returns issue 1 again
      mockPaginate
        .mockResolvedValueOnce([issue1, issue2])
        .mockResolvedValueOnce([issue1])

      const config = makeRepoConfig({
        selectors: {
          includeLabelsAny: ['no:ready', 'no:priority'],
          excludeLabelsAny: [],
        },
      })

      const issues = await adapter.listEligibleIssues(config)

      expect(mockPaginate).toHaveBeenCalledTimes(2)
      expect(issues).toHaveLength(2) // deduplicated
    })

    it('skips pull requests in issue results', async () => {
      const issue = makeGitHubIssue({ number: 1 })
      const pr = makeGitHubIssue({ number: 2, pull_request: { url: 'https://...' } })

      mockPaginate.mockResolvedValueOnce([issue, pr])

      const config = makeRepoConfig()
      const issues = await adapter.listEligibleIssues(config)

      expect(issues).toHaveLength(1)
      expect(issues[0]!.number).toBe(1)
    })

    it('fetches open issues when includeLabelsAny is empty', async () => {
      mockPaginate.mockResolvedValueOnce([makeGitHubIssue({ number: 1 })])

      const config = makeRepoConfig({
        selectors: {
          includeLabelsAny: [],
          excludeLabelsAny: [],
        },
      })
      const issues = await adapter.listEligibleIssues(config)

      expect(issues).toHaveLength(1)
      expect(mockPaginate).toHaveBeenCalledWith(
        mockIssuesListForRepo,
        expect.objectContaining({
          owner: 'org',
          repo: 'repo',
          state: 'open',
          per_page: 100,
        }),
      )
    })

    it('discovers issues from linkedProjects', async () => {
      mockPaginate
        .mockResolvedValueOnce([makeGitHubIssue({ number: 1, html_url: 'https://github.com/org/repo/issues/1' })])
        .mockResolvedValueOnce([makeGitHubIssue({ number: 2, html_url: 'https://github.com/org/tracker/issues/2' })])

      const config = makeRepoConfig({
        linkedProjects: ['org/tracker'],
        selectors: {
          includeLabelsAny: [],
          excludeLabelsAny: [],
        },
      })

      const issues = await adapter.listEligibleIssues(config)
      expect(issues).toHaveLength(2)
      expect(issues.map((i) => i.repo)).toEqual(['org/repo', 'org/tracker'])
      expect(mockPaginate).toHaveBeenNthCalledWith(
        2,
        mockIssuesListForRepo,
        expect.objectContaining({
          owner: 'org',
          repo: 'tracker',
        }),
      )
    })
  })

  describe('isCollaborator', () => {
    it('returns true for collaborators', async () => {
      mockReposGetCollaboratorPermissionLevel.mockResolvedValue({
        data: { permission: 'write' },
      })

      await expect(adapter.isCollaborator('org/repo', 'alice')).resolves.toBe(true)
      expect(mockReposGetCollaboratorPermissionLevel).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        username: 'alice',
      })
    })

    it('returns false for non-collaborators (404)', async () => {
      mockReposGetCollaboratorPermissionLevel.mockRejectedValue({ status: 404 })
      await expect(adapter.isCollaborator('org/repo', 'outsider')).resolves.toBe(false)
    })
  })

  describe('addLabels', () => {
    it('calls the API with correct params', async () => {
      mockIssuesAddLabels.mockResolvedValue({})

      await adapter.addLabels('org/repo', 1, ['bug', 'enhancement'])

      expect(mockIssuesAddLabels).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        issue_number: 1,
        labels: ['bug', 'enhancement'],
      })
    })

    it('skips API call for empty labels', async () => {
      await adapter.addLabels('org/repo', 1, [])
      expect(mockIssuesAddLabels).not.toHaveBeenCalled()
    })
  })

  describe('removeLabels', () => {
    it('removes each label individually', async () => {
      mockIssuesRemoveLabel.mockResolvedValue({})

      await adapter.removeLabels('org/repo', 1, ['bug', 'enhancement'])

      expect(mockIssuesRemoveLabel).toHaveBeenCalledTimes(2)
      expect(mockIssuesRemoveLabel).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        issue_number: 1,
        name: 'bug',
      })
    })

    it('ignores 404 errors (label not present)', async () => {
      mockIssuesRemoveLabel.mockRejectedValue({ status: 404 })

      await expect(adapter.removeLabels('org/repo', 1, ['nonexistent'])).resolves.toBeUndefined()
    })

    it('rethrows non-404 errors', async () => {
      mockIssuesRemoveLabel.mockRejectedValue({ status: 500, message: 'Server error' })

      await expect(adapter.removeLabels('org/repo', 1, ['bug'])).rejects.toEqual({ status: 500, message: 'Server error' })
    })
  })

  describe('commentOnIssue', () => {
    it('creates a comment', async () => {
      mockIssuesCreateComment.mockResolvedValue({})

      await adapter.commentOnIssue('org/repo', 1, 'Hello!')

      expect(mockIssuesCreateComment).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        issue_number: 1,
        body: 'Hello!',
      })
    })
  })

  describe('validateAuth', () => {
    it('returns user and scopes', async () => {
      mockUsersGetAuthenticated.mockResolvedValue({
        data: { login: 'bot-user' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      })

      const auth = await adapter.validateAuth()

      expect(auth.user).toBe('bot-user')
      expect(auth.scopes).toEqual(['repo', 'read:org'])
    })

    it('handles missing scopes header', async () => {
      mockUsersGetAuthenticated.mockResolvedValue({
        data: { login: 'bot-user' },
        headers: {},
      })

      const auth = await adapter.validateAuth()
      expect(auth.scopes).toEqual([])
    })
  })

  describe('createPR', () => {
    it('creates a PR and maps the response', async () => {
      mockPullsCreate.mockResolvedValue({ data: makeGitHubPR() })

      const pr = await adapter.createPR('org/repo', {
        title: 'PR title',
        body: 'PR body',
        headBranch: 'feature-branch',
        baseBranch: 'main',
      })

      expect(mockPullsCreate).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        title: 'PR title',
        body: 'PR body',
        head: 'feature-branch',
        base: 'main',
        draft: false,
      })
      expect(pr.number).toBe(10)
      expect(pr.state).toBe('open')
      expect(pr.headBranch).toBe('feature-branch')
      expect(pr.headSha).toBe('sha-feature-branch')
    })

    it('passes draft flag', async () => {
      mockPullsCreate.mockResolvedValue({ data: makeGitHubPR() })

      await adapter.createPR('org/repo', {
        title: 'Draft PR',
        body: '',
        headBranch: 'feature',
        baseBranch: 'main',
        draft: true,
      })

      expect(mockPullsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true }),
      )
    })
  })

  describe('updatePR', () => {
    it('updates and returns mapped PR', async () => {
      mockPullsUpdate.mockResolvedValue({ data: makeGitHubPR({ title: 'Updated' }) })

      const pr = await adapter.updatePR('org/repo', 10, { title: 'Updated' })

      expect(mockPullsUpdate).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        pull_number: 10,
        title: 'Updated',
        body: undefined,
      })
      expect(pr.title).toBe('Updated')
    })
  })

  describe('findPRByBranch', () => {
    it('returns PR when found', async () => {
      mockPullsList.mockResolvedValue({ data: [makeGitHubPR()] })

      const pr = await adapter.findPRByBranch('org/repo', 'feature-branch')

      expect(mockPullsList).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        head: 'org:feature-branch',
        state: 'open',
        per_page: 1,
      })
      expect(pr).not.toBeNull()
      expect(pr!.number).toBe(10)
    })

    it('returns null when no PR found', async () => {
      mockPullsList.mockResolvedValue({ data: [] })

      const pr = await adapter.findPRByBranch('org/repo', 'nonexistent')
      expect(pr).toBeNull()
    })
  })

  describe('getPRDiff', () => {
    it('returns diff string', async () => {
      mockPullsGet.mockResolvedValue({ data: '--- a/file.ts\n+++ b/file.ts\n' })

      const diff = await adapter.getPRDiff('org/repo', 10)

      expect(mockPullsGet).toHaveBeenCalledWith({
        owner: 'org',
        repo: 'repo',
        pull_number: 10,
        mediaType: { format: 'diff' },
      })
      expect(diff).toContain('file.ts')
    })
  })

  describe('PR state mapping', () => {
    it('maps merged PR correctly', async () => {
      mockPullsCreate.mockResolvedValue({ data: makeGitHubPR({ merged: true, state: 'closed' }) })

      const pr = await adapter.createPR('org/repo', {
        title: 'Merged',
        body: '',
        headBranch: 'f',
        baseBranch: 'main',
      })
      expect(pr.state).toBe('merged')
    })

    it('maps closed (not merged) PR correctly', async () => {
      mockPullsCreate.mockResolvedValue({ data: makeGitHubPR({ merged: false, state: 'closed' }) })

      const pr = await adapter.createPR('org/repo', {
        title: 'Closed',
        body: '',
        headBranch: 'f',
        baseBranch: 'main',
      })
      expect(pr.state).toBe('closed')
    })
  })
})
