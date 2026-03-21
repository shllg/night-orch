import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ForgeAdapter, ForgeIssue, ForgePR, PRParams } from '../../src/forge/types.js'
import { GitHubForgeAdapter } from '../../src/forge/github.js'
import { ForgejoForgeAdapter } from '../../src/forge/forgejo.js'
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

function makeGitHubIssueData(number: number) {
  return {
    number,
    node_id: `MDU6SXNzdWUx${number}`,
    title: `Issue #${number}`,
    body: `Body for issue ${number}`,
    labels: [{ name: 'orch:ready' }],
    assignees: [{ login: 'user1' }],
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    html_url: `https://github.com/org/repo/issues/${number}`,
  }
}

function makeGitHubPRData(number: number) {
  return {
    number,
    title: `PR #${number}`,
    body: `Body for PR ${number}`,
    state: 'open',
    merged: false,
    head: { ref: `feature-${number}` },
    base: { ref: 'main' },
    html_url: `https://github.com/org/repo/pull/${number}`,
  }
}

// --- Forgejo mock data ---

function makeForgejoIssueData(number: number) {
  return {
    number,
    title: `Issue #${number}`,
    body: `Body for issue ${number}`,
    labels: [{ id: 1, name: 'orch:ready' }],
    assignees: [{ login: 'user1' }],
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    html_url: `https://forgejo.example.com/org/repo/issues/${number}`,
  }
}

function makeForgejoPRData(number: number) {
  return {
    number,
    title: `PR #${number}`,
    body: `Body for PR ${number}`,
    state: 'open',
    merged: false,
    head: { ref: `feature-${number}` },
    base: { ref: 'main' },
    html_url: `https://forgejo.example.com/org/repo/pulls/${number}`,
  }
}

const FORGEJO_REPO_LABELS = [
  { id: 1, name: 'orch:ready' },
  { id: 2, name: 'new-label' },
  { id: 3, name: 'old-label' },
]

const mockFetchFn = vi.fn()

function forgejoJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function makeRepoConfig(): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: {
      ready: ['orch:ready'],
      running: 'orch:running',
      blocked: ['orch:blocked', 'orch:needs-human'],
      reviewReady: 'orch:review-ready',
      error: 'orch:error',
      retry: 'orch:retry',
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
      includeLabelsAny: ['orch:ready'],
      excludeLabelsAny: [],
    },
    agents: {},
  } as RepoConfig
}

// --- Mock setup for GitHub adapter ---

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

vi.mock('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
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
        rateLimit: {
          get: mockRateLimitGet,
        },
      }
    },
  }
})

/**
 * Shared contract test suite that any ForgeAdapter implementation must satisfy.
 * Parameterized: add new adapters by adding a new entry to the adapters array.
 */
interface AdapterFactory {
  name: string
  create: () => ForgeAdapter
  setupMocks: () => void
}

