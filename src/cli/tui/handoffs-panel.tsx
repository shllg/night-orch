import React from 'react'
import { Box, Text } from 'ink'
import type { HandoffRow } from './data.js'

interface HandoffsPanelProps {
  handoffs: HandoffRow[]
  selectedIndex: number
  expandedIds: ReadonlySet<number>
}

export function HandoffsPanel({
  handoffs,
  selectedIndex,
  expandedIds,
}: HandoffsPanelProps): React.ReactElement {
  const safeSelectedIndex = Math.max(0, Math.min(Math.max(0, handoffs.length - 1), selectedIndex))

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Handoffs ({handoffs.length})</Text>
      {handoffs.length === 0 && <Text color="gray">No handoffs recorded</Text>}
      {handoffs.map((handoff, index) => {
        const selected = index === safeSelectedIndex
        const expanded = expandedIds.has(handoff.id)
        const fromRole = handoff.fromRole ?? '-'
        const toRole = handoff.toRole ?? '-'
        return (
          <Box key={handoff.id} flexDirection="column">
            <Text>
              <Text color={selected ? 'cyan' : 'gray'}>{selected ? '>' : ' '}</Text>
              {' '}
              <Text color={selected ? 'cyan' : undefined}>[{handoff.id}] {handoff.kind}  {handoff.stepId}</Text>
              {' '}
              <Text color="gray">{fromRole}{' -> '}{toRole}</Text>
            </Text>
            <Text>
              {'  '}
              {handoff.summary}
            </Text>
            {markdownLines(handoff.contentMd, expanded).map((line, lineIndex) => (
              <Text key={`${handoff.id}-${lineIndex}`} color={expanded ? undefined : 'gray'}>
                {'  '}
                {line}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

function markdownLines(markdown: string, expanded: boolean): string[] {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (expanded) return lines
  return lines.slice(0, 1)
}
