import { describe, expect, it } from 'vitest'
import { buildActionHints } from '../../../src/cli/tui/actions-bar.js'

describe('buildActionHints', () => {
  it('shows run-specific controls on runs tab', () => {
    const hints = buildActionHints({
      activeTab: 'runs',
      busy: false,
      runFocused: false,
      autoRefresh: true,
    })

    expect(hints.line1).toContain('[1]issues [2]projects [3]stats [q]quit [p]poll')
    expect(hints.line1).toContain('[j/k]select issue [o/enter]open')
    expect(hints.line1).toContain('[4]logs [h/l]tabs')
    expect(hints.line1).toContain(' | ')
    expect(hints.line2).toContain('[r]etry')
    expect(hints.line2).toContain('[b]rebase')
  })

  it('shows focused run controls when detail view is open', () => {
    const hints = buildActionHints({
      activeTab: 'runs',
      busy: false,
      runFocused: true,
      autoRefresh: true,
    })

    expect(hints.line1).toContain('[1]issues [2]projects [3]stats [q/esc]close')
    expect(hints.line1).toContain('[j/k]scroll run')
    expect(hints.line2).toContain('focused run detail')
  })

  it('shows stats polling controls on stats tab without retry/rebase', () => {
    const hints = buildActionHints({
      activeTab: 'stats',
      busy: false,
      runFocused: false,
      autoRefresh: false,
    })

    expect(hints.line1).toContain('[a]toggle auto-refresh')
    expect(hints.line1).toContain('[1]issues [2]projects [3]stats [q]quit')
    expect(hints.line2).toContain('polling paused')
    expect(hints.line2).not.toContain('retry')
    expect(hints.line2).not.toContain('rebase')
  })

  it('shows project selection controls on projects tab', () => {
    const hints = buildActionHints({
      activeTab: 'projects',
      busy: false,
      runFocused: false,
      autoRefresh: true,
    })

    expect(hints.line1).toContain('[j/k]select project [f]refresh')
    expect(hints.line1).toContain('[2]projects')
    expect(hints.line2).toContain('labels')
  })

  it('shows log navigation controls on logs tab', () => {
    const hints = buildActionHints({
      activeTab: 'logs',
      busy: false,
      runFocused: false,
      autoRefresh: false,
    })

    expect(hints.line1).toContain('[j/k]scroll logs [f]refresh')
    expect(hints.line1).toContain('[1]issues [2]projects [3]stats [q]quit')
    expect(hints.line2).toBe('')
  })
})