const adapters: AdapterFactory[] = [
  {
    name: 'GitHubForgeAdapter',
    create: () => new GitHubForgeAdapter('fake-token'),
    setupMocks: () => {
      mockRateLimitGet.mockResolvedValue({
        data: { resources: { core: { remaining: 5000, limit: 5000, reset: Date.now() / 1000 + 3600 } } },
      })
      mockIssuesGet.mockResolvedValue({ data: makeGitHubIssueData(1) })
      mockPaginate.mockResolvedValue([makeGitHubIssueData(1), makeGitHubIssueData(2)])
      mockIssuesAddLabels.mockResolvedValue({})
      mockIssuesRemoveLabel.mockResolvedValue({})
      mockIssuesCreateComment.mockResolvedValue({})
      mockUsersGetAuthenticated.mockResolvedValue({
        data: { login: 'bot' },
        headers: { 'x-oauth-scopes': 'repo' },
      })
      mockPullsCreate.mockResolvedValue({ data: makeGitHubPRData(10) })
      mockPullsUpdate.mockResolvedValue({ data: makeGitHubPRData(10) })
      mockPullsList.mockResolvedValue({ data: [makeGitHubPRData(10)] })
      mockPullsGet.mockResolvedValue({ data: '--- a/file\n+++ b/file\n' })
    },
  },
  {
    name: 'ForgejoForgeAdapter',
    create: () => {
      vi.stubGlobal('fetch', mockFetchFn)
      return new ForgejoForgeAdapter('https://forgejo.example.com/api/v1', 'fake-token')
    },
    setupMocks: () => {
      mockFetchFn.mockReset()
      mockFetchFn.mockImplementation((url: string, options?: { method?: string }) => {
        const method = options?.method ?? 'GET'
        const urlStr = url.toString()

        // GET /user
        if (method === 'GET' && urlStr.includes('/user') && !urlStr.includes('/repos/')) {
          return Promise.resolve(forgejoJsonResponse({ login: 'bot' }))
        }

        // GET labels (for cache)
        if (method === 'GET' && urlStr.includes('/labels') && !urlStr.includes('/issues/')) {
          return Promise.resolve(forgejoJsonResponse(FORGEJO_REPO_LABELS))
        }

        // GET single issue
        if (method === 'GET' && /\/issues\/\d+$/.test(urlStr)) {
          return Promise.resolve(forgejoJsonResponse(makeForgejoIssueData(1)))
        }

        // GET issues list (for listEligibleIssues)
        if (method === 'GET' && urlStr.includes('/issues')) {
          return Promise.resolve(forgejoJsonResponse([
            makeForgejoIssueData(1),
            makeForgejoIssueData(2),
          ]))
        }

        // POST labels
        if (method === 'POST' && urlStr.includes('/labels')) {
          return Promise.resolve(forgejoJsonResponse([]))
        }

        // DELETE label
        if (method === 'DELETE' && urlStr.includes('/labels/')) {
          return Promise.resolve(forgejoJsonResponse(undefined, 204))
        }

        // POST comment
        if (method === 'POST' && urlStr.includes('/comments')) {
          return Promise.resolve(forgejoJsonResponse({ id: 1 }))
        }

        // POST pulls (create PR)
        if (method === 'POST' && urlStr.includes('/pulls')) {
          return Promise.resolve(forgejoJsonResponse(makeForgejoPRData(10)))
        }

        // PATCH pulls (update PR)
        if (method === 'PATCH' && urlStr.includes('/pulls/')) {
          return Promise.resolve(forgejoJsonResponse(makeForgejoPRData(10)))
        }

        // GET pulls list (findPRByBranch)
        if (method === 'GET' && urlStr.includes('/pulls') && !urlStr.includes('.diff')) {
          return Promise.resolve(forgejoJsonResponse([makeForgejoPRData(10)]))
        }

        // GET PR diff
        if (method === 'GET' && urlStr.includes('.diff')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: () => Promise.resolve('--- a/file\n+++ b/file\n'),
          } as unknown as Response)
        }

        return Promise.resolve(forgejoJsonResponse({ message: 'Not mocked' }, 404))
      })
    },
  },
]

afterEach(() => {
  vi.restoreAllMocks()
})

