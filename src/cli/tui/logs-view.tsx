import React from 'react'
import { Box, Text } from 'ink'
import { formatLogLine } from './format.js'
import type { TuiLogLine } from './types.js'

interface LogsViewProps {
  logs: TuiLogLine[]
  scrollOffset: number
  windowSize: number
}

export function LogsView({ logs, scrollOffset, windowSize }: LogsViewProps): React.ReactElement {
  const maxOffset = Math.max(0, logs.length - windowSize)
  const clampedOffset = Math.max(0, Math.min(maxOffset, scrollOffset))
  const rows = logs.slice(clampedOffset, clampedOffset + windowSize)

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Logs</Text>
      <Text color="gray">Integrated poller output and control actions</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        {rows.length === 0 && <Text color="gray">No logs yet</Text>}
        {rows.map((line) => (
          <Text
            key={line.id}
            color={line.level === 'error' ? 'red' : line.level === 'warn' ? 'yellow' : 'gray'}
          >
            {formatLogLine(line, 200)}
          </Text>
        ))}
      </Box>
      {logs.length > windowSize && (
        <Text color="gray">showing {clampedOffset + 1}-{clampedOffset + rows.length} of {logs.length}</Text>
      )}
      <Text color="gray">Press j/k to scroll logs</Text>
    </Box>
  )
}
