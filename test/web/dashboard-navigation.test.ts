import { type ReactElement, type ReactNode, isValidElement } from 'react'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DashboardNavigation } from '../../web/src/components/DashboardNavigation.js'

type DashboardNavigationProps = React.ComponentProps<typeof DashboardNavigation>

interface ButtonProps {
  'aria-current'?: string
  'aria-label'?: string
  onClick?: () => void
}

function buildProps(overrides: Partial<DashboardNavigationProps>): DashboardNavigationProps {
  return {
    activePage: 'issues',
    onPageChange: () => {},
    ...overrides,
  }
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

describe('DashboardNavigation', () => {
  it('renders accessible labels for icon-only and dock buttons', () => {
    const buttons = collectButtons(
      React.createElement(
        DashboardNavigation,
        buildProps({
          activePage: 'projects',
        }),
      ),
    )

    expect(buttons).toHaveLength(8)
    expect(buttons.every((button) => typeof button.props['aria-label'] === 'string')).toBe(true)

    const activeButtons = buttons.filter((button) => button.props['aria-current'] === 'page')
    expect(activeButtons).toHaveLength(2)
    expect(activeButtons.every((button) => button.props['aria-label'] === 'projects')).toBe(true)
  })

  it('invokes onPageChange when a navigation button is clicked', () => {
    const onPageChange = vi.fn<(page: DashboardNavigationProps['activePage']) => void>()

    const buttons = collectButtons(
      React.createElement(
        DashboardNavigation,
        buildProps({
          onPageChange,
        }),
      ),
    )

    findButton(buttons, 'stats').props.onClick?.()
    expect(onPageChange).toHaveBeenCalledWith('stats')
  })

  it('retains desktop label visibility and mobile dock markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        DashboardNavigation,
        buildProps({
          activePage: 'issues',
        }),
      ),
    )

    expect(html).toContain('hidden text-sm capitalize lg:inline')
    expect(html).toContain('dock-label')
  })
})
