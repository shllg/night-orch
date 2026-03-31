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

    expect(hints.line1).toContain('[j/k]select')
    expect(hints.line1).toContain('[o/enter]open')
    expect(hints.line2).toContain('[r]etry')
    expect(hints.line2).toContain('[b]rebase')
  })

  it('shows stats polling controls on stats tab without retry/rebase', () => {
    const hints = buildActionHints({
      activeTab: 'stats',
      busy: false,
      runFocused: false,
      autoRefresh: false,
    })

    expect(hints.line1).toContain('[a]toggle auto-refresh')
    expect(hints.line2).toContain('polling paused')
    expect(hints.line2).not.toContain('retry')
    expect(hints.line2).not.toContain('rebase')
  })
})
