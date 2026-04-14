// @vitest-environment jsdom

import React from 'react'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDashboardRouter } from '../../web/src/router.js'
import {
  type DashboardSnapshot,
  type ProjectsSnapshot,
  type RunSummary,
  type SettingsSnapshot,
  type SessionResponse,
} from '../../web/src/types/dashboard.js'

const SESSION_RESPONSE: SessionResponse = {
  mutationToken: 'test-token',
  operationsEnabled: true,
}

const DASHBOARD_SNAPSHOT: DashboardSnapshot = {
  generatedAt: '2026-04-06T10:00:00.000Z',
  status: {
    activeRuns: 0,
    dailyCostUsd: 0,
  },
  runs: {
    count: 0,
    runs: [],
  },
  cost: {
    dailyBudgetUsd: 50,
    dailyBudgetOverrideUsd: null,
    effectiveDailyBudgetUsd: 50,
  },
  build: {
    version: '1.0.0',
    gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
  },
  config: {
    repos: ['org/repo'],
    pollIntervalSeconds: 30,
  },
  stats: {
    updatedAt: '2026-04-06T10:00:00.000Z',
    overview: {
      totalRuns: 0,
      activeRuns: 0,
      queuedRuns: 0,
      runningRuns: 0,
      reviewReadyRuns: 0,
      completedRuns: 0,
      blockedRuns: 0,
      errorRuns: 0,
    },
    statusCounts: [],
    phaseCounts: [],
    throughput: {
      runs24h: 0,
      runs7d: 0,
      runs30d: 0,
      completed7d: 0,
      blocked7d: 0,
      error7d: 0,
      successRate7d: 0,
      avgDurationMinutes7d: 0,
      avgIterations7d: 0,
    },
    reliability: {
      failureCount7d: 0,
      failureRate7d: 0,
      topErrorPatterns7d: [],
    },
    cost: {
      model: 'pay-per-use',
      todayCostUsd: 0,
      todayRunCount: 0,
      cost7d: 0,
      cost30d: 0,
      avgDailyCost7d: 0,
      dailyHistory: [],
    },
    usage: {
      todayPromptTokens: 0,
      todayCompletionTokens: 0,
      todayTotalTokens: 0,
      tokens7d: 0,
      tokens30d: 0,
      avgDailyTokens7d: 0,
      dailyHistory: [],
    },
    efficiency: {
      totalCostUsd7d: 0,
      avgCostPerRun7d: 0,
      avgCostPerSuccess7d: 0,
      avgCostPerIteration7d: 0,
      completedPerDollar7d: 0,
      avgTokensPerRun7d: 0,
      avgTokensPerSuccess7d: 0,
      avgTokensPerIteration7d: 0,
    },
    resources: {
      activeLeases: 0,
      expiringLeases: 0,
      expiredLeases: 0,
      leasedRepos: 0,
      activeWorktrees: 0,
      missingWorktrees: 0,
      staleWorktrees: 0,
    },
    timing: {
      sampleSize30d: 0,
      p50Minutes: 0,
      p90Minutes: 0,
      p99Minutes: 0,
    },
    queue: {
      activeBatches: 0,
      statuses: [],
    },
    agents: {
      eventsTotal: 0,
      events24h: 0,
      events7d: 0,
      toolCalls24h: 0,
      thinking24h: 0,
      uniqueRuns7d: 0,
      roleBreakdown7d: [],
    },
    topRepos30d: [],
    healthGate: {
      fallbackRows14d: 0,
      fallbackZeroRows14d: 0,
      checkpointQuarantineRows: 0,
      consecutiveBlockRuns7d: 0,
    },
  },
}

const ISSUE_DETAIL_RUN: RunSummary = {
  runId: 'run-issue-1',
  hasRun: true,
  repo: 'org/repo',
  issue: 42,
  issueTitle: 'Issue detail action coverage',
  status: 'blocked',
  prNumber: 123,
  phase: 'verify',
  iterations: 2,
  costUsd: 1.25,
  promptTokens: 12000,
  completionTokens: 3400,
  cacheReadTokens: 45000,
  lastError: null,
  startedAt: '2026-04-06T09:55:00.000Z',
  endedAt: null,
}

const COMPLETED_HISTORY_RUN_PAGE_ONE: RunSummary = {
  runId: 'run-completed-1',
  hasRun: true,
  repo: 'org/repo',
  issue: 200,
  issueTitle: 'First completed history run',
  status: 'completed',
  prNumber: 500,
  phase: 'publish',
  iterations: 1,
  costUsd: 0.5,
  promptTokens: 5000,
  completionTokens: 1200,
  cacheReadTokens: 18000,
  lastError: null,
  startedAt: '2026-04-05T10:00:00.000Z',
  endedAt: '2026-04-05T10:10:00.000Z',
}

