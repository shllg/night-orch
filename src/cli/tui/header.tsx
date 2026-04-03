import React from 'react'
import { Box, Text } from 'ink'
import type { TuiStatsSnapshot } from '../../state/stats.js'
import { TABS } from './constants.js'
import type { TabId } from './types.js'
import { formatTime } from './format.js'
import type { BuildInfo } from '../../utils/build-info.js'

interface HeaderProps {
  activeTab: TabId
  pollIntervalMs: number
  dryRun: boolean
  status: TuiStatsSnapshot
  autoRefresh: boolean
  lastRefreshAt: string
  buildInfo: BuildInfo
}

export function Header({
  activeTab,
  pollIntervalMs,
  dryRun,
  status,
  autoRefresh,
  lastRefreshAt,
  buildInfo,
}: HeaderProps): React.ReactElement {
  const shortSha = buildInfo.gitSha ? buildInfo.gitSha.slice(0, 12) : 'unknown'

  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="blue" paddingX={1}>
      <Box>
        <Text bold color="white">NIGHT-ORCH CONTROL ROOM</Text>
        <Text color="gray">  v{buildInfo.version}</Text>
        <Text color="gray">  sha {shortSha}</Text>
        <Text color="gray">  refresh {pollIntervalMs / 1000}s</Text>
        {dryRun && <Text color="yellow">  [dry-run]</Text>}
        <Text color={autoRefresh ? 'green' : 'yellow'}>  {autoRefresh ? '● live' : '○ paused'}</Text>
        <Text color="gray">  updated {formatTime(lastRefreshAt)}</Text>
      </Box>
      <Box>
        {TABS.map((tab) => (
          <Box key={tab.id} marginRight={2}>
            <Text bold={activeTab === tab.id} color={activeTab === tab.id ? 'white' : 'gray'}>
              {activeTab === tab.id ? '▸' : ' '}[{tab.hotkey}] {tab.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>
        runs {status.overview.totalRuns}  active {status.overview.activeRuns}  queued {status.overview.queuedRuns}  running {status.overview.runningRuns}  cost today ${status.cost.todayCostUsd.toFixed(2)}
      </Text>
    </Box>
  )
}
