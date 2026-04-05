import { type ReactElement, type ReactNode, isValidElement } from 'react'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DashboardHeader } from '../../web/src/components/DashboardHeader.js'

type DashboardHeaderProps = React.ComponentProps<typeof DashboardHeader>

interface ButtonProps {
  'aria-label'?: string
  disabled?: boolean
  onClick?: () => void
}

function buildProps(overrides: Partial<DashboardHeaderProps>): DashboardHeaderProps {
  return {
    currentStateLabel: 'idle',
    currentStateToneClass: 'badge-ghost',
    socketConnected: true,
    lastRefreshAt: '2026-04-01T10:00:00.000Z',
    pollIntervalSeconds: 30,
    reposCount: 2,
    activeRuns: 1,
    runningRuns: 1,
    queuedRuns: 0,
    frontendVersion: '1.2.3',
    frontendGitSha: '1111111111111111111111111111111111111111',
    backendVersion: '2.3.4',
    backendGitSha: '1111111111111111111111111111111111111111',
    operationsEnabled: true,
    activeOperation: null,
    isRefreshing: false,
    onRefresh: () => {},
    onPoll: () => {},
    onSync: () => {},
    onGoToSettings: () => {},
    ...overrides,
  }
}

function renderHeader(overrides: Partial<DashboardHeaderProps>): string {
  return renderToStaticMarkup(React.createElement(DashboardHeader, buildProps(overrides)))
}

function renderHeaderText(overrides: Partial<DashboardHeaderProps>): string {
  const html = renderHeader(overrides)
  return normalizeWhitespace(html.replace(/<[^>]*>/g, ' '))
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function collectButtons(node: ReactNode, acc: ReactElement<ButtonProps>[] = []): ReactElement<ButtonProps>[] {
  if (!isValidElement(node)) {
    return acc
  }

  if (typeof node.type === 'function') {
    const rendered = (node.type as (props: unknown) => ReactNode)(node.props)
    collectButtons(rendered, acc)
    return acc
  }

  if (node.type === 'button') {
    acc.push(node as ReactElement<ButtonProps>)
  }

  React.Children.forEach((node.props as { children?: ReactNode }).children, (child) => {
    collectButtons(child, acc)
  })

  return acc
}

function findButton(buttons: ReactElement<ButtonProps>[], label: string): ReactElement<ButtonProps> {
  const button = buttons.find((entry) => entry.props['aria-label'] === label)
  expect(button).toBeDefined()
  return button as ReactElement<ButtonProps>
}

describe('DashboardHeader', () => {
  it('renders compact git stats with shared and split sha formatting', () => {
    const sameShaText = renderHeaderText({})
    expect(sameShaText).toContain('git v2.3.4 · 111111111111')

    const splitShaText = renderHeaderText({
      frontendGitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      backendGitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    expect(splitShaText).toContain('git fe aaaaaaaaaaaa / be bbbbbbbbbbbb')
  })

  it('keeps unknown SHA handling stable in compact stats', () => {
    const knownVsUnknown = renderHeaderText({
      frontendGitSha: 'cccccccccccccccccccccccccccccccccccccccc',
      backendGitSha: null,
    })
    expect(knownVsUnknown).toContain('git fe cccccccccccc / be unknown')

    const unknownVsUnknown = renderHeaderText({
      frontendGitSha: 'unknown',
      backendGitSha: null,
    })
    expect(unknownVsUnknown).toContain('git v2.3.4 · unknown')
  })

  it('wires action buttons to callbacks with accessible labels', () => {
    const onRefresh = vi.fn<() => void>()
    const onPoll = vi.fn<() => void>()
    const onSync = vi.fn<() => void>()
    const onGoToSettings = vi.fn<() => void>()

    const buttons = collectButtons(
      React.createElement(
        DashboardHeader,
        buildProps({
          onRefresh,
          onPoll,
          onSync,
          onGoToSettings,
        }),
      ),
    )

    findButton(buttons, 'Refresh data').props.onClick?.()
    findButton(buttons, 'Trigger poll').props.onClick?.()
    findButton(buttons, 'Run sync').props.onClick?.()
    findButton(buttons, 'Open settings').props.onClick?.()

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onPoll).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(onGoToSettings).toHaveBeenCalledTimes(1)
  })

  it('shows busy/disabled action states while operations are active', () => {
    const html = renderHeader({
      isRefreshing: true,
      activeOperation: 'sync',
    })
    const spinnerCount = (html.match(/loading-spinner/g) ?? []).length
    expect(spinnerCount).toBe(2)

    const buttons = collectButtons(
      React.createElement(
        DashboardHeader,
        buildProps({
          isRefreshing: true,
          activeOperation: 'sync',
        }),
      ),
    )

    expect(findButton(buttons, 'Refreshing...').props.disabled).toBe(true)
    expect(findButton(buttons, 'Trigger poll').props.disabled).toBe(true)
    expect(findButton(buttons, 'Syncing...').props.disabled).toBe(true)
    expect(findButton(buttons, 'Open settings').props.disabled).toBe(false)
  })
})
