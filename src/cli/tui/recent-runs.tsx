import React from 'react'
import { Box, Text } from 'ink'
import type Database from 'better-sqlite3'
import {
  colorForCostUsd,
  colorForIterationCount,
  colorForPhase,
  colorForPrNumber,
  colorForRunStatus,
  type TuiColor,
} from './constants.js'

interface RecentRunsProps {
  db: Database.Database
  tick: number
}

interface RecentRunRow {
  id: string
  repo: string
  issue_number: number
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  theoretical_cost_usd: number | null
  pr_number: number | null
  last_error: string | null
}

const STATUS_DISPLAY: Record<string, { icon: string; color: TuiColor }> = {
  completed: { icon: '✓', color: 'green' },
}

export function RecentRuns({ db, tick: _tick }: RecentRunsProps): React.ReactElement {
  const rows = db
    .prepare("SELECT id, repo, issue_number, status, current_phase, iteration_count, estimated_cost_usd, theoretical_cost_usd, pr_number, last_error FROM runs WHERE status = 'completed' ORDER BY updated_at DESC LIMIT 15")
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
            <Text color={s.color}>{s.icon}</Text>
            {' '}
            <Text>#{row.issue_number} {row.repo}</Text>
            {'  '}
            <Text color={colorForRunStatus(row.status)}>{row.status}</Text>
            {'  '}
            <Text color={colorForPhase(row.current_phase)}>{row.current_phase ?? '-'}</Text>
            {'  '}
            <Text color={colorForIterationCount(row.iteration_count)}>{row.iteration_count ?? 0} iter</Text>
            {'  '}
            <Text color={colorForCostUsd(row.estimated_cost_usd)}>${(row.estimated_cost_usd ?? 0).toFixed(2)}</Text>
            <Text dimColor>/${(row.theoretical_cost_usd ?? row.estimated_cost_usd ?? 0).toFixed(2)}</Text>
            {'  '}
            <Text color={colorForPrNumber(row.pr_number)}>{row.pr_number !== null ? `PR #${row.pr_number}` : 'no PR'}</Text>
            {errorInfo && <Text color="red">{errorInfo}</Text>}
          </Text>
        )
      })}
    </Box>
  )
}
