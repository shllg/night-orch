import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DashboardHeader } from '../../web/src/components/DashboardHeader.js'

type DashboardHeaderProps = React.ComponentProps<typeof DashboardHeader>

function renderHeader(overrides: Partial<DashboardHeaderProps>): string {
  const props: DashboardHeaderProps = {
    activePage: 'issues',
    onPageChange: () => {},
    currentStateLabel: 'idle',
    currentStateToneClass: 'badge-ghost',
    frontendVersion: '1.2.3',
    frontendGitSha: '1111111111111111111111111111111111111111',
    backendVersion: '2.3.4',
    backendGitSha: '1111111111111111111111111111111111111111',
    ...overrides,
  }

  return renderToStaticMarkup(React.createElement(DashboardHeader, props))
}

function shaLineCount(output: string): number {
  return (output.match(/ sha /g) ?? []).length
}

describe('DashboardHeader SHA rendering', () => {
  it('renders one SHA line when frontend and backend SHAs are equal', () => {
    const output = renderHeader({})

    expect(output).toContain('frontend v1.2.3 · backend v2.3.4 · sha 111111111111')
    expect(shaLineCount(output)).toBe(1)
    expect(output).toContain('text-[10px]')
  })

  it('renders one SHA line when one SHA is a prefix of the other', () => {
    const output = renderHeader({
      frontendGitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      backendGitSha: 'abcdef0',
    })

    expect(output).toContain('frontend v1.2.3 · backend v2.3.4 · sha abcdef012345')
    expect(shaLineCount(output)).toBe(1)
  })

  it('renders separate frontend/backend SHA lines when commits differ', () => {
    const output = renderHeader({
      frontendGitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      backendGitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })

    expect(output).toContain('frontend v1.2.3 · sha aaaaaaaaaaaa')
    expect(output).toContain('backend v2.3.4 · sha bbbbbbbbbbbb')
    expect(shaLineCount(output)).toBe(2)
  })

  it('handles unknown/null SHAs consistently', () => {
    const knownVsUnknown = renderHeader({
      frontendGitSha: 'cccccccccccccccccccccccccccccccccccccccc',
      backendGitSha: null,
    })
    expect(shaLineCount(knownVsUnknown)).toBe(2)
    expect(knownVsUnknown).toContain('backend v2.3.4 · sha unknown')

    const unknownVsUnknown = renderHeader({
      frontendGitSha: 'unknown',
      backendGitSha: null,
    })
    expect(shaLineCount(unknownVsUnknown)).toBe(1)
    expect(unknownVsUnknown).toContain('frontend v1.2.3 · backend v2.3.4 · sha unknown')
  })
})
