import { describe, expect, it } from 'vitest'
import React from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Text } from 'ink'
import { RunsView } from '../../../src/cli/tui/runs-view.js'
import type { AgentEventRow, IssueListRow, RunListRow } from '../../../src/cli/tui/data.js'
import type { TitleLookup } from '../../../src/cli/tui/titles.js'
import type { TuiStatsSnapshot } from '../../../src/state/stats.js'

describe('RunsView semantic run data display', () => {
  it('renders semantic colors for phase/iteration/cost/PR and run-history in list mode', () => {
    const runs: RunListRow[] = [
      makeRunRow({
        id: 'run-1',
        status: 'running',
        current_phase: 'verify',
        iteration_count: 3,
        estimated_cost_usd: 2.5,
        pr_number: 42,
        created_at: '2026-04-01T10:04:00.000Z',
        updated_at: '2026-04-01T10:04:30.000Z',
      }),
      makeRunRow({
        id: 'run-2',
        status: 'blocked',
        current_phase: 'review',
        iteration_count: 2,
        estimated_cost_usd: 1.2,
        pr_number: null,
        created_at: '2026-04-01T10:03:00.000Z',
        updated_at: '2026-04-01T10:03:30.000Z',
      }),
      makeRunRow({
        id: 'run-3',
        status: 'queued',
        current_phase: 'plan',
        iteration_count: 1,
        estimated_cost_usd: 0.1,
        pr_number: null,
        created_at: '2026-04-01T10:02:00.000Z',
        updated_at: '2026-04-01T10:02:30.000Z',
      }),
      makeRunRow({
        id: 'run-4',
        status: 'error',
        current_phase: 'failed',
        iteration_count: 4,
        estimated_cost_usd: 3,
        pr_number: null,
        created_at: '2026-04-01T10:01:00.000Z',
        updated_at: '2026-04-01T10:01:30.000Z',
      }),
    ]

    const issue = makeIssueRow({
      status: 'running',
      current_phase: 'verify',
      iteration_count: 3,
      estimated_cost_usd: 2.5,
      pr_number: 42,
      runs,
    })

    const tree = RunsView({
      issues: [issue],
      selectedIndex: 0,
      selectedIssue: issue,
      selectedRun: runs[0]!,
      selectedRunEvents: [],
      mergeBatches: [],
      stats: makeStats(),
      titleLookup: emptyTitleLookup(),
      mode: 'list',
      maxVisibleRuns: 20,
      eventScrollOffset: 0,
      eventWindowSize: 20,
    })

    expect(hasColoredFragment(tree, 'verify', 'green')).toBe(true)
    expect(hasExactTextWithColor(tree, '3', 'red')).toBe(true)
    expect(hasExactTextWithColor(tree, '$2.50', 'red')).toBe(true)
    expect(hasExactTextWithColor(tree, 'PR #42', 'cyan')).toBe(true)

    const historyLine = findTextNode(tree, 'runs 4 hist')
    expect(historyLine).toBeTruthy()

    const historyText = flattenText(historyLine!.props.children)
    expect(historyText).toContain('running')
    expect(historyText).toContain('blocked')
    expect(historyText).toContain('queued')
    expect(historyText).not.toContain('error')
    expect(hasColoredFragment(historyLine, 'running', 'yellow')).toBe(true)
    expect(hasColoredFragment(historyLine, 'blocked', 'red')).toBe(true)
    expect(hasColoredFragment(historyLine, 'queued', 'cyan')).toBe(true)
  })

  it('renders semantic colors for selected run metadata in focus mode', () => {
    const selectedRun = makeRunRow({
      id: 'run-focus',
      status: 'running',
      current_phase: 'verify',
      iteration_count: 3,
      estimated_cost_usd: 2.5,
      pr_number: 42,
      created_at: '2026-04-01T10:08:00.000Z',
      updated_at: '2026-04-01T10:08:30.000Z',
    })
    const issue = makeIssueRow({
      status: 'blocked',
      current_phase: 'review',
      iteration_count: 2,
      estimated_cost_usd: 1.2,
      pr_number: 42,
      runs: [selectedRun],
    })

    const events: AgentEventRow[] = [
      {
        id: 1,
        run_id: selectedRun.id,
        role: 'coder',
        event_type: 'text',
        data: JSON.stringify({ text: 'working' }),
        created_at: '2026-04-01T10:09:00.000Z',
      },
    ]

    const tree = RunsView({
      issues: [issue],
      selectedIndex: 0,
      selectedIssue: issue,
      selectedRun,
      selectedRunEvents: events,
      mergeBatches: [],
      stats: makeStats(),
      titleLookup: emptyTitleLookup(),
      mode: 'focus',
      maxVisibleRuns: 20,
      eventScrollOffset: 0,
      eventWindowSize: 20,
    })

    expect(hasColoredFragment(tree, 'blocked', 'red')).toBe(true)
    expect(hasColoredFragment(tree, 'review', 'magenta')).toBe(true)
    expect(hasExactTextWithColor(tree, 'PR #42', 'cyan')).toBe(true)
    expect(hasColoredFragment(tree, 'running', 'yellow')).toBe(true)
    expect(hasExactTextWithColor(tree, 'i3', 'red')).toBe(true)
    expect(hasExactTextWithColor(tree, '$2.50', 'red')).toBe(true)
  })
})

