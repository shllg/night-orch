import React from 'react'
import { Box, Text } from 'ink'
import type { FileLoopSession } from '../../../fileloop/types.js'

export interface FileLoopRow {
  repo: string
  active: FileLoopSession | null
  recent: FileLoopSession | null
}

interface FileLoopViewProps {
  rows: FileLoopRow[]
  selectedIndex: number
}

export function FileLoopView(props: FileLoopViewProps): React.ReactElement {
  const selected = props.rows[props.selectedIndex] ?? null

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold>File-Loop Sessions</Text>
      <Text color="gray">One repo-scoped maintenance session at a time. Start or stop from this tab.</Text>
      <Box marginTop={1} flexDirection="column">
        {props.rows.map((row, index) => {
          const active = row.active ?? row.recent
          return (
            <Text key={row.repo} color={index === props.selectedIndex ? 'cyan' : 'white'}>
              {index === props.selectedIndex ? '>' : ' '} {row.repo}
              {'  '}
              {active ? `${active.status}  iter=${active.iterations}  touched=${active.filesTouched}  cost=$${active.totalCostUsd.toFixed(3)}` : 'no session'}
            </Text>
          )
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Selected Repo</Text>
        {selected ? (
          <>
            <Text>{selected.repo}</Text>
            <Text color="gray">
              Active: {selected.active ? `#${selected.active.id} ${selected.active.status} until ${selected.active.endsAt}` : 'none'}
            </Text>
            <Text color="gray">
              Recent: {selected.recent ? `#${selected.recent.id} ${selected.recent.status} stopped=${selected.recent.stoppedReason ?? 'n/a'}` : 'none'}
            </Text>
          </>
        ) : (
          <Text color="gray">No repositories configured</Text>
        )}
      </Box>
    </Box>
  )
}