const COMPLETED_HISTORY_RUN_PAGE_TWO: RunSummary = {
  runId: 'run-completed-2',
  hasRun: true,
  repo: 'org/repo',
  issue: 201,
  issueTitle: 'Second completed history run',
  status: 'completed',
  prNumber: 501,
  phase: 'publish',
  iterations: 2,
  costUsd: 1.2,
  promptTokens: 9000,
  completionTokens: 2500,
  cacheReadTokens: 40000,
  lastError: null,
  startedAt: '2026-04-04T10:00:00.000Z',
  endedAt: '2026-04-04T10:15:00.000Z',
}

const PROJECTS_SNAPSHOT: ProjectsSnapshot = {
  generatedAt: '2026-04-06T10:00:00.000Z',
  githubDefaults: {
    tokenEnv: 'GITHUB_TOKEN',
    apiBaseUrl: 'https://api.github.com',
  },
  workerProfiles: {},
  repos: [],
}

const PROJECTS_WITH_REPO_SNAPSHOT: ProjectsSnapshot = {
  ...PROJECTS_SNAPSHOT,
  repos: [
    {
      repo: 'org/repo',
      forge: 'github',
      linkedProjects: [],
      maxConcurrentRuns: 2,
      localPath: '/tmp/org-repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: {
        ready: ['orch:ready'],
        running: 'orch:running',
        blocked: 'orch:blocked',
        needsHuman: 'orch:needs-human',
        reviewReady: 'orch:review-ready',
        error: 'orch:error',
        retry: 'orch:retry',
        planning: 'orch:planning',
        mergeQueued: 'orch:merge-queued',
        merging: 'orch:merging',
        mergeFailed: 'orch:merge-failed',
      },
      labelConfig: {},
      defaults: {
        planner: 'claude',
        coder: 'codex',
        reviewer: 'claude',
        doneMode: 'pr-ready',
        notifyPriority: 'normal',
        prMentions: [],
      },
      planning: {
        prdDirectory: 'docs/prd',
      },
      selectors: {
        includeLabelsAny: ['orch:ready'],
        excludeLabelsAny: ['orch:blocked'],
      },
      verify: [],
      prompts: {
        plannerSystem: false,
        coderSystem: false,
        reviewerSystem: false,
      },
      agents: {},
      mergeQueue: {
        enabled: false,
        batchSize: 5,
        mergeMethod: 'merge',
        retryFlakyOnce: true,
        requireApproval: true,
        stagingBranchPrefix: 'orch/staging',
      },
    },
  ],
}

const SETTINGS_SNAPSHOT: SettingsSnapshot = {
  generatedAt: '2026-04-06T10:00:00.000Z',
  settings: [],
}

class MockWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = MockWebSocket.OPEN
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(_url: string) {
    queueMicrotask(() => {
      this.onopen?.(new Event('open'))
    })
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new Event('close'))
  }
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function withRuns(runs: RunSummary[]): DashboardSnapshot {
  return {
    ...DASHBOARD_SNAPSHOT,
    runs: {
      count: runs.length,
      runs,
    },
  }
}

function buildFetchMock(
  snapshot: DashboardSnapshot = DASHBOARD_SNAPSHOT,
  projectsSnapshot: ProjectsSnapshot = PROJECTS_SNAPSHOT,
  runsResponseResolver?: (url: URL) => Record<string, unknown>,
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const url = new URL(rawUrl, window.location.origin)
    const pathname = url.pathname
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')

    if (pathname === '/api/dashboard') return createJsonResponse(snapshot)
    if (pathname === '/api/session') return createJsonResponse(SESSION_RESPONSE)
    if (pathname === '/api/projects') return createJsonResponse(projectsSnapshot)
    if (pathname === '/api/settings') return createJsonResponse(SETTINGS_SNAPSHOT)
    if (pathname === '/api/runs') {
      return createJsonResponse(
        runsResponseResolver?.(url) ?? {
          count: 0,
          runs: [],
          hasMore: false,
          nextOffset: null,
        },
      )
    }
    if (pathname === '/api/update-status') return createJsonResponse({}, 404)
    if (method === 'POST' && pathname.startsWith('/api/operations/')) {
      return createJsonResponse({ message: `${pathname} accepted` })
    }

    return createJsonResponse({ error: `Unhandled endpoint: ${pathname}` }, 404)
  })
}

