import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ForgejoForgeAdapter } from '../../src/forge/forgejo.js'
import { ForgejoApiError } from '../../src/forge/forgejo-client.js'
import type { RepoConfig } from '../../src/config/schema.js'

// Mock fetch globally
const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function makeForgejoIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'Test issue',
    body: 'Test body',
    labels: [{ id: 1, name: 'orch:ready' }],
    assignees: [{ login: 'user1' }],
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    html_url: 'https://forgejo.example.com/org/repo/issues/1',
    ...overrides,
  }
}

function makeForgejoPR(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    title: 'PR title',
    body: 'PR body',
    state: 'open',
    merged: false,
    head: { ref: 'feature-branch' },
    base: { ref: 'main' },
    html_url: 'https://forgejo.example.com/org/repo/pulls/10',
    ...overrides,
  }
}

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'forgejo',
    apiBaseUrl: 'https://forgejo.example.com/api/v1',
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
    ...overrides,
  } as RepoConfig
}

const REPO_LABELS = [
  { id: 1, name: 'orch:ready' },
  { id: 2, name: 'orch:running' },
  { id: 3, name: 'bug' },
]

describe('ForgejoForgeAdapter', () => {
  let adapter: ForgejoForgeAdapter

  beforeEach(() => {
    mockFetch.mockReset()
    adapter = new ForgejoForgeAdapter('https://forgejo.example.com/api/v1', 'test-token')
  })

  describe('getIssue', () => {
    it('returns a mapped ForgeIssue', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoIssue()))

      const issue = await adapter.getIssue('org/repo', 1)

      expect(issue).toEqual({
        number: 1,
        nodeId: null,
        title: 'Test issue',
        body: 'Test body',
        labels: ['orch:ready'],
        assignees: ['user1'],
        state: 'open',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        url: 'https://forgejo.example.com/org/repo/issues/1',
      })
    })

    it('sets nodeId to null (Forgejo has no GraphQL node IDs)', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoIssue()))

      const issue = await adapter.getIssue('org/repo', 1)
      expect(issue.nodeId).toBeNull()
    })

    it('maps null body to empty string', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoIssue({ body: null })))

      const issue = await adapter.getIssue('org/repo', 1)
      expect(issue.body).toBe('')
    })

    it('maps null assignees to empty array', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoIssue({ assignees: null })))

      const issue = await adapter.getIssue('org/repo', 1)
      expect(issue.assignees).toEqual([])
    })

    it('throws on invalid repo format', async () => {
      await expect(adapter.getIssue('invalid', 1)).rejects.toThrow('Invalid repo format')
    })
  })

  describe('listEligibleIssues', () => {
    it('fetches issues for each include label and deduplicates', async () => {
      const issue1 = makeForgejoIssue({ number: 1 })
      const issue2 = makeForgejoIssue({ number: 2 })

      mockFetch
        .mockResolvedValueOnce(jsonResponse([issue1, issue2]))
        .mockResolvedValueOnce(jsonResponse([issue1]))

      const config = makeRepoConfig({
        selectors: {
          includeLabelsAny: ['orch:ready', 'orch:priority'],
          excludeLabelsAny: [],
        },
      })

      const issues = await adapter.listEligibleIssues(config)

      expect(issues).toHaveLength(2)
    })

    it('skips pull requests in issue results', async () => {
      const issue = makeForgejoIssue({ number: 1 })
      const pr = makeForgejoIssue({ number: 2, pull_request: { url: 'https://...' } })

      mockFetch.mockResolvedValue(jsonResponse([issue, pr]))

      const config = makeRepoConfig()
      const issues = await adapter.listEligibleIssues(config)

      expect(issues).toHaveLength(1)
      expect(issues[0]!.number).toBe(1)
    })
  })

  describe('addLabels', () => {
    it('resolves label names to IDs and posts them', async () => {
      // First call: fetch labels for cache
      mockFetch.mockResolvedValueOnce(jsonResponse(REPO_LABELS))
      // Second call: post labels
      mockFetch.mockResolvedValueOnce(jsonResponse([]))

      await adapter.addLabels('org/repo', 1, ['orch:ready', 'bug'])

      const postCall = mockFetch.mock.calls[1]!
      expect(postCall[0]).toContain('/repos/org/repo/issues/1/labels')
      const body = JSON.parse(postCall[1]!.body as string) as { labels: number[] }
      expect(body.labels).toEqual([1, 3])
    })

    it('skips API call for empty labels', async () => {
      await adapter.addLabels('org/repo', 1, [])
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('skips unknown labels', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(REPO_LABELS))
      mockFetch.mockResolvedValueOnce(jsonResponse([]))

      await adapter.addLabels('org/repo', 1, ['nonexistent', 'bug'])

      const postCall = mockFetch.mock.calls[1]!
      const body = JSON.parse(postCall[1]!.body as string) as { labels: number[] }
      expect(body.labels).toEqual([3]) // only 'bug' resolved
    })
  })

  describe('removeLabels', () => {
    it('resolves label names to IDs and deletes each', async () => {
      // First call: fetch labels for cache
      mockFetch.mockResolvedValueOnce(jsonResponse(REPO_LABELS))
      // Delete calls
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 204, statusText: 'No Content',
        headers: new Headers(), json: () => Promise.resolve(undefined),
      } as unknown as Response)

      await adapter.removeLabels('org/repo', 1, ['orch:ready'])

      expect(mockFetch).toHaveBeenCalledTimes(2)
      const deleteCall = mockFetch.mock.calls[1]!
      expect(deleteCall[0]).toContain('/repos/org/repo/issues/1/labels/1')
    })

    it('ignores 404 errors (label not present)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(REPO_LABELS))
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404))

      await expect(adapter.removeLabels('org/repo', 1, ['orch:ready'])).resolves.toBeUndefined()
    })

    it('skips labels not found in cache', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(REPO_LABELS))

      await adapter.removeLabels('org/repo', 1, ['nonexistent'])

      // Only the label fetch call, no delete call
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('commentOnIssue', () => {
    it('posts a comment via the issue comments endpoint', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1 }))

      await adapter.commentOnIssue('org/repo', 1, 'Hello!')

      const call = mockFetch.mock.calls[0]!
      expect(call[0]).toContain('/repos/org/repo/issues/1/comments')
      const body = JSON.parse(call[1]!.body as string) as { body: string }
      expect(body.body).toBe('Hello!')
    })
  })

  describe('validateAuth', () => {
    it('returns user and empty scopes', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ login: 'bot-user' }))

      const auth = await adapter.validateAuth()

      expect(auth.user).toBe('bot-user')
      expect(auth.scopes).toEqual([])
    })

    it('uses token auth format', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ login: 'bot' }))

      await adapter.validateAuth()

      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>
      expect(headers.Authorization).toBe('token test-token')
    })
  })

  describe('createPR', () => {
    it('creates a PR and maps the response', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoPR()))

      const pr = await adapter.createPR('org/repo', {
        title: 'PR title',
        body: 'PR body',
        headBranch: 'feature-branch',
        baseBranch: 'main',
      })

      expect(pr.number).toBe(10)
      expect(pr.state).toBe('open')
      expect(pr.headBranch).toBe('feature-branch')
      expect(pr.baseBranch).toBe('main')

      const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as Record<string, string>
      expect(body.head).toBe('feature-branch')
      expect(body.base).toBe('main')
    })

    it('maps merged PR correctly', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoPR({ merged: true, state: 'closed' })))

      const pr = await adapter.createPR('org/repo', {
        title: 'Merged',
        body: '',
        headBranch: 'f',
        baseBranch: 'main',
      })
      expect(pr.state).toBe('merged')
    })

    it('maps closed (not merged) PR correctly', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoPR({ merged: false, state: 'closed' })))

      const pr = await adapter.createPR('org/repo', {
        title: 'Closed',
        body: '',
        headBranch: 'f',
        baseBranch: 'main',
      })
      expect(pr.state).toBe('closed')
    })
  })

  describe('updatePR', () => {
    it('updates and returns mapped PR', async () => {
      mockFetch.mockResolvedValue(jsonResponse(makeForgejoPR({ title: 'Updated' })))

      const pr = await adapter.updatePR('org/repo', 10, { title: 'Updated' })

      expect(pr.title).toBe('Updated')
      expect(mockFetch.mock.calls[0]![0]).toContain('/repos/org/repo/pulls/10')
    })
  })

  describe('findPRByBranch', () => {
    it('returns PR when found', async () => {
      mockFetch.mockResolvedValue(jsonResponse([makeForgejoPR()]))

      const pr = await adapter.findPRByBranch('org/repo', 'feature-branch')

      expect(pr).not.toBeNull()
      expect(pr!.number).toBe(10)
    })

    it('returns null when no PR found', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]))

      const pr = await adapter.findPRByBranch('org/repo', 'nonexistent')
      expect(pr).toBeNull()
    })

    it('returns null when no matching branch in results', async () => {
      mockFetch.mockResolvedValue(jsonResponse([makeForgejoPR({ head: { ref: 'other-branch' } })]))

      const pr = await adapter.findPRByBranch('org/repo', 'feature-branch')
      expect(pr).toBeNull()
    })
  })

  describe('getPRDiff', () => {
    it('returns diff string', async () => {
      const diffText = '--- a/file.ts\n+++ b/file.ts\n'
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(diffText),
      } as unknown as Response)

      const diff = await adapter.getPRDiff('org/repo', 10)

      expect(diff).toContain('file.ts')
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/pulls/10.diff')
    })

    it('throws on error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
      } as unknown as Response)

      await expect(adapter.getPRDiff('org/repo', 99)).rejects.toThrow(ForgejoApiError)
    })
  })

  describe('PR comment', () => {
    it('uses issue comment endpoint for PR comments', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1 }))

      await adapter.commentOnIssue('org/repo', 10, 'Review comment')

      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/issues/10/comments')
    })
  })
})