function emptyTitleLookup(): TitleLookup {
  return {
    issues: {},
    prs: {},
  }
}

function makeIssueRow(partial: Partial<IssueListRow>): IssueListRow {
  const repo = partial.repo ?? 'org/repo'
  const issueNumber = partial.issue_number ?? 7
  const runs = partial.runs ?? [makeRunRow({})]

  return {
    key: partial.key ?? `${repo}#${issueNumber}`,
    repo,
    issue_number: issueNumber,
    issue_title: partial.issue_title ?? 'Issue title',
    status: partial.status ?? 'running',
    current_phase: partial.current_phase ?? 'plan',
    iteration_count: partial.iteration_count ?? 1,
    estimated_cost_usd: partial.estimated_cost_usd ?? 0.1,
    last_error: partial.last_error ?? null,
    pr_number: partial.pr_number ?? null,
    pr_title: partial.pr_title ?? null,
    created_at: partial.created_at ?? '2026-04-01T10:00:00.000Z',
    updated_at: partial.updated_at ?? '2026-04-01T10:05:00.000Z',
    runs,
  }
}

function makeRunRow(partial: Partial<RunListRow>): RunListRow {
  return {
    id: partial.id ?? 'run-1',
    run_id: partial.run_id ?? partial.id ?? 'run-1',
    repo: partial.repo ?? 'org/repo',
    issue_number: partial.issue_number ?? 7,
    issue_title: partial.issue_title ?? 'Issue title',
    status: partial.status ?? 'running',
    current_phase: partial.current_phase ?? 'plan',
    iteration_count: partial.iteration_count ?? 1,
    estimated_cost_usd: partial.estimated_cost_usd ?? 0.1,
    last_error: partial.last_error ?? null,
    pr_number: partial.pr_number ?? null,
    pr_title: partial.pr_title ?? null,
    created_at: partial.created_at ?? '2026-04-01T10:00:00.000Z',
    updated_at: partial.updated_at ?? '2026-04-01T10:00:30.000Z',
  }
}

function makeStats(): TuiStatsSnapshot {
  return {
    updatedAt: '2026-04-01T10:00:00.000Z',
    overview: {
      totalRuns: 1,
      activeRuns: 1,
      queuedRuns: 0,
      runningRuns: 1,
      reviewReadyRuns: 0,
      completedRuns: 0,
      blockedRuns: 0,
      errorRuns: 0,
    },
    statusCounts: [],
    phaseCounts: [],
    throughput: {
      runs24h: 1,
      runs7d: 1,
      runs30d: 1,
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
  }
}

interface TextProps {
  children?: ReactNode
  color?: string
}

function findTextNode(root: ReactNode, fragment: string): ReactElement<TextProps> | null {
  for (const node of collectTextNodes(root)) {
    if (flattenText(node.props.children).includes(fragment)) {
      return node
    }
  }
  return null
}

function hasColoredFragment(root: ReactNode, fragment: string, color: string): boolean {
  return collectTextNodes(root).some((node) => {
    if (node.props.color !== color) return false
    return flattenText(node.props.children).includes(fragment)
  })
}

function hasExactTextWithColor(root: ReactNode, value: string, color: string): boolean {
  return collectTextNodes(root).some((node) => {
    if (node.props.color !== color) return false
    return flattenText(node.props.children) === value
  })
}

function collectTextNodes(node: ReactNode): ReactElement<TextProps>[] {
  const collected: ReactElement<TextProps>[] = []
  traverseNode(node, collected)
  return collected
}

function traverseNode(node: ReactNode, collected: ReactElement<TextProps>[]): void {
  if (!React.isValidElement(node)) return
  if (isLocalRenderableComponent(node.type)) {
    const rendered = (node.type as (props: Record<string, unknown>) => ReactNode)(node.props as Record<string, unknown>)
    traverseNode(rendered, collected)
    return
  }
  if (node.type === Text) {
    collected.push(node as ReactElement<TextProps>)
  }

  const withChildren = node as ReactElement<{ children?: ReactNode }>
  for (const child of React.Children.toArray(withChildren.props.children)) {
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
    if (isLocalRenderableComponent(node.type)) {
      const rendered = (node.type as (props: Record<string, unknown>) => ReactNode)(node.props as Record<string, unknown>)
      return flattenText(rendered)
    }
    const withChildren = node as ReactElement<{ children?: ReactNode }>
    return flattenText(withChildren.props.children)
  }
  return ''
}

function isLocalRenderableComponent(type: unknown): boolean {
  if (typeof type !== 'function') return false
  return type.name === 'FocusedIssueView' || type.name === 'RunHistory'
}