interface OperationCall {
  pathname: string
  body: Record<string, unknown>
}

function listOperationCalls(fetchMock: ReturnType<typeof buildFetchMock>): OperationCall[] {
  return fetchMock.mock.calls
    .map(([input, init]) => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      const pathname = new URL(rawUrl, window.location.origin).pathname
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method !== 'POST' || !pathname.startsWith('/api/operations/')) {
        return null
      }

      const rawBody = init?.body
      if (typeof rawBody !== 'string') {
        return { pathname, body: {} }
      }
      return { pathname, body: JSON.parse(rawBody) as Record<string, unknown> }
    })
    .filter((call): call is OperationCall => call !== null)
}

function renderDashboard(pathname: string) {
  const history = createMemoryHistory({ initialEntries: [pathname] })
  const router = createDashboardRouter({ history, isServer: false })
  const rendered = render(React.createElement(RouterProvider, { router }))
  return { ...rendered, router }
}

function expectPageActive(label: 'issues' | 'stats' | 'projects' | 'settings'): void {
  const pageButtons = screen
    .getAllByRole('button', { name: new RegExp(`^${label}$`, 'i') })
    .filter((button) => button.getAttribute('aria-label') === label)

  expect(pageButtons.length).toBeGreaterThan(0)
  expect(pageButtons.some((button) => button.getAttribute('aria-current') === 'page')).toBe(true)
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', buildFetchMock())
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dashboard router integration (real App)', () => {
  it('redirects / to /issues and renders the issues page', async () => {
    const { router } = renderDashboard('/')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues')
    })

    expectPageActive('issues')
    expect(screen.getByText('24h Throughput')).toBeDefined()
  })

  it('browses completed run history with pagination', async () => {
    const fetchMock = buildFetchMock(
      DASHBOARD_SNAPSHOT,
      PROJECTS_SNAPSHOT,
      (url) => {
        if (url.searchParams.get('view') !== 'completed') {
          return {
            count: 0,
            runs: [],
            hasMore: false,
            nextOffset: null,
          }
        }

        const offset = url.searchParams.get('offset') ?? '0'
        if (offset === '0') {
          return {
            count: 1,
            runs: [COMPLETED_HISTORY_RUN_PAGE_ONE],
            hasMore: true,
            nextOffset: 1,
          }
        }

        if (offset === '1') {
          return {
            count: 1,
            runs: [COMPLETED_HISTORY_RUN_PAGE_TWO],
            hasMore: false,
            nextOffset: null,
          }
        }

        return {
          count: 0,
          runs: [],
          hasMore: false,
          nextOffset: null,
        }
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const { router } = renderDashboard('/issues')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues')
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Completed' }))

    await waitFor(() => {
      expect(screen.getByText('First completed history run')).toBeDefined()
    })

    const loadMore = screen.getByRole('button', { name: 'Load more' })
    fireEvent.click(loadMore)

    await waitFor(() => {
      expect(screen.getByText('Second completed history run')).toBeDefined()
    })
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('renders /settings with real settings content and active nav state', async () => {
    const { router } = renderDashboard('/settings')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings')
    })

    expect(screen.getByText(/Runtime overrides are stored in SQLite/i)).toBeDefined()
    expectPageActive('settings')
  })

  it('redirects /agent to /issues because the shell page was removed', async () => {
    const { router } = renderDashboard('/agent')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues')
    })

    expectPageActive('issues')
    expect(screen.getByText('24h Throughput')).toBeDefined()
  })

  it('redirects invalid routes to /issues', async () => {
    const { router } = renderDashboard('/nope')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues')
    })

    expectPageActive('issues')
    expect(screen.getByText('24h Throughput')).toBeDefined()
  })

  it('clicking real header/sidebar controls updates URL and rendered page', async () => {
    const { router } = renderDashboard('/issues')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues')
    })
    expectPageActive('issues')

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings')
    })
    expect(screen.getByText(/Runtime overrides are stored in SQLite/i)).toBeDefined()
    expectPageActive('settings')

    const statsNavButton = screen
      .getAllByRole('button', { name: /^stats$/i })
      .find((button) => button.getAttribute('aria-label') === 'stats')
    expect(statsNavButton).toBeDefined()
    fireEvent.click(statsNavButton!)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/stats')
    })
    expect(screen.getByText(/Stats snapshot is loading.|System Signals/i)).toBeDefined()
    expectPageActive('stats')
  })

  it('runs header cleanup quick action', async () => {
    const fetchMock = buildFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const { router } = renderDashboard('/issues')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run cleanup' }))

    await waitFor(() => {
      expect(listOperationCalls(fetchMock)).toEqual([
        {
          pathname: '/api/operations/cleanup',
          body: {},
        },
      ])
    })
  })

  it('renders issue detail route and navigates back to issues list', async () => {
    const { router } = renderDashboard('/issues/issue%3Aorg%2Frepo%231')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues/issue%3Aorg%2Frepo%231')
    })

    expectPageActive('issues')
    expect(screen.getByText('Issue Detail')).toBeDefined()
    expect(screen.getByText('Run "issue:org/repo#1" is not in the current dashboard snapshot.')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Back to issues' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues')
    })
  })

  it('runs issue detail actions after confirmation and forwards force delete payload', async () => {
    const fetchMock = buildFetchMock(withRuns([ISSUE_DETAIL_RUN]))
    vi.stubGlobal('fetch', fetchMock)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const { router } = renderDashboard('/issues/run-issue-1')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues/run-issue-1')
    })

    expect(screen.getByText('Issue Detail')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Queue Retry' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Queue Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue Rebase' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue Continue Pass' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Local Entry' }))

    await waitFor(() => {
      expect(listOperationCalls(fetchMock)).toHaveLength(4)
    })

    fireEvent.click(screen.getByLabelText('Force delete (for active/shared issue state)'))
    fireEvent.click(screen.getByRole('button', { name: 'Force Delete Local Entry' }))

    await waitFor(() => {
      expect(listOperationCalls(fetchMock)).toHaveLength(5)
    })

    const operationCalls = listOperationCalls(fetchMock)
    expect(operationCalls.map((call) => call.pathname)).toEqual([
      '/api/operations/retry',
      '/api/operations/rebase',
      '/api/operations/continue',
      '/api/operations/delete-entry',
      '/api/operations/delete-entry',
    ])

    expect(operationCalls[0]?.body).toMatchObject({ repo: 'org/repo', issueNumber: 42 })
    expect(operationCalls[1]?.body).toMatchObject({ repo: 'org/repo', issueNumber: 42 })
    expect(operationCalls[2]?.body).toMatchObject({ repo: 'org/repo', issueNumber: 42 })
    expect(operationCalls[3]?.body).toMatchObject({ repo: 'org/repo', issueNumber: 42, force: false })
    expect(operationCalls[4]?.body).toMatchObject({ repo: 'org/repo', issueNumber: 42, force: true })

    expect(confirmSpy).toHaveBeenCalledTimes(5)
  })

  it('skips issue detail operations when confirmation is declined', async () => {
    const fetchMock = buildFetchMock(withRuns([ISSUE_DETAIL_RUN]))
    vi.stubGlobal('fetch', fetchMock)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const { router } = renderDashboard('/issues/run-issue-1')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues/run-issue-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Queue Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue Rebase' }))
    fireEvent.click(screen.getByRole('button', { name: 'Queue Continue Pass' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Local Entry' }))

    expect(confirmSpy).toHaveBeenCalledTimes(4)
    expect(listOperationCalls(fetchMock)).toHaveLength(0)
  })

  it('renders project detail route and navigates back to projects list', async () => {
    const { router } = renderDashboard('/projects/org%2Frepo')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/org%2Frepo')
    })

    expectPageActive('projects')
    expect(screen.getByText('Project Details')).toBeDefined()
    expect(screen.getByText('Repository "org/repo" is not configured.')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects')
    })
  })

  it('runs project labels init after confirmation', async () => {
    const fetchMock = buildFetchMock(DASHBOARD_SNAPSHOT, PROJECTS_WITH_REPO_SNAPSHOT)
    vi.stubGlobal('fetch', fetchMock)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const { router } = renderDashboard('/projects/org%2Frepo')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/org%2Frepo')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Bootstrap Labels' }))

    await waitFor(() => {
      expect(listOperationCalls(fetchMock)).toHaveLength(1)
    })

    expect(listOperationCalls(fetchMock)).toEqual([
      {
        pathname: '/api/operations/labels-init',
        body: { repo: 'org/repo' },
      },
    ])
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })

  it('skips project labels init when confirmation is declined', async () => {
    const fetchMock = buildFetchMock(DASHBOARD_SNAPSHOT, PROJECTS_WITH_REPO_SNAPSHOT)
    vi.stubGlobal('fetch', fetchMock)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const { router } = renderDashboard('/projects/org%2Frepo')
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/org%2Frepo')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Bootstrap Labels' }))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(listOperationCalls(fetchMock)).toHaveLength(0)
  })
})
