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

interface ActiveRunsProps {
  db: Database.Database
  tick: number
}

interface ActiveRunRow {
  id: string
  repo: string
  issue_number: number
  status: string
  pr_number: number | null
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  theoretical_cost_usd: number | null
}

const STATUS_ICONS: Record<string, { icon: string; color: TuiColor }> = {
  running: { icon: '●', color: 'yellow' },
  queued: { icon: '○', color: 'cyan' },
  review_ready: { icon: '◆', color: 'magenta' },
  blocked: { icon: '■', color: 'red' },
  error: { icon: '✗', color: 'red' },
}

export function ActiveRuns({ db, tick: _tick }: ActiveRunsProps): React.ReactElement {
  const rows = db
    .prepare("SELECT id, repo, issue_number, status, pr_number, current_phase, iteration_count, estimated_cost_usd, theoretical_cost_usd FROM runs WHERE status IN ('queued', 'running', 'review_ready', 'blocked', 'error') ORDER BY created_at DESC LIMIT 10")
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
            <Text color={s.color}>{s.icon}</Text>
            {' '}
            <Text>#{row.issue_number} {row.repo}</Text>
            {'  '}
            <Text color={colorForRunStatus(row.status)}>{row.status}</Text>
            {'  '}
            <Text color={colorForPhase(row.current_phase)}>[{row.current_phase ?? '?'}]</Text>
            {'  '}
            <Text color={colorForIterationCount(row.iteration_count)}>iter {row.iteration_count ?? 0}</Text>
            {'  '}
            <Text color={colorForCostUsd(row.estimated_cost_usd)}>${(row.estimated_cost_usd ?? 0).toFixed(2)}</Text>
            <Text dimColor>/${(row.theoretical_cost_usd ?? row.estimated_cost_usd ?? 0).toFixed(2)}</Text>
            {'  '}
            <Text color={colorForPrNumber(row.pr_number)}>{row.pr_number !== null ? `PR #${row.pr_number}` : 'no PR'}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
