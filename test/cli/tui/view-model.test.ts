import { describe, expect, it } from 'vitest'
import { buildSparkline, isActiveRunStatus, partitionRowsByActivity, sliceWindow } from '../../../src/cli/tui/view-model.js'

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

  it('treats only queued and running statuses as active', () => {
    expect(isActiveRunStatus('queued')).toBe(true)
    expect(isActiveRunStatus('running')).toBe(true)
    expect(isActiveRunStatus('review_ready')).toBe(false)
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
    ])
    expect(partitioned.recent).toEqual([
      { id: 'c', status: 'review_ready' },
      { id: 'd', status: 'error' },
    ])
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

  it('returns empty active when all rows are recent', () => {
    const partitioned = partitionRowsByActivity([
      { id: 'a', status: 'review_ready' },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'error' },
    ])

    expect(partitioned.active).toEqual([])
    expect(partitioned.recent).toEqual([
      { id: 'a', status: 'review_ready' },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'error' },
    ])
  })
})
