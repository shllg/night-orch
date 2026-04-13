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
    isWorking: false,
    socketConnected: true,
    lastRefreshAt: '2026-04-01T10:00:00.000Z',
    pollIntervalSeconds: 30,
    reposCount: 2,
    activeRuns: 1,
    runningRuns: 1,
    queuedRuns: 0,
    operationsEnabled: true,
    activeOperation: null,
    isRefreshing: false,
    onRefresh: () => {},
    onPoll: () => {},
    onSync: () => {},
    onCleanup: () => {},
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
  it('renders compact run stats', () => {
    const text = renderHeaderText({})
    expect(text).toContain('active 1')
    expect(text).toContain('running 1')
    expect(text).toContain('queued 0')
    expect(text).toContain('repos 2')
  })

  it('wires action buttons to callbacks with accessible labels', () => {
    const onRefresh = vi.fn<() => void>()
    const onPoll = vi.fn<() => void>()
    const onSync = vi.fn<() => void>()
    const onCleanup = vi.fn<() => void>()
    const onGoToSettings = vi.fn<() => void>()

    const buttons = collectButtons(
      React.createElement(
        DashboardHeader,
        buildProps({
          onRefresh,
          onPoll,
          onSync,
          onCleanup,
          onGoToSettings,
        }),
      ),
    )

    findButton(buttons, 'Refresh data').props.onClick?.()
    findButton(buttons, 'Trigger poll').props.onClick?.()
    findButton(buttons, 'Run sync').props.onClick?.()
    findButton(buttons, 'Run cleanup').props.onClick?.()
    findButton(buttons, 'Open settings').props.onClick?.()

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onPoll).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(onCleanup).toHaveBeenCalledTimes(1)
    expect(onGoToSettings).toHaveBeenCalledTimes(1)
  })

  it('renders DaisyUI tooltips for header icon actions', () => {
    const html = renderHeader({})

    expect((html.match(/class="tooltip tooltip-bottom"/g) ?? []).length).toBe(5)
    expect(html).toContain('data-tip="Refresh data"')
    expect(html).toContain('data-tip="Trigger poll"')
    expect(html).toContain('data-tip="Run sync"')
    expect(html).toContain('data-tip="Run cleanup"')
    expect(html).toContain('data-tip="Open settings"')
  })

  it('shows busy/disabled action states while operations are active', () => {
    const html = renderHeader({
      isRefreshing: true,
      activeOperation: 'cleanup',
    })
    const spinnerCount = (html.match(/loading-spinner/g) ?? []).length
    expect(spinnerCount).toBe(2)

    const buttons = collectButtons(
      React.createElement(
        DashboardHeader,
        buildProps({
          isRefreshing: true,
          activeOperation: 'cleanup',
        }),
      ),
    )

    expect(findButton(buttons, 'Refreshing...').props.disabled).toBe(true)
    expect(findButton(buttons, 'Trigger poll').props.disabled).toBe(true)
    expect(findButton(buttons, 'Run sync').props.disabled).toBe(true)
    expect(findButton(buttons, 'Cleaning up...').props.disabled).toBe(true)
    expect(findButton(buttons, 'Open settings').props.disabled).toBe(false)
  })
})
