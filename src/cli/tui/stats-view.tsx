import React from 'react'
import { Box, Text } from 'ink'
import type { TuiStatsSnapshot } from '../../state/stats.js'
import { buildSparkline } from './view-model.js'
import { formatMinutes, formatStatusMix, formatTime, truncate } from './format.js'

interface StatsViewProps {
  stats: TuiStatsSnapshot
  autoRefresh: boolean
  pollIntervalMs: number
  lastRefreshAt: string
}

export function StatsView({ stats, autoRefresh, pollIntervalMs, lastRefreshAt }: StatsViewProps): React.ReactElement {
  const costSeries = stats.cost.dailyHistory.slice().reverse().map((row) => row.totalCostUsd)

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text color={autoRefresh ? 'green' : 'yellow'}>{autoRefresh ? '● stats polling active' : '○ stats polling paused'}</Text>
        <Text color="gray">  interval {pollIntervalMs / 1000}s</Text>
        <Text color="gray">  last refresh {formatTime(lastRefreshAt)}</Text>
      </Box>

      <Box marginBottom={1}>
        <StatCard title="Run Health" width="50%" marginRight={1}>
          <Text>total {stats.overview.totalRuns}  active {stats.overview.activeRuns}</Text>
          <Text color="gray">running {stats.overview.runningRuns}  queued {stats.overview.queuedRuns}</Text>
          <Text color="gray">review_ready {stats.overview.reviewReadyRuns}  completed {stats.overview.completedRuns}</Text>
          <Text color="gray">blocked {stats.overview.blockedRuns}  error {stats.overview.errorRuns}</Text>
          <Text color="gray">mix {formatStatusMix(stats.statusCounts)}</Text>
        </StatCard>

        <StatCard title="Throughput" width="50%">
          <Text>runs 24h {stats.throughput.runs24h}  7d {stats.throughput.runs7d}  30d {stats.throughput.runs30d}</Text>
          <Text color="gray">completed 7d {stats.throughput.completed7d}</Text>
          <Text color="gray">blocked 7d {stats.throughput.blocked7d}  error 7d {stats.throughput.error7d}</Text>
          <Text color="gray">success 7d {stats.throughput.successRate7d.toFixed(1)}%</Text>
          <Text color="gray">avg duration {formatMinutes(stats.throughput.avgDurationMinutes7d)}  avg iter {stats.throughput.avgIterations7d.toFixed(2)}</Text>
        </StatCard>
      </Box>

      <Box marginBottom={1}>
        <StatCard title="Cost" width="50%" marginRight={1}>
          <Text>today ${stats.cost.todayCostUsd.toFixed(2)} ({stats.cost.todayRunCount} runs)</Text>
          <Text color="gray">7d ${stats.cost.cost7d.toFixed(2)}  30d ${stats.cost.cost30d.toFixed(2)}</Text>
          <Text color="gray">avg/day 7d ${stats.cost.avgDailyCost7d.toFixed(2)}</Text>
          <Text color="gray">trend {buildSparkline(costSeries)}</Text>
          {stats.cost.dailyHistory.slice(0, 4).map((row) => (
            <Text key={row.date} color="gray">{row.date}: ${row.totalCostUsd.toFixed(2)} ({row.runCount})</Text>
          ))}
        </StatCard>

        <StatCard title="Agent Activity" width="50%">
          <Text>events total {stats.agents.eventsTotal}</Text>
          <Text color="gray">24h {stats.agents.events24h}  7d {stats.agents.events7d}</Text>
          <Text color="gray">tool calls 24h {stats.agents.toolCalls24h}</Text>
          <Text color="gray">thinking 24h {stats.agents.thinking24h}  runs 7d {stats.agents.uniqueRuns7d}</Text>
          <Text color="gray">
            roles {stats.agents.roleBreakdown7d.length === 0 ? '-' : stats.agents.roleBreakdown7d.map((row) => `${row.role}:${row.events}`).join('  ')}
          </Text>
        </StatCard>
      </Box>

      <Box>
        <StatCard title="Merge Queue" width="35%" marginRight={1}>
          <Text>active batches {stats.queue.activeBatches}</Text>
          <Text color="gray">
            statuses {stats.queue.statuses.length === 0 ? '-' : stats.queue.statuses.map((row) => `${row.status}:${row.count}`).join('  ')}
          </Text>
          <Text color="gray">
            active phases {stats.phaseCounts.length === 0 ? '-' : stats.phaseCounts.map((row) => `${row.phase}:${row.count}`).join('  ')}
          </Text>
        </StatCard>

        <StatCard title="Top Repositories (30d)" width="65%">
          {stats.topRepos30d.length === 0 && <Text color="gray">No run history</Text>}
          {stats.topRepos30d.map((row) => {
            const terminalCount = row.completedRuns + row.blockedRuns + row.errorRuns
            const successPct = terminalCount > 0 ? (row.completedRuns / terminalCount) * 100 : 0
            return (
              <Text key={row.repo}>
                <Text>{truncate(row.repo, 28)}</Text>
                {'  '}
                <Text color="gray">runs {row.totalRuns}</Text>
                {'  '}
                <Text color="green">ok {successPct.toFixed(0)}%</Text>
                {'  '}
                <Text color="gray">cost ${row.totalCostUsd.toFixed(2)}</Text>
                {'  '}
                <Text color="gray">iter {row.avgIterations.toFixed(1)}</Text>
              </Text>
            )
          })}
        </StatCard>
      </Box>
    </Box>
  )
}

interface StatCardProps {
  title: string
  width: string
  marginRight?: number
  children: React.ReactNode
}

function StatCard({ title, width, marginRight = 0, children }: StatCardProps): React.ReactElement {
  return (
    <Box
      width={width}
      marginRight={marginRight}
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold color="cyan">{title}</Text>
      {children}
    </Box>
  )
}
