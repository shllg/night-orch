import React from 'react'
import { Box, Text } from 'ink'
import type Database from 'better-sqlite3'

interface CostBarProps {
  db: Database.Database
  tick: number
  maxDailyCost?: number
}

export function CostBar({ db, tick: _tick, maxDailyCost = 50 }: CostBarProps): React.ReactElement {
  const today = new Date().toISOString().split('T')[0]!
  const row = db
    .prepare('SELECT total_cost_usd FROM daily_costs WHERE date = ?')
    .get(today) as { total_cost_usd: number } | undefined

  const cost = row?.total_cost_usd ?? 0
  const pct = Math.min(100, (cost / maxDailyCost) * 100)
  const barWidth = 30
  const filled = Math.round((pct / 100) * barWidth)
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
  const color: 'red' | 'yellow' | 'green' = pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green'

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Daily Cost</Text>
      <Text>
        {'  '}
        <Text color={color}>{bar}</Text>
        {' '}
        <Text>${cost.toFixed(2)} / ${maxDailyCost} ({pct.toFixed(1)}%)</Text>
      </Text>
    </Box>
  )
}
