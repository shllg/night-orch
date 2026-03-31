import { describe, expect, it } from 'vitest'
import { buildSparkline, sliceWindow } from '../../../src/cli/tui/view-model.js'

describe('tui view model helpers', () => {
  it('centers a selected index in a bounded window', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const windowed = sliceWindow(rows, 4, 3)

    expect(windowed.start).toBe(3)
    expect(windowed.rows).toEqual(['d', 'e', 'f'])
  })

  it('builds a sparkline string with one character per value', () => {
    const sparkline = buildSparkline([1, 2, 3, 4])

    expect(sparkline).toHaveLength(4)
    expect(sparkline).not.toBe('----')
  })
})
