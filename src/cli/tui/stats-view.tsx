import React from 'react'
import { Box, Text } from 'ink'
import type { TuiStatsSnapshot } from '../../state/stats.js'
import {
  buildSparkline,
  colorForHigherIsBetter,
  colorForLowerIsBetter,
  colorForPresence,
  colorForRatioToBaseline,
} from './view-model.js'
import { formatMinutes, formatStatusMix, formatTime, truncate } from './format.js'

interface StatsViewProps {
  stats: TuiStatsSnapshot
  autoRefresh: boolean
  pollIntervalMs: number
  lastRefreshAt: string
}

export function StatsView({ stats, autoRefresh, pollIntervalMs, lastRefreshAt }: StatsViewProps): React.ReactElement {
  const costSeries = stats.cost.dailyHistory.slice().reverse().map((row) => row.totalCostUsd)
  const usageSeries = stats.usage.dailyHistory.slice().reverse().map((row) => row.totalTokens)
  const successColor = colorForHigherIsBetter(stats.throughput.successRate7d, 80, 60)
  const failureRateColor = colorForLowerIsBetter(stats.reliability.failureRate7d, 10, 25)
  const overviewBlockedColor = colorForPresence(stats.overview.blockedRuns, 1, 2)
  const overviewErrorColor = colorForPresence(stats.overview.errorRuns, 1, 2)
  const throughputBlockedColor = colorForPresence(stats.throughput.blocked7d, 1, 2)
  const throughputErrorColor = colorForPresence(stats.throughput.error7d, 1, 2)
  const todayCostColor = colorForRatioToBaseline(stats.cost.todayCostUsd, stats.cost.avgDailyCost7d, 1.05, 1.35)
  const todayUsageColor = colorForRatioToBaseline(stats.usage.todayTotalTokens, stats.usage.avgDailyTokens7d, 1.05, 1.35)
  const costPerRunColor = colorForLowerIsBetter(stats.efficiency.avgCostPerRun7d, 1.5, 3)
  const costPerSuccessColor = colorForLowerIsBetter(stats.efficiency.avgCostPerSuccess7d, 3, 6)
  const tokensPerRunColor = colorForLowerIsBetter(stats.efficiency.avgTokensPerRun7d, 8_000, 16_000)
  const tokensPerSuccessColor = colorForLowerIsBetter(stats.efficiency.avgTokensPerSuccess7d, 16_000, 32_000)
  const expiredLeaseColor = colorForPresence(stats.resources.expiredLeases, 1, 2)
  const expiringLeaseColor = colorForPresence(stats.resources.expiringLeases, 1, 3)
  const missingWorktreeColor = colorForPresence(stats.resources.missingWorktrees, 1, 2)
  const staleWorktreeColor = colorForPresence(stats.resources.staleWorktrees, 1, 2)
  const tailLatencyRatio = stats.timing.p50Minutes > 0 ? stats.timing.p90Minutes / stats.timing.p50Minutes : 1
  const tailLatencyColor = colorForLowerIsBetter(tailLatencyRatio, 2.5, 4.5)
  const usageFirst = stats.cost.model === 'subscription' || stats.cost.model === 'subscription-metered'

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text color={autoRefresh ? 'green' : 'yellow'}>{autoRefresh ? '● stats polling active' : '○ stats polling paused'}</Text>
        <Text dimColor>  interval {pollIntervalMs / 1000}s</Text>
        <Text dimColor>  last refresh {formatTime(lastRefreshAt)}</Text>
      </Box>

      <Box marginBottom={1}>
        <StatCard title="Run Health" width="50%" marginRight={1}>
          <Text>total {stats.overview.totalRuns}  active {stats.overview.activeRuns}</Text>
          <Text>running {stats.overview.runningRuns}  queued {stats.overview.queuedRuns}</Text>
          <Text>review_ready {stats.overview.reviewReadyRuns}  completed {stats.overview.completedRuns}</Text>
          <Text>
            blocked <Text color={overviewBlockedColor}>{stats.overview.blockedRuns}</Text>
            {'  '}
            error <Text color={overviewErrorColor}>{stats.overview.errorRuns}</Text>
          </Text>
          <Text dimColor>mix {formatStatusMix(stats.statusCounts)}</Text>
        </StatCard>

        <StatCard title="Throughput" width="50%">
          <Text>runs 24h {stats.throughput.runs24h}  7d {stats.throughput.runs7d}  30d {stats.throughput.runs30d}</Text>
          <Text>completed 7d {stats.throughput.completed7d}</Text>
          <Text>
            blocked 7d <Text color={throughputBlockedColor}>{stats.throughput.blocked7d}</Text>
            {'  '}
            error 7d <Text color={throughputErrorColor}>{stats.throughput.error7d}</Text>
          </Text>
          <Text>
            success 7d <Text color={successColor}>{stats.throughput.successRate7d.toFixed(1)}%</Text>
            {'  '}
            failure rate <Text color={failureRateColor}>{stats.reliability.failureRate7d.toFixed(1)}%</Text>
          </Text>
          <Text dimColor>avg duration {formatMinutes(stats.throughput.avgDurationMinutes7d)}  avg iter {stats.throughput.avgIterations7d.toFixed(2)}</Text>
          <Text dimColor>
            p50 {formatMinutes(stats.timing.p50Minutes)}
            {'  '}
            p90 <Text color={tailLatencyColor}>{formatMinutes(stats.timing.p90Minutes)}</Text>
            {'  '}
            p99 <Text color={tailLatencyColor}>{formatMinutes(stats.timing.p99Minutes)}</Text>
            {'  '}
            n {stats.timing.sampleSize30d}
          </Text>
        </StatCard>
      </Box>

      <Box marginBottom={1}>
        <StatCard title="Cost & Usage" width="50%" marginRight={1}>
          {usageFirst ? (
            <>
              <Text>model {stats.cost.model}</Text>
              <Text>
                today tokens <Text color={todayUsageColor}>{formatTokenCount(stats.usage.todayTotalTokens)}</Text> ({stats.cost.todayRunCount} runs)
              </Text>
              <Text>7d {formatTokenCount(stats.usage.tokens7d)}  30d {formatTokenCount(stats.usage.tokens30d)}</Text>
              <Text>avg/day 7d {formatTokenCount(stats.usage.avgDailyTokens7d)}</Text>
              <Text>
                tokens/run 7d <Text color={tokensPerRunColor}>{formatTokenCount(stats.efficiency.avgTokensPerRun7d)}</Text>
                {'  '}
                tokens/success <Text color={tokensPerSuccessColor}>{formatTokenCount(stats.efficiency.avgTokensPerSuccess7d)}</Text>
              </Text>
              <Text>tokens/iter {formatTokenCount(stats.efficiency.avgTokensPerIteration7d)}</Text>
              <Text dimColor>estimated cost today ${stats.cost.todayCostUsd.toFixed(2)}  7d ${stats.cost.cost7d.toFixed(2)}</Text>
              <Text>trend {buildSparkline(usageSeries)}</Text>
              {stats.usage.dailyHistory.slice(0, 4).map((row) => (
                <Text key={row.date} dimColor>
                  <Text color={colorForRatioToBaseline(row.totalTokens, stats.usage.avgDailyTokens7d, 1.05, 1.35)}>
                    {row.date}: {formatTokenCount(row.totalTokens)}
                  </Text>
                  {'  '}
                  ({row.runCount})
                </Text>
              ))}
            </>
          ) : (
            <>
              <Text>model pay-per-use</Text>
              <Text>
                today <Text color={todayCostColor}>${stats.cost.todayCostUsd.toFixed(2)}</Text> ({stats.cost.todayRunCount} runs)
              </Text>
              <Text>7d ${stats.cost.cost7d.toFixed(2)}  30d ${stats.cost.cost30d.toFixed(2)}</Text>
              <Text>avg/day 7d ${stats.cost.avgDailyCost7d.toFixed(2)}</Text>
              <Text>
                cost/run 7d <Text color={costPerRunColor}>${stats.efficiency.avgCostPerRun7d.toFixed(2)}</Text>
                {'  '}
                cost/success <Text color={costPerSuccessColor}>${stats.efficiency.avgCostPerSuccess7d.toFixed(2)}</Text>
              </Text>
              <Text>
                cost/iter <Text color={costPerRunColor}>${stats.efficiency.avgCostPerIteration7d.toFixed(2)}</Text>
                {'  '}
                completed/$ <Text color={successColor}>{stats.efficiency.completedPerDollar7d.toFixed(2)}</Text>
              </Text>
              <Text>
                tokens today <Text color={todayUsageColor}>{formatTokenCount(stats.usage.todayTotalTokens)}</Text>
                {'  '}
                tokens 7d {formatTokenCount(stats.usage.tokens7d)}
              </Text>
              <Text>trend {buildSparkline(costSeries)}</Text>
              {stats.cost.dailyHistory.slice(0, 4).map((row) => (
                <Text key={row.date} dimColor>
                  <Text color={colorForRatioToBaseline(row.totalCostUsd, stats.cost.avgDailyCost7d, 1.05, 1.35)}>
                    {row.date}: ${row.totalCostUsd.toFixed(2)}
                  </Text>
                  {'  '}
                  ({row.runCount})
                </Text>
              ))}
            </>
          )}
        </StatCard>

        <StatCard title="Agent Activity" width="50%">
          <Text>events total {stats.agents.eventsTotal}</Text>
          <Text>24h {stats.agents.events24h}  7d {stats.agents.events7d}</Text>
          <Text>tool calls 24h {stats.agents.toolCalls24h}</Text>
          <Text>thinking 24h {stats.agents.thinking24h}  runs 7d {stats.agents.uniqueRuns7d}</Text>
          <Text dimColor>
            roles {stats.agents.roleBreakdown7d.length === 0 ? '-' : stats.agents.roleBreakdown7d.map((row) => `${row.role}:${row.events}`).join('  ')}
          </Text>
        </StatCard>
      </Box>

      <Box marginBottom={1}>
        <StatCard title="Reliability" width="50%" marginRight={1}>
          <Text>
            failures 7d <Text color={failureRateColor}>{stats.reliability.failureCount7d}</Text>
            {'  '}
            rate <Text color={failureRateColor}>{stats.reliability.failureRate7d.toFixed(1)}%</Text>
          </Text>
          <Text>
            tail p90/p50 <Text color={tailLatencyColor}>{tailLatencyRatio.toFixed(2)}x</Text>
            {'  '}
            median {formatMinutes(stats.timing.p50Minutes)}
          </Text>
          <Text dimColor>patterns (7d)</Text>
          {stats.reliability.topErrorPatterns7d.length === 0 && <Text color="gray">none in the last 7 days</Text>}
          {stats.reliability.topErrorPatterns7d.map((row) => (
            <Text key={`${row.pattern}-${row.count}`}>
              <Text color={colorForPresence(row.count, 2, 4)}>{String(row.count).padStart(2, ' ')}x</Text>
              {'  '}
              <Text>{truncate(row.pattern, 64)}</Text>
            </Text>
          ))}
        </StatCard>

        <StatCard title="Resources" width="50%">
          <Text>
            leases active <Text color="green">{stats.resources.activeLeases}</Text>
            {'  '}
            repos {stats.resources.leasedRepos}
          </Text>
          <Text>
            expiring <Text color={expiringLeaseColor}>{stats.resources.expiringLeases}</Text>
            {'  '}
            expired <Text color={expiredLeaseColor}>{stats.resources.expiredLeases}</Text>
          </Text>
          <Text>
            worktrees active <Text color="cyan">{stats.resources.activeWorktrees}</Text>
            {'  '}
            missing <Text color={missingWorktreeColor}>{stats.resources.missingWorktrees}</Text>
          </Text>
          <Text>
            stale completed worktrees <Text color={staleWorktreeColor}>{stats.resources.staleWorktrees}</Text>
          </Text>
          <Text dimColor>lease horizon marks leases expiring in ≤30m</Text>
        </StatCard>
      </Box>

      <Box>
        <StatCard title="Merge Queue" width="35%" marginRight={1}>
          <Text>active batches {stats.queue.activeBatches}</Text>
          <Text>
            statuses {stats.queue.statuses.length === 0 ? '-' : stats.queue.statuses.map((row) => `${row.status}:${row.count}`).join('  ')}
          </Text>
          <Text>
            active phases {stats.phaseCounts.length === 0 ? '-' : stats.phaseCounts.map((row) => `${row.phase}:${row.count}`).join('  ')}
          </Text>
        </StatCard>

        <StatCard title="Top Repositories (30d)" width="65%">
          {stats.topRepos30d.length === 0 && <Text color="gray">No run history</Text>}
          {stats.topRepos30d.map((row) => {
            const terminalCount = row.completedRuns + row.blockedRuns + row.errorRuns
            const successPct = terminalCount > 0 ? (row.completedRuns / terminalCount) * 100 : 0
            const repoSuccessColor = colorForHigherIsBetter(successPct, 80, 60)
            return (
              <Text key={row.repo}>
                <Text>{truncate(row.repo, 28)}</Text>
                {'  '}
                <Text>runs {row.totalRuns}</Text>
                {'  '}
                <Text color={repoSuccessColor}>ok {successPct.toFixed(0)}%</Text>
                {'  '}
                <Text>cost ${row.totalCostUsd.toFixed(2)}</Text>
                {'  '}
                <Text dimColor>iter {row.avgIterations.toFixed(1)}</Text>
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

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}
