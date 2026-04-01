import { describe, expect, it } from 'vitest'
import { moveProjectSelection, resolveTabHotkey } from '../../../src/cli/tui/app.js'

describe('tui app input helpers', () => {
  it('maps tab hotkeys to tab ids', () => {
    expect(resolveTabHotkey('1')).toBe('runs')
    expect(resolveTabHotkey('2')).toBe('projects')
    expect(resolveTabHotkey('3')).toBe('stats')
    expect(resolveTabHotkey('4')).toBe('logs')
    expect(resolveTabHotkey('x')).toBeNull()
  })

  it('clamps project selection while moving down', () => {
    expect(moveProjectSelection(0, 1, 3)).toBe(1)
    expect(moveProjectSelection(1, 1, 3)).toBe(2)
    expect(moveProjectSelection(2, 1, 3)).toBe(2)
  })

  it('clamps project selection while moving up', () => {
    expect(moveProjectSelection(2, -1, 3)).toBe(1)
    expect(moveProjectSelection(1, -1, 3)).toBe(0)
    expect(moveProjectSelection(0, -1, 3)).toBe(0)
  })

  it('keeps index stable when no repos are configured', () => {
    expect(moveProjectSelection(0, 1, 0)).toBe(0)
    expect(moveProjectSelection(4, -1, 0)).toBe(0)
  })
})
