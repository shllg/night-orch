import { describe, expect, it } from 'vitest'
import { buildActionHints } from '../../../src/cli/tui/actions-bar.js'

describe('buildActionHints', () => {
  const sectionMap = (hints: ReturnType<typeof buildActionHints>): Record<string, string> => (
    Object.fromEntries(hints.sections.map((section) => [section.name, section.hints]))
  )

  it('shows run-specific controls on runs tab', () => {
    const sections = sectionMap(buildActionHints({
      activeTab: 'runs',
      busy: false,
      runFocused: false,
      autoRefresh: true,
    }))

    expect(sections.navigation).toContain('[1-4]tabs [h/l]tabs [j/k]select issue [o/enter]open')
    expect(sections.global).toContain('[q]quit [r]refresh [p]poll [s]sync [L]labels-init [D]cleanup(confirm)')
    expect(sections.issue).toContain('[t]retry [T]retry fresh [c]continue [_]rebase [X]delete entry')
  })

  it('keeps issue actions visible in monitor mode while hiding poll/sync/cleanup', () => {
    const sections = sectionMap(buildActionHints({
      activeTab: 'runs',
      busy: false,
      runFocused: false,
      autoRefresh: true,
      controlsEnabled: false,
    }))

    expect(sections.global).toBe('[q]quit [r]refresh')
    expect(sections.issue).toContain('[t]retry [T]retry fresh [c]continue [_]rebase [X]delete entry')
  })

  it('shows focused run controls when detail view is open', () => {
    const sections = sectionMap(buildActionHints({
      activeTab: 'runs',
      busy: false,
      runFocused: true,
      autoRefresh: true,
    }))

    expect(sections.navigation).toContain('[1-4]tabs [h/l]tabs [j/k]scroll run')
    expect(sections.global).toContain('[q/esc]close [r]refresh')
    expect(sections.issue).toContain('focused run detail')
  })

  it('shows stats polling controls on stats tab without retry/rebase', () => {
    const sections = sectionMap(buildActionHints({
      activeTab: 'stats',
      busy: false,
      runFocused: false,
      autoRefresh: false,
    }))

    expect(sections.navigation).toBe('[1-4]tabs [h/l]tabs')
    expect(sections.global).toContain('[q]quit [r]refresh [a]toggle auto-refresh')
    expect(sections.issue).not.toContain('retry')
    expect(sections.issue).not.toContain('rebase')
  })

  it('does not leak focused-run global hints onto non-runs tabs', () => {
    const sections = sectionMap(buildActionHints({
      activeTab: 'stats',
      busy: false,
      runFocused: true,
      autoRefresh: true,
    }))

    expect(sections.global).toContain('[q]quit [r]refresh [a]toggle auto-refresh')
    expect(sections.global).not.toContain('[q/esc]close')
  })

  it('shows project selection controls on projects tab', () => {
    const sections = sectionMap(buildActionHints({
      activeTab: 'projects',
      busy: false,
      runFocused: false,
      autoRefresh: true,
    }))

    expect(sections.navigation).toContain('[j/k]select project')
    expect(sections.global).toContain('[q]quit [r]refresh')
    expect(sections.issue).toContain('runs tab')
  })

  it('shows log navigation controls on logs tab', () => {
    const sections = sectionMap(buildActionHints({
      activeTab: 'logs',
      busy: false,
      runFocused: false,
      autoRefresh: false,
    }))

    expect(sections.navigation).toContain('[j/k]select log [J/K]scroll raw')
    expect(sections.global).toContain('[q]quit [r]refresh')
    expect(sections.issue).toContain('runs tab')
  })
})
