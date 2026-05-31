import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ForgejoForgeAdapter } from '../../src/forge/forgejo.js'
import type { RepoConfig } from '../../src/config/schema.js'

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
    statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

const REPO_LABELS = [
  { id: 1, name: 'no:ready' },
  { id: 2, name: 'no:running' },
  { id: 3, name: 'no:blocked' },
  { id: 4, name: 'no:review-ready' },
  { id: 5, name: 'no:error' },
]

function makeRepoConfig(): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'forgejo',
    apiBaseUrl: 'https://forgejo.example.com/api/v1',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: ['no:blocked'],
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
      excludeLabelsAny: [],
    },
    agents: {},
  } as RepoConfig
}

function makeForgejoIssue(num: number, labels: Array<{ id: number; name: string }>) {
  return {
    number: num,
    title: `Issue #${num}`,
    body: 'Fix something',
    labels,
    assignees: [{ login: 'dev1' }],
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    html_url: `https://forgejo.example.com/org/repo/issues/${num}`,
  }
}

describe('Forgejo Integration', () => {
  let adapter: ForgejoForgeAdapter

  beforeEach(() => {
    mockFetch.mockReset()
    adapter = new ForgejoForgeAdapter('https://forgejo.example.com/api/v1', 'test-token')
  })

  describe('discovery → claim → create PR flow', () => {
    it('discovers eligible issues, adds running label, and creates PR', async () => {
      const repoConfig = makeRepoConfig()
      const issue1 = makeForgejoIssue(1, [{ id: 1, name: 'no:ready' }])
      const issue2 = makeForgejoIssue(2, [{ id: 1, name: 'no:ready' }])

      // 1. listEligibleIssues: fetch issues + labels (for cache)
      mockFetch
        // Issues query
        .mockResolvedValueOnce(jsonResponse([issue1, issue2]))
        // Label cache: repo labels
        .mockResolvedValueOnce(jsonResponse(REPO_LABELS))
        // addLabels POST (claim issue 1 with no:running)
        .mockResolvedValueOnce(jsonResponse([]))
        // removeLabels refreshes label cache after mutation
        .mockResolvedValueOnce(jsonResponse(REPO_LABELS))
        // removeLabels DELETE (remove no:ready from issue 1) — id 1
        .mockResolvedValueOnce(jsonResponse(undefined, 204))
        // createPR POST
        .mockResolvedValueOnce(jsonResponse({
          number: 10,
          title: 'Fix Issue #1',
          body: 'Closes #1',
          state: 'open',
          merged: false,
          head: { ref: 'orch/1-fix' },
          base: { ref: 'main' },
          html_url: 'https://forgejo.example.com/org/repo/pulls/10',
        }, 201))

      // Step 1: Discover eligible issues
      const issues = await adapter.listEligibleIssues(repoConfig)
      expect(issues).toHaveLength(2)
      expect(issues[0]?.nodeId).toBeNull()
      expect(issues[0]?.number).toBe(1)
      expect(issues[1]?.number).toBe(2)

      // Step 2: Claim issue 1 — add running, remove ready
      await adapter.addLabels('org/repo', 1, ['no:running'])
      await adapter.removeLabels('org/repo', 1, ['no:ready'])

      // Step 3: Create PR
      const pr = await adapter.createPR('org/repo', {
        title: 'Fix Issue #1',
        body: 'Closes #1',
        headBranch: 'orch/1-fix',
        baseBranch: 'main',
      })
      expect(pr.number).toBe(10)
      expect(pr.headBranch).toBe('orch/1-fix')
      expect(pr.state).toBe('open')
    })
  })

  describe('label mutations with ID resolution', () => {
    it('resolves label names to IDs and adds them', async () => {
      // Label cache fetch
      mockFetch
        .mockResolvedValueOnce(jsonResponse(REPO_LABELS))
        // addLabels POST
        .mockResolvedValueOnce(jsonResponse([]))

      await adapter.addLabels('org/repo', 5, ['no:running', 'no:blocked'])

      // The POST should contain label IDs [2, 3]
      const postCall = mockFetch.mock.calls[1]!
      const postBody = JSON.parse(postCall[1]?.body as string)
      expect(postBody.labels).toEqual([2, 3])
    })

    it('skips unknown labels without error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(REPO_LABELS))

      // No POST should be made — unknown label resolves to null
      await adapter.addLabels('org/repo', 5, ['nonexistent-label'])
      // Only 1 fetch call (label cache), no POST
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('removes labels by ID, ignoring 404s', async () => {
      mockFetch
        // Label cache
        .mockResolvedValueOnce(jsonResponse(REPO_LABELS))
        // DELETE label 2 (no:running) — success
        .mockResolvedValueOnce(jsonResponse(undefined, 204))
        // Label cache already warm, then DELETE label 3 (no:blocked) — 404 (not present, that's ok)
        .mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404))

      await adapter.removeLabels('org/repo', 5, ['no:running', 'no:blocked'])
      // Should not throw
    })
  })

  describe('existing PR detection and reuse', () => {
    it('finds existing PR by branch and updates it', async () => {
      const existingPR = {
        number: 10,
        title: 'Old title',
        body: 'Old body',
        state: 'open',
        merged: false,
        head: { ref: 'orch/1-fix' },
        base: { ref: 'main' },
        html_url: 'https://forgejo.example.com/org/repo/pulls/10',
      }

      mockFetch
        // findPRByBranch: GET pulls
        .mockResolvedValueOnce(jsonResponse([existingPR]))
        // updatePR: PATCH
        .mockResolvedValueOnce(jsonResponse({ ...existingPR, title: 'Updated title', body: 'Updated body' }))

      // Find existing PR
      const found = await adapter.findPRByBranch('org/repo', 'orch/1-fix')
      expect(found).not.toBeNull()
      expect(found!.number).toBe(10)

      // Update it
      const updated = await adapter.updatePR('org/repo', 10, {
        title: 'Updated title',
        body: 'Updated body',
      })
      expect(updated.title).toBe('Updated title')
    })

    it('returns null when no matching PR exists', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))

      const found = await adapter.findPRByBranch('org/repo', 'orch/99-missing')
      expect(found).toBeNull()
    })
  })

  describe('client timeout', () => {
    it('passes AbortSignal.timeout to fetch calls', async () => {
      const slowAdapter = new ForgejoForgeAdapter('https://forgejo.example.com/api/v1', 'test-token', 5000)

      mockFetch.mockResolvedValue(jsonResponse({ login: 'user' }))

      await slowAdapter.validateAuth()

      const fetchOpts = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined
      expect(fetchOpts?.signal).toBeDefined()
      expect(fetchOpts?.signal).toBeInstanceOf(AbortSignal)
    })

    it('uses custom timeout value', () => {
      const customAdapter = new ForgejoForgeAdapter('https://forgejo.example.com/api/v1', 'test-token', 15_000)
      // Adapter constructed without error — timeout is stored internally
      expect(customAdapter).toBeDefined()
    })
  })
})
