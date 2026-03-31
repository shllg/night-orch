import React from 'react'
import { Box, Text } from 'ink'
import type Database from 'better-sqlite3'

interface RecentRunsProps {
  db: Database.Database
  tick: number
}

interface RecentRunRow {
  id: string
  repo: string
  issue_number: number
  status: string
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
}

const STATUS_DISPLAY: Record<string, { icon: string; color: string }> = {
  completed: { icon: '✓', color: 'green' },
  review_ready: { icon: '◆', color: 'magenta' },
  blocked: { icon: '■', color: 'red' },
  error: { icon: '✗', color: 'red' },
}

export function RecentRuns({ db, tick: _tick }: RecentRunsProps): React.ReactElement {
  const rows = db
    .prepare("SELECT id, repo, issue_number, status, iteration_count, estimated_cost_usd, last_error FROM runs WHERE status NOT IN ('queued', 'running') ORDER BY updated_at DESC LIMIT 15")
    .all() as RecentRunRow[]

  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Recent Runs</Text>
        <Text color="gray">  No completed runs</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Recent Runs</Text>
      {rows.map(row => {
        const s = STATUS_DISPLAY[row.status] ?? { icon: '?', color: 'white' }
        const errorInfo = row.last_error ? ` — ${row.last_error.slice(0, 40)}` : ''
        return (
          <Text key={row.id}>
            {'  '}
            <Text color={s.color as 'green' | 'magenta' | 'red' | 'white'}>{s.icon}</Text>
            {' '}
            <Text>#{row.issue_number} {row.repo}</Text>
            {'  '}
            <Text color="gray">{row.status}</Text>
            {'  '}
            <Text color="gray">{row.iteration_count ?? 0} iter</Text>
            {'  '}
            <Text color="green">${(row.estimated_cost_usd ?? 0).toFixed(2)}</Text>
            {errorInfo && <Text color="red">{errorInfo}</Text>}
          </Text>
        )
      })}
    </Box>
  )
}