for (const { name, create, setupMocks } of adapters) {
  describe(`ForgeAdapter contract: ${name}`, () => {
    let adapter: ForgeAdapter

    beforeEach(() => {
      vi.clearAllMocks()
      setupMocks()
      adapter = create()
    })

    // --- Issue methods ---

    describe('getIssue', () => {
      it('returns a ForgeIssue with all required fields', async () => {
        const issue = await adapter.getIssue('org/repo', 1)

        expect(issue).toHaveProperty('number')
        expect(issue).toHaveProperty('nodeId')
        expect(issue).toHaveProperty('title')
        expect(issue).toHaveProperty('body')
        expect(issue).toHaveProperty('labels')
        expect(issue).toHaveProperty('assignees')
        expect(issue).toHaveProperty('state')
        expect(issue).toHaveProperty('createdAt')
        expect(issue).toHaveProperty('updatedAt')
        expect(issue).toHaveProperty('url')

        expect(typeof issue.number).toBe('number')
        expect(issue.nodeId === null || typeof issue.nodeId === 'string').toBe(true)
        expect(typeof issue.title).toBe('string')
        expect(typeof issue.body).toBe('string')
        expect(Array.isArray(issue.labels)).toBe(true)
        expect(Array.isArray(issue.assignees)).toBe(true)
        expect(['open', 'closed']).toContain(issue.state)
        expect(typeof issue.createdAt).toBe('string')
        expect(typeof issue.updatedAt).toBe('string')
        expect(typeof issue.url).toBe('string')
      })
    })

    describe('listEligibleIssues', () => {
      it('returns an array of ForgeIssues', async () => {
        const issues = await adapter.listEligibleIssues(makeRepoConfig())

        expect(Array.isArray(issues)).toBe(true)
        expect(issues.length).toBeGreaterThan(0)

        const issue = issues[0]!
        expect(issue).toHaveProperty('number')
        expect(issue).toHaveProperty('title')
        expect(issue).toHaveProperty('labels')
      })
    })

    describe('addLabels', () => {
      it('completes without error', async () => {
        await expect(adapter.addLabels('org/repo', 1, ['new-label'])).resolves.toBeUndefined()
      })

      it('handles empty labels without error', async () => {
        await expect(adapter.addLabels('org/repo', 1, [])).resolves.toBeUndefined()
      })
    })

    describe('removeLabels', () => {
      it('completes without error', async () => {
        await expect(adapter.removeLabels('org/repo', 1, ['old-label'])).resolves.toBeUndefined()
      })
    })

    describe('commentOnIssue', () => {
      it('completes without error', async () => {
        await expect(adapter.commentOnIssue('org/repo', 1, 'A comment')).resolves.toBeUndefined()
      })
    })

    // --- Auth ---

    describe('validateAuth', () => {
      it('returns user and scopes', async () => {
        const auth = await adapter.validateAuth()

        expect(auth).toHaveProperty('user')
        expect(auth).toHaveProperty('scopes')
        expect(typeof auth.user).toBe('string')
        expect(Array.isArray(auth.scopes)).toBe(true)
      })
    })

    // --- PR methods ---

    describe('createPR', () => {
      it('returns a ForgePR with all required fields', async () => {
        const pr = await adapter.createPR('org/repo', {
          title: 'Test PR',
          body: 'Test body',
          headBranch: 'feature',
          baseBranch: 'main',
        })

        expect(pr).toHaveProperty('number')
        expect(pr).toHaveProperty('title')
        expect(pr).toHaveProperty('body')
        expect(pr).toHaveProperty('state')
        expect(pr).toHaveProperty('headBranch')
        expect(pr).toHaveProperty('baseBranch')
        expect(pr).toHaveProperty('url')

        expect(typeof pr.number).toBe('number')
        expect(['open', 'closed', 'merged']).toContain(pr.state)
      })
    })

    describe('updatePR', () => {
      it('returns updated ForgePR', async () => {
        const pr = await adapter.updatePR('org/repo', 10, { title: 'Updated' })

        expect(pr).toHaveProperty('number')
        expect(pr).toHaveProperty('title')
      })
    })

    describe('findPRByBranch', () => {
      it('returns ForgePR or null', async () => {
        const pr = await adapter.findPRByBranch('org/repo', 'feature-10')

        // Contract: returns ForgePR | null
        if (pr !== null) {
          expect(pr).toHaveProperty('number')
          expect(pr).toHaveProperty('headBranch')
        }
      })
    })

    describe('getPRDiff', () => {
      it('returns a string', async () => {
        const diff = await adapter.getPRDiff('org/repo', 10)
        expect(typeof diff).toBe('string')
      })
    })
  })
}
