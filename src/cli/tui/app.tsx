import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { ActiveRuns } from './active-runs.js'
import { AgentStream } from './agent-stream.js'
import { CostBar } from './cost-bar.js'
import { RecentRuns } from './recent-runs.js'
import { MergeQueuePanel } from './merge-queue-panel.js'
import type Database from 'better-sqlite3'

interface AppProps {
  db: Database.Database
  pollIntervalMs?: number
}

export function App({ db, pollIntervalMs = 2000 }: AppProps): React.ReactElement {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), pollIntervalMs)
    return () => clearInterval(timer)
  }, [pollIntervalMs])

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">night-orch</Text>
        <Text color="gray"> — live dashboard (refreshing every {pollIntervalMs / 1000}s)</Text>
      </Box>
      <ActiveRuns db={db} tick={tick} />
      <AgentStream db={db} tick={tick} />
      <MergeQueuePanel db={db} tick={tick} />
      <CostBar db={db} tick={tick} />
      <RecentRuns db={db} tick={tick} />
    </Box>
  )
}
