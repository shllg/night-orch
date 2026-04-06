// @vitest-environment jsdom

import React from 'react'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDashboardRouter } from '../../web/src/router.js'
import {
  type DashboardSnapshot,
  type ProjectsSnapshot,
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
  },
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

function buildFetchMock() {
  return vi.fn(async (input: string | URL | Request) => {
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const pathname = new URL(rawUrl, window.location.origin).pathname

    if (pathname === '/api/dashboard') return createJsonResponse(DASHBOARD_SNAPSHOT)
    if (pathname === '/api/session') return createJsonResponse(SESSION_RESPONSE)
    if (pathname === '/api/projects') return createJsonResponse(PROJECTS_SNAPSHOT)
    if (pathname === '/api/settings') return createJsonResponse(SETTINGS_SNAPSHOT)
    if (pathname === '/api/update-status') return createJsonResponse({}, 404)

    return createJsonResponse({ error: `Unhandled endpoint: ${pathname}` }, 404)
  })
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

  it('renders /settings with real settings content and active nav state', async () => {
    const { router } = renderDashboard('/settings')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings')
    })

    expect(screen.getByText(/Runtime overrides are stored in SQLite/i)).toBeDefined()
    expectPageActive('settings')
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
})
