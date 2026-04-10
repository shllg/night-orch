import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { StatsPage } from '../../web/src/components/StatsPage.js'
import { type DashboardSnapshot } from '../../web/src/types/dashboard.js'

const FULL_SNAPSHOT: DashboardSnapshot = {
  generatedAt: '2026-04-01T10:00:00.000Z',
  status: {
    activeRuns: 5,
    dailyCostUsd: 12.34,
  },
  runs: {
    count: 1,
    runs: [],
  },
  cost: {
    dailyBudgetUsd: 50,
  },
  build: {
    version: '1.2.3',
    gitSha: '0123456789abcdef0123456789abcdef01234567',
  },
  config: {
    repos: ['org/repo-a', 'org/repo-b'],
    pollIntervalSeconds: 30,
  },
  stats: {
    updatedAt: '2026-04-01T10:00:00.000Z',
    overview: {
      totalRuns: 20,
      activeRuns: 5,
      queuedRuns: 2,
      runningRuns: 2,
      reviewReadyRuns: 1,
      completedRuns: 12,
      blockedRuns: 1,
      errorRuns: 2,
    },
    statusCounts: [
      { status: 'completed', count: 12 },
      { status: 'running', count: 2 },
      { status: 'queued', count: 2 },
      { status: 'error', count: 2 },
      { status: 'blocked', count: 1 },
      { status: 'review_ready', count: 1 },
    ],
    phaseCounts: [
      { phase: 'implement', count: 2 },
      { phase: 'review', count: 1 },
    ],
    throughput: {
      runs24h: 4,
      runs7d: 10,
      runs30d: 35,
      completed7d: 6,
      blocked7d: 2,
      error7d: 2,
      successRate7d: 60,
      avgDurationMinutes7d: 18.5,
      avgIterations7d: 1.8,
    },
    reliability: {
      failureCount7d: 4,
      failureRate7d: 40,
      topErrorPatterns7d: [
        { pattern: 'failed to fetch', count: 3 },
        { pattern: 'timeout waiting for checks', count: 2 },
      ],
    },
    cost: {
      model: 'pay-per-use',
      todayCostUsd: 8.1,
      todayRunCount: 3,
      cost7d: 36.2,
      cost30d: 160.4,
      avgDailyCost7d: 5.1,
      dailyHistory: [
        { date: '2026-04-01', totalCostUsd: 8.1, runCount: 3 },
        { date: '2026-03-31', totalCostUsd: 4.1, runCount: 2 },
        { date: '2026-03-30', totalCostUsd: 1.4, runCount: 1 },
      ],
    },
    usage: {
      todayPromptTokens: 3000,
      todayCompletionTokens: 1200,
      todayTotalTokens: 4200,
      tokens7d: 15000,
      tokens30d: 62000,
      avgDailyTokens7d: 2200,
      dailyHistory: [
        { date: '2026-04-01', promptTokens: 3000, completionTokens: 1200, totalTokens: 4200, runCount: 3 },
        { date: '2026-03-31', promptTokens: 1800, completionTokens: 400, totalTokens: 2200, runCount: 2 },
        { date: '2026-03-30', promptTokens: 900, completionTokens: 250, totalTokens: 1150, runCount: 1 },
      ],
    },
    efficiency: {
      totalCostUsd7d: 36.2,
      avgCostPerRun7d: 3.62,
      avgCostPerSuccess7d: 6.03,
      avgCostPerIteration7d: 1.2,
      completedPerDollar7d: 0.17,
      avgTokensPerRun7d: 1500,
      avgTokensPerSuccess7d: 2500,
      avgTokensPerIteration7d: 750,
    },
    resources: {
      activeLeases: 3,
      expiringLeases: 1,
      expiredLeases: 0,
      leasedRepos: 2,
      activeWorktrees: 4,
      missingWorktrees: 1,
      staleWorktrees: 2,
    },
    timing: {
      sampleSize30d: 12,
      p50Minutes: 10,
      p90Minutes: 30,
      p99Minutes: 75,
    },
    queue: {
      activeBatches: 2,
      statuses: [
        { status: 'running', count: 1 },
        { status: 'queued', count: 1 },
      ],
    },
    agents: {
      eventsTotal: 150,
      events24h: 45,
      events7d: 120,
      toolCalls24h: 20,
      thinking24h: 9,
      uniqueRuns7d: 14,
      roleBreakdown7d: [
        { role: 'planner', events: 40, toolCalls: 5 },
        { role: 'coder', events: 70, toolCalls: 14 },
      ],
    },
    topRepos30d: [
      {
        repo: 'org/alpha-repo',
        totalRuns: 10,
        completedRuns: 8,
        blockedRuns: 1,
        errorRuns: 1,
        totalCostUsd: 40.2,
        avgIterations: 1.6,
      },
    ],
    healthGate: {
      fallbackRows14d: 0,
      fallbackZeroRows14d: 0,
      checkpointQuarantineRows: 0,
      consecutiveBlockRuns7d: 0,
    },
  },
}

describe('StatsPage', () => {
  it('renders all rich stats sections and derived values', () => {
    const text = renderStatsPageText(FULL_SNAPSHOT, true)

    expect(text).toContain('System Signals')
    expect(text).toContain('Run Health')
    expect(text).toContain('Throughput')
    expect(text).toContain('Cost')
    expect(text).toContain('Agent Activity')
    expect(text).toContain('Reliability')
    expect(text).toContain('Resources')
    expect(text).toContain('Merge Queue')
    expect(text).toContain('Top Repositories (30d)')

    expect(text).toContain('Tail Ratio (p90 / p50) 3.00x')
    expect(text).toContain('Websocket Connected')
    expect(text).toContain('org/alpha-repo')
    expect(text).toMatch(/success\s+80\s*%/)
  })

  it('renders a loading shell when snapshot is unavailable', () => {
    const text = renderStatsPageText(null, false)
    expect(text).toContain('Stats snapshot is loading.')
  })

  it('shows empty-state fallbacks for sparse stats snapshots', () => {
    const sparseSnapshot: DashboardSnapshot = {
      ...FULL_SNAPSHOT,
      stats: {
        ...FULL_SNAPSHOT.stats,
        timing: {
          sampleSize30d: 0,
          p50Minutes: 0,
          p90Minutes: 0,
          p99Minutes: 0,
        },
        cost: {
          ...FULL_SNAPSHOT.stats.cost,
          dailyHistory: [],
        },
        reliability: {
          ...FULL_SNAPSHOT.stats.reliability,
          topErrorPatterns7d: [],
        },
        agents: {
          ...FULL_SNAPSHOT.stats.agents,
          roleBreakdown7d: [],
        },
        topRepos30d: [],
      },
    }

    const text = renderStatsPageText(sparseSnapshot, false)

    expect(text).toContain('Websocket Reconnecting')
    expect(text).toContain('No daily cost rows in the last 7 days.')
    expect(text).toContain('No agent activity in the last 7 days.')
    expect(text).toContain('None in the last 7 days.')
    expect(text).toContain('No repository run history in the last 30 days.')
    expect(text).toContain('Tail Ratio (p90 / p50) -')
  })
})

function renderStatsPageText(snapshot: DashboardSnapshot | null, socketConnected: boolean): string {
  const html = renderToStaticMarkup(React.createElement(StatsPage, { snapshot, socketConnected }))
  return normalizeWhitespace(html.replace(/<[^>]*>/g, ' '))
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
