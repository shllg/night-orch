import React from 'react'
import { Box, Text } from 'ink'
import type Database from 'better-sqlite3'

interface ActiveRunsProps {
  db: Database.Database
  tick: number
}

interface ActiveRunRow {
  id: string
  repo: string
  issue_number: number
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  running: { icon: '●', color: 'yellow' },
  queued: { icon: '○', color: 'cyan' },
  review_ready: { icon: '◆', color: 'magenta' },
  blocked: { icon: '■', color: 'red' },
  error: { icon: '✗', color: 'red' },
}

export function ActiveRuns({ db, tick: _tick }: ActiveRunsProps): React.ReactElement {
  const rows = db
    .prepare("SELECT id, repo, issue_number, status, current_phase, iteration_count, estimated_cost_usd FROM runs WHERE status IN ('queued', 'running', 'review_ready', 'blocked', 'error') ORDER BY created_at DESC LIMIT 10")
    .all() as ActiveRunRow[]

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Active Runs</Text>
        <Text color="gray">  No active runs</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Active Runs</Text>
      {rows.map(row => {
        const s = STATUS_ICONS[row.status] ?? { icon: '?', color: 'white' }
        return (
          <Text key={row.id}>
            {'  '}
            <Text color={s.color as 'yellow' | 'cyan' | 'magenta' | 'red' | 'white'}>{s.icon}</Text>
            {' '}
            <Text>#{row.issue_number} {row.repo}</Text>
            {'  '}
            <Text color="gray">{row.status}</Text>
            {'  '}
            <Text color="gray">[{row.current_phase ?? '?'}]</Text>
            {'  '}
            <Text color="gray">iter {row.iteration_count ?? 0}</Text>
            {'  '}
            <Text color="green">${(row.estimated_cost_usd ?? 0).toFixed(2)}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
