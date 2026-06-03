import React from 'react'
import { Box, Text } from 'ink'
import type Database from 'better-sqlite3'
import { buildTimeline, type TimelineEntry } from '../../state/timeline.js'
import { formatTime } from './format.js'
import type { TuiColor } from './constants.ts'

interface TimelineViewProps {
  db: Database.Database
  runId: string | null
  tick: number
  maxLines?: number
}

const SOURCE_COLORS: Record<TimelineEntry['source'], TuiColor> = {
  system: 'gray',
  agent: 'cyan',
  user: 'magenta',
}

const KIND_COLORS: Record<TimelineEntry['kind'], TuiColor> = {
  phase: 'yellow',
  handoff: 'green',
  event: 'gray',
  cost: 'magenta',
  prompt: 'cyan',
}

export function TimelineView({
  db,
  runId,
  tick: _tick,
  maxLines = 200,
}: TimelineViewProps): React.ReactElement {
  if (!runId) {
    return (
      <Box flexDirection="column">
        <Text bold>Timeline</Text>
        <Text color="gray">  Select an issue first (tab 1).</Text>
      </Box>
    )
  }

  const entries = buildTimeline(db, runId, { limit: maxLines })

  return (
    <Box flexDirection="column">
      <Text bold>Timeline ({runId})</Text>
      {entries.length === 0 && (
        <Text color="gray">  No timeline entries yet.</Text>
      )}
      {entries.map((entry) => {
        const ts = formatTime(new Date(entry.ts).toISOString())
        const kindColor = KIND_COLORS[entry.kind]
        const sourceColor = SOURCE_COLORS[entry.source]
        return (
          <Text key={`${entry.kind}-${entry.id}`}>
            {'  '}
            <Text color="gray">[{ts}]</Text>
            {' '}
            <Text color={kindColor}>{entry.kind.padEnd(8)}</Text>
            {' '}
            <Text color={sourceColor}>{entry.source.padEnd(6)}</Text>
            {' '}
            <Text color="gray">{(entry.phase ?? '-').padEnd(12)}</Text>
            {' '}
            <Text>{truncate(entry.summary, 80)}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value
  return value.slice(0, maxLen - 1) + '…'
}
