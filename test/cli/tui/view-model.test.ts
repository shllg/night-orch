import { describe, expect, it } from 'vitest'
import {
  buildSparkline,
  colorForHigherIsBetter,
  colorForLowerIsBetter,
  colorForPresence,
  colorForRatioToBaseline,
  isActiveRunStatus,
  partitionRowsByActivity,
  sliceWindow,
} from '../../../src/cli/tui/view-model.js'

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

  it('treats all non-completed run statuses as active', () => {
    expect(isActiveRunStatus('queued')).toBe(true)
    expect(isActiveRunStatus('running')).toBe(true)
    expect(isActiveRunStatus('blocked')).toBe(true)
    expect(isActiveRunStatus('review_ready')).toBe(true)
    expect(isActiveRunStatus('error')).toBe(true)
    expect(isActiveRunStatus('completed')).toBe(false)
  })

  it('partitions rows into active and recent sections', () => {
    const rows = [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'queued' },
      { id: 'c', status: 'review_ready' },
      { id: 'd', status: 'error' },
    ]

    const partitioned = partitionRowsByActivity(rows)

    expect(partitioned.active).toEqual([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'queued' },
      { id: 'c', status: 'review_ready' },
      { id: 'd', status: 'error' },
    ])
    expect(partitioned.recent).toEqual([])
  })

  it('returns empty active and recent arrays for empty input', () => {
    const partitioned = partitionRowsByActivity([])
    expect(partitioned.active).toEqual([])
    expect(partitioned.recent).toEqual([])
  })

  it('returns empty recent when all rows are active', () => {
    const partitioned = partitionRowsByActivity([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'queued' },
    ])

    expect(partitioned.active).toEqual([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'queued' },
    ])
    expect(partitioned.recent).toEqual([])
  })

  it('keeps only completed rows in recent', () => {
    const partitioned = partitionRowsByActivity([
      { id: 'a', status: 'review_ready' },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'error' },
    ])

    expect(partitioned.active).toEqual([
      { id: 'a', status: 'review_ready' },
      { id: 'c', status: 'error' },
    ])
    expect(partitioned.recent).toEqual([
      { id: 'b', status: 'completed' },
    ])
  })

  it('selects colors for higher-is-better metrics', () => {
    expect(colorForHigherIsBetter(90, 80, 60)).toBe('green')
    expect(colorForHigherIsBetter(70, 80, 60)).toBe('yellow')
    expect(colorForHigherIsBetter(40, 80, 60)).toBe('red')
  })

  it('selects colors for lower-is-better metrics', () => {
    expect(colorForLowerIsBetter(8, 10, 25)).toBe('green')
    expect(colorForLowerIsBetter(15, 10, 25)).toBe('yellow')
    expect(colorForLowerIsBetter(30, 10, 25)).toBe('red')
  })

  it('selects colors for presence counts', () => {
    expect(colorForPresence(0)).toBe('green')
    expect(colorForPresence(1)).toBe('yellow')
    expect(colorForPresence(3)).toBe('red')
  })

  it('selects colors for values relative to a baseline', () => {
    expect(colorForRatioToBaseline(100, 100, 1.05, 1.35)).toBe('green')
    expect(colorForRatioToBaseline(120, 100, 1.05, 1.35)).toBe('yellow')
    expect(colorForRatioToBaseline(150, 100, 1.05, 1.35)).toBe('red')
    expect(colorForRatioToBaseline(0, 0, 1.05, 1.35)).toBe('green')
    expect(colorForRatioToBaseline(10, 0, 1.05, 1.35)).toBe('yellow')
  })
})
