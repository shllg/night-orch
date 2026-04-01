import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToString } from 'ink'
import type { TuiLogLine } from '../../../src/cli/tui/types.js'
import {
  buildLogDetailLines,
  LogsView,
  resolveLogLevelColor,
  sliceRowsByOffset,
} from '../../../src/cli/tui/logs-view.js'

function buildLogs(): TuiLogLine[] {
  return [
    {
      id: 1,
      createdAt: '2026-04-01T12:00:00.000Z',
      level: 'info',
      message: 'startup complete',
    },
    {
      id: 2,
      createdAt: '2026-04-01T12:00:01.000Z',
      level: 'warn',
      message: 'selected payload line 1\nline 2',
    },
    {
      id: 3,
      createdAt: '2026-04-01T12:00:02.000Z',
      level: 'error',
      message: 'fatal issue',
    },
  ]
}

describe('logs view', () => {
  it('renders empty state with guidance', () => {
    const output = renderToString(React.createElement(LogsView, {
      logs: [],
      selectedIndex: -1,
      windowSize: 6,
      detailScrollOffset: 0,
    }))

    expect(output).toContain('Logs (0)')
    expect(output).toContain('No logs yet')
    expect(output).toContain('Select a log row to')
    expect(output).toContain('Press j/k to select log row, J/K to scroll raw detail')
  })

  it('renders selected row marker and raw detail content', () => {
    const output = renderToString(React.createElement(LogsView, {
      logs: buildLogs(),
      selectedIndex: 1,
      windowSize: 6,
      detailScrollOffset: 0,
    }))

    expect(output).toContain('Logs (3)')
    expect(output).toContain('▶')
    expect(output).toContain('002')
    expect(output).toContain('selected payload line 1')
    expect(output).toContain('id 2')
    expect(output).toContain('detail 1-')
  })

  it('shows raw json when detail pane is scrolled', () => {
    const output = renderToString(React.createElement(LogsView, {
      logs: buildLogs(),
      selectedIndex: 1,
      windowSize: 6,
      detailScrollOffset: 10,
    }))

    expect(output).toContain('raw')
    expect(output).toContain('"id": 2')
  })

  it('color-codes levels with deterministic mapping', () => {
    expect(resolveLogLevelColor('info')).toBe('cyan')
    expect(resolveLogLevelColor('warn')).toBe('yellow')
    expect(resolveLogLevelColor('error')).toBe('red')
  })

  it('windows detail rows by scroll offset and clamps to bounds', () => {
    const lines = buildLogDetailLines(buildLogs()[1]!)
    const windowed = sliceRowsByOffset(lines, 2, 4)

    expect(windowed.rows).toHaveLength(4)
    expect(windowed.offset).toBe(2)

    const clamped = sliceRowsByOffset(lines, 999, 4)
    expect(clamped.offset).toBe(clamped.maxOffset)
    expect(clamped.rows).toHaveLength(4)
  })
})
