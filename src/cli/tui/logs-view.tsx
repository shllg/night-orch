import React from 'react'
import { Box, Text } from 'ink'
import { formatTime, truncate } from './format.js'
import { formatUtcDateTime } from '../../utils/time.js'
import type { TuiLogLine } from './types.js'
import { sliceWindow } from './view-model.js'

interface LogsViewProps {
  logs: TuiLogLine[]
  selectedIndex: number
  windowSize: number
  detailScrollOffset: number
}

export function LogsView({ logs, selectedIndex, windowSize, detailScrollOffset }: LogsViewProps): React.ReactElement {
  const safeWindowSize = Math.max(1, windowSize)
  const hasRows = logs.length > 0
  const safeSelectedIndex = hasRows ? Math.max(0, Math.min(logs.length - 1, selectedIndex)) : -1
  const windowedRows = sliceWindow(logs, safeSelectedIndex >= 0 ? safeSelectedIndex : 0, safeWindowSize)
  const selectedRow = safeSelectedIndex >= 0 ? (logs[safeSelectedIndex] ?? null) : null
  const detailLines = buildLogDetailLines(selectedRow)
  const detailWindow = sliceRowsByOffset(detailLines, detailScrollOffset, Math.max(1, safeWindowSize - 1))
  const visibleRange = windowedRows.rows.length === 0
    ? `showing 0 of ${logs.length}`
    : `showing ${windowedRows.start + 1}-${windowedRows.start + windowedRows.rows.length} of ${logs.length}`
  const detailRange = detailWindow.rows.length === 0
    ? `detail 0 of ${detailLines.length}`
    : `detail ${detailWindow.offset + 1}-${detailWindow.offset + detailWindow.rows.length} of ${detailLines.length}`

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <Text bold>Logs ({logs.length})</Text>
      <Text dimColor>Integrated poller output and control actions</Text>

      <Box marginTop={1} flexGrow={1} minHeight={0}>
        <Box
          width="64%"
          marginRight={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          flexGrow={1}
        >
          {windowedRows.rows.length === 0 && <Text color="gray">No logs yet</Text>}
          {windowedRows.rows.map((line, index) => {
            const absoluteIndex = windowedRows.start + index
            const selected = absoluteIndex === safeSelectedIndex
            return (
              <Text key={line.id} dimColor={!selected}>
                <Text color={selected ? 'cyan' : 'gray'}>{selected ? '▶' : ' '}</Text>
                {' '}
                <Text color="gray">{String(absoluteIndex + 1).padStart(3, '0')}</Text>
                {' '}
                <Text color="gray">{formatTime(line.createdAt)}</Text>
                {' '}
                <Text color={resolveLogLevelColor(line.level)}>{line.level.toUpperCase().padEnd(5)}</Text>
                {' '}
                <Text>{truncate(line.message, 80)}</Text>
              </Text>
            )
          })}
        </Box>

        <Box
          width="36%"
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          flexGrow={1}
        >
          <Text bold color="cyan">Raw Log</Text>
          {!selectedRow && <Text color="gray">Select a log row to inspect</Text>}
          {selectedRow && detailWindow.rows.map((line, index) => (
            <Text key={`${detailWindow.offset}-${index}`}>{line.length > 0 ? line : ' '}</Text>
          ))}
        </Box>
      </Box>

      <Text color="gray">{visibleRange}  {detailRange}</Text>
      <Text color="gray">Press j/k to select log row, J/K to scroll raw detail</Text>
    </Box>
  )
}

export function resolveLogLevelColor(level: TuiLogLine['level']): 'cyan' | 'yellow' | 'red' {
  if (level === 'error') return 'red'
  if (level === 'warn') return 'yellow'
  return 'cyan'
}

export function buildLogDetailLines(row: TuiLogLine | null): string[] {
  if (!row) return []
  const messageLines = row.message.split('\n')
  const rawLines = JSON.stringify(row, null, 2).split('\n')
  return [
    `time ${formatUtcDateTime(row.createdAt)}`,
    `level ${row.level.toUpperCase()}`,
    `id ${row.id}`,
    '',
    'message',
    ...messageLines,
    '',
    'raw',
    ...rawLines,
  ]
}

interface OffsetSlice<T> {
  offset: number
  rows: T[]
  maxOffset: number
}

export function sliceRowsByOffset<T>(rows: T[], offset: number, windowSize: number): OffsetSlice<T> {
  if (rows.length === 0) {
    return { offset: 0, rows: [], maxOffset: 0 }
  }
  const safeWindow = Math.max(1, windowSize)
  const maxOffset = Math.max(0, rows.length - safeWindow)
  const clampedOffset = Math.max(0, Math.min(maxOffset, offset))
  return {
    offset: clampedOffset,
    rows: rows.slice(clampedOffset, clampedOffset + safeWindow),
    maxOffset,
  }
}
