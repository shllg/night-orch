import React from 'react'
import { Box, Text } from 'ink'
import type { TuiStatsSnapshot } from '../../state/stats.js'
import { TABS } from './constants.js'
import type { TabId } from './types.js'
import { formatTime } from './format.js'

interface HeaderProps {
  activeTab: TabId
  pollIntervalMs: number
  dryRun: boolean
  status: TuiStatsSnapshot
  autoRefresh: boolean
  lastRefreshAt: string
}

export function Header({
  activeTab,
  pollIntervalMs,
  dryRun,
  status,
  autoRefresh,
  lastRefreshAt,
}: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">NIGHT-ORCH CONTROL ROOM</Text>
        <Text color="gray">  refresh {pollIntervalMs / 1000}s</Text>
        {dryRun && <Text color="yellow">  [dry-run]</Text>}
        <Text color={autoRefresh ? 'green' : 'yellow'}>  {autoRefresh ? '● live' : '○ paused'}</Text>
        <Text color="gray">  updated {formatTime(lastRefreshAt)}</Text>
      </Box>
      <Box>
        {TABS.map((tab) => (
          <Box key={tab.id} marginRight={2}>
            <Text color={activeTab === tab.id ? 'cyan' : 'gray'}>
              {activeTab === tab.id ? '▸' : ' '}[{tab.hotkey}] {tab.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color="gray">
        runs {status.overview.totalRuns}  active {status.overview.activeRuns}  queued {status.overview.queuedRuns}  running {status.overview.runningRuns}  cost today ${status.cost.todayCostUsd.toFixed(2)}
      </Text>
    </Box>
  )
}
