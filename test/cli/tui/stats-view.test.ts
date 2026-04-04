import { describe, expect, it } from 'vitest'
import React from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Text } from 'ink'
import type { TuiStatsSnapshot } from '../../../src/state/stats.js'
import { StatsView } from '../../../src/cli/tui/stats-view.js'

describe('StatsView', () => {
  it('uses throughput counters for throughput blocked/error colors', () => {
    const stats: TuiStatsSnapshot = {
      updatedAt: '2026-04-01T10:00:00.000Z',
      overview: {
        totalRuns: 12,
        activeRuns: 7,
        queuedRuns: 1,
        runningRuns: 2,
        reviewReadyRuns: 1,
        completedRuns: 5,
        blockedRuns: 4,
        errorRuns: 3,
      },
      statusCounts: [
        { status: 'completed', count: 5 },
        { status: 'blocked', count: 4 },
        { status: 'error', count: 3 },
      ],
      phaseCounts: [{ phase: 'plan', count: 2 }],
      throughput: {
        runs24h: 2,
        runs7d: 5,
        runs30d: 9,
        completed7d: 2,
        blocked7d: 0,
        error7d: 0,
        successRate7d: 100,
        avgDurationMinutes7d: 20,
        avgIterations7d: 1.2,
      },
      reliability: {
        failureCount7d: 0,
        failureRate7d: 0,
        topErrorPatterns7d: [],
      },
      cost: {
        model: 'pay-per-use',
        todayCostUsd: 3.5,
        todayRunCount: 2,
        cost7d: 12.2,
        cost30d: 44.2,
        avgDailyCost7d: 2.5,
        dailyHistory: [{ date: '2026-04-01', totalCostUsd: 3.5, runCount: 2 }],
      },
      usage: {
        todayPromptTokens: 1200,
        todayCompletionTokens: 400,
        todayTotalTokens: 1600,
        tokens7d: 3200,
        tokens30d: 9800,
        avgDailyTokens7d: 900,
        dailyHistory: [{ date: '2026-04-01', promptTokens: 1200, completionTokens: 400, totalTokens: 1600, runCount: 2 }],
      },
      efficiency: {
        totalCostUsd7d: 12.2,
        avgCostPerRun7d: 2.4,
        avgCostPerSuccess7d: 6.1,
        avgCostPerIteration7d: 1.2,
        completedPerDollar7d: 0.16,
        avgTokensPerRun7d: 640,
        avgTokensPerSuccess7d: 1600,
        avgTokensPerIteration7d: 533.33,
      },
      resources: {
        activeLeases: 1,
        expiringLeases: 0,
        expiredLeases: 0,
        leasedRepos: 1,
        activeWorktrees: 2,
        missingWorktrees: 0,
        staleWorktrees: 0,
      },
      timing: {
        sampleSize30d: 3,
        p50Minutes: 10,
        p90Minutes: 25,
        p99Minutes: 30,
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
    }

    const tree = StatsView({
      stats,
      autoRefresh: true,
      pollIntervalMs: 2000,
      lastRefreshAt: '2026-04-01T10:00:00.000Z',
    })

    const runHealthLine = findTextNode(tree, 'blocked 4')
    const throughputLine = findTextNode(tree, 'blocked 7d')

    expect(runHealthLine).toBeTruthy()
    expect(throughputLine).toBeTruthy()
    expect(extractInlineColorValues(runHealthLine!)).toEqual(['red', 'red'])
    expect(extractInlineColorValues(throughputLine!)).toEqual(['green', 'green'])
  })
})

function findTextNode(root: ReactNode, fragment: string): ReactElement | null {
  for (const node of collectTextNodes(root)) {
    if (flattenText(node.props.children).includes(fragment)) {
      return node
    }
  }
  return null
}

function collectTextNodes(node: ReactNode): ReactElement[] {
  const collected: ReactElement[] = []
  traverseNode(node, collected)
  return collected
}

function traverseNode(node: ReactNode, collected: ReactElement[]): void {
  if (!React.isValidElement(node)) return
  if (node.type === Text) {
    collected.push(node)
  }
  for (const child of React.Children.toArray(node.props.children)) {
    traverseNode(child, collected)
  }
}

function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map((item) => flattenText(item)).join('')
  }
  if (React.isValidElement(node)) {
    return flattenText(node.props.children)
  }
  return ''
}

function extractInlineColorValues(line: ReactElement): string[] {
  return React.Children
    .toArray(line.props.children)
    .filter(React.isValidElement)
    .filter((child): child is ReactElement<{ color?: string }> => child.type === Text)
    .map((child) => child.props.color)
    .filter((color): color is string => typeof color === 'string')
}
