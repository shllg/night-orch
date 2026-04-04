import { type ReactElement, type ReactNode } from 'react'

import { formatMoney, formatTimestamp, truncate } from '../lib/format.js'
import { type DashboardSnapshot, type StatusAggregate } from '../types/dashboard.js'
import { DashboardMetrics } from './DashboardMetrics.js'

interface StatsPageProps {
  snapshot: DashboardSnapshot | null
  socketConnected: boolean
}

type Tone = 'success' | 'warning' | 'error' | 'neutral'

export function StatsPage({ snapshot, socketConnected }: StatsPageProps): ReactElement {
  if (!snapshot) {
    return (
      <div className="flex flex-col gap-5">
        <DashboardMetrics snapshot={snapshot} />
        <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-6">
            <h2 className="card-title text-lg">Stats</h2>
            <p className="text-sm text-base-content/75">Stats snapshot is loading.</p>
            <div className="mt-2 space-y-2">
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-16 w-full" />
            </div>
          </div>
        </section>
      </div>
    )
  }

  const { stats } = snapshot

  const successTone = toneForHigherIsBetter(stats.throughput.successRate7d, 80, 60)
  const failureRateTone = toneForLowerIsBetter(stats.reliability.failureRate7d, 10, 25)
  const blockedOverviewTone = toneForPresence(stats.overview.blockedRuns, 1, 2)
  const errorOverviewTone = toneForPresence(stats.overview.errorRuns, 1, 2)
  const blockedThroughputTone = toneForPresence(stats.throughput.blocked7d, 1, 2)
  const errorThroughputTone = toneForPresence(stats.throughput.error7d, 1, 2)
  const todayCostTone = toneForRatioToBaseline(stats.cost.todayCostUsd, stats.cost.avgDailyCost7d, 1.05, 1.35)
  const costPerRunTone = toneForLowerIsBetter(stats.efficiency.avgCostPerRun7d, 1.5, 3)
  const costPerSuccessTone = toneForLowerIsBetter(stats.efficiency.avgCostPerSuccess7d, 3, 6)
  const expiringLeaseTone = toneForPresence(stats.resources.expiringLeases, 1, 3)
  const expiredLeaseTone = toneForPresence(stats.resources.expiredLeases, 1, 2)
  const missingWorktreeTone = toneForPresence(stats.resources.missingWorktrees, 1, 2)
  const staleWorktreeTone = toneForPresence(stats.resources.staleWorktrees, 1, 2)

  const hasLatencySample = stats.timing.sampleSize30d > 0 && stats.timing.p50Minutes > 0
  const tailLatencyRatio = hasLatencySample ? stats.timing.p90Minutes / stats.timing.p50Minutes : 0
  const tailLatencyTone = toneForLowerIsBetter(tailLatencyRatio, 2.5, 4.5)

  const costTrend = buildAsciiSparkline(stats.cost.dailyHistory.slice().reverse().map((row) => row.totalCostUsd))

  return (
    <div className="flex flex-col gap-5">
      <DashboardMetrics snapshot={snapshot} />

      <section className="grid gap-5 xl:grid-cols-2">
        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">System Signals</h2>
            <div className="mt-2 space-y-2 text-sm">
              <SignalRow label="Stats Updated" value={formatTimestamp(stats.updatedAt)} />
              <SignalRow label="Dashboard Generated" value={formatTimestamp(snapshot.generatedAt)} />
              <SignalRow label="Poll Interval" value={`${snapshot.config.pollIntervalSeconds}s`} />
              <SignalRow label="Tracked Repositories" value={snapshot.config.repos.length} />
              <SignalRow label="Websocket" value={socketConnected ? 'Connected' : 'Reconnecting'} />
            </div>
          </div>
        </article>

        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">Run Health</h2>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <OverviewStat label="Total Runs" value={stats.overview.totalRuns} />
              <OverviewStat label="Active Runs" value={stats.overview.activeRuns} />
              <OverviewStat label="Running Runs" value={stats.overview.runningRuns} />
              <OverviewStat label="Queued Runs" value={stats.overview.queuedRuns} />
              <OverviewStat label="Review Ready" value={stats.overview.reviewReadyRuns} />
              <OverviewStat label="Completed Runs" value={stats.overview.completedRuns} />
              <OverviewStat
                label="Blocked Runs"
                value={stats.overview.blockedRuns}
                toneClass={toTextClass(blockedOverviewTone)}
              />
              <OverviewStat
                label="Error Runs"
                value={stats.overview.errorRuns}
                toneClass={toTextClass(errorOverviewTone)}
              />
            </div>
            <p className="mt-3 text-xs text-base-content/65">Status mix {formatStatusMix(stats.statusCounts)}</p>
          </div>
        </article>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">Throughput</h2>
            <div className="mt-2 space-y-2 text-sm">
              <SignalRow
                label="Runs (24h / 7d / 30d)"
                value={`${stats.throughput.runs24h} / ${stats.throughput.runs7d} / ${stats.throughput.runs30d}`}
              />
              <SignalRow label="Completed (7d)" value={stats.throughput.completed7d} />
              <SignalRow
                label="Blocked (7d)"
                value={stats.throughput.blocked7d}
                valueClassName={toTextClass(blockedThroughputTone)}
              />
              <SignalRow
                label="Errors (7d)"
                value={stats.throughput.error7d}
                valueClassName={toTextClass(errorThroughputTone)}
              />
              <SignalRow
                label="Success Rate (7d)"
                value={`${stats.throughput.successRate7d.toFixed(1)}%`}
                valueClassName={toTextClass(successTone)}
              />
              <SignalRow
                label="Failure Rate (7d)"
                value={`${stats.reliability.failureRate7d.toFixed(1)}%`}
                valueClassName={toTextClass(failureRateTone)}
              />
              <SignalRow label="Average Duration (7d)" value={formatMinutes(stats.throughput.avgDurationMinutes7d)} />
              <SignalRow label="Average Iterations (7d)" value={stats.throughput.avgIterations7d.toFixed(2)} />
              <SignalRow
                label="Latency (p50 / p90 / p99)"
                value={`${formatMinutes(stats.timing.p50Minutes)} / ${formatMinutes(stats.timing.p90Minutes)} / ${formatMinutes(stats.timing.p99Minutes)}`}
              />
              <SignalRow
                label="Tail Ratio (p90 / p50)"
                value={hasLatencySample ? `${tailLatencyRatio.toFixed(2)}x` : '-'}
                valueClassName={toTextClass(tailLatencyTone)}
              />
              <SignalRow label="Timing Sample Size (30d)" value={stats.timing.sampleSize30d} />
            </div>
          </div>
        </article>

        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">Cost</h2>
            <div className="mt-2 space-y-2 text-sm">
              <SignalRow
                label="Today"
                value={`$${formatMoney(stats.cost.todayCostUsd)} (${stats.cost.todayRunCount} runs)`}
                valueClassName={toTextClass(todayCostTone)}
              />
              <SignalRow label="Cost (7d)" value={`$${formatMoney(stats.cost.cost7d)}`} />
              <SignalRow label="Cost (30d)" value={`$${formatMoney(stats.cost.cost30d)}`} />
              <SignalRow label="Average Daily Cost (7d)" value={`$${formatMoney(stats.cost.avgDailyCost7d)}`} />
              <SignalRow label="Total Cost (7d)" value={`$${formatMoney(stats.efficiency.totalCostUsd7d)}`} />
              <SignalRow
                label="Cost Per Run (7d)"
                value={`$${formatMoney(stats.efficiency.avgCostPerRun7d)}`}
                valueClassName={toTextClass(costPerRunTone)}
              />
              <SignalRow
                label="Cost Per Success (7d)"
                value={`$${formatMoney(stats.efficiency.avgCostPerSuccess7d)}`}
                valueClassName={toTextClass(costPerSuccessTone)}
              />
              <SignalRow label="Cost Per Iteration (7d)" value={`$${formatMoney(stats.efficiency.avgCostPerIteration7d)}`} />
              <SignalRow label="Completed Per Dollar (7d)" value={stats.efficiency.completedPerDollar7d.toFixed(2)} />
              <SignalRow label="Cost Trend (7d)" value={costTrend} />
            </div>
            <div className="mt-3 space-y-1">
              {stats.cost.dailyHistory.length === 0 && (
                <p className="text-xs text-base-content/60">No daily cost rows in the last 7 days.</p>
              )}
              {stats.cost.dailyHistory.map((row) => (
                <p key={row.date} className="text-xs text-base-content/70">
                  {row.date} ${formatMoney(row.totalCostUsd)} ({row.runCount})
                </p>
              ))}
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">Agent Activity</h2>
            <div className="mt-2 space-y-2 text-sm">
              <SignalRow label="Events Total" value={stats.agents.eventsTotal} />
              <SignalRow label="Events (24h)" value={stats.agents.events24h} />
              <SignalRow label="Events (7d)" value={stats.agents.events7d} />
              <SignalRow label="Tool Calls (24h)" value={stats.agents.toolCalls24h} />
              <SignalRow label="Thinking Events (24h)" value={stats.agents.thinking24h} />
              <SignalRow label="Unique Runs (7d)" value={stats.agents.uniqueRuns7d} />
            </div>
            <div className="mt-3 space-y-1">
              <p className="text-xs uppercase tracking-wide text-base-content/60">Role breakdown (7d)</p>
              {stats.agents.roleBreakdown7d.length === 0 && (
                <p className="text-xs text-base-content/60">No agent activity in the last 7 days.</p>
              )}
              {stats.agents.roleBreakdown7d.map((row) => (
                <p key={row.role} className="text-xs text-base-content/80">
                  {row.role}: {row.events} events, {row.toolCalls} tool calls
                </p>
              ))}
            </div>
          </div>
        </article>

        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">Reliability</h2>
            <div className="mt-2 space-y-2 text-sm">
              <SignalRow
                label="Failures (7d)"
                value={stats.reliability.failureCount7d}
                valueClassName={toTextClass(failureRateTone)}
              />
              <SignalRow
                label="Failure Rate (7d)"
                value={`${stats.reliability.failureRate7d.toFixed(1)}%`}
                valueClassName={toTextClass(failureRateTone)}
              />
              <SignalRow label="Median Duration" value={formatMinutes(stats.timing.p50Minutes)} />
              <SignalRow
                label="Tail Latency (p90 / p50)"
                value={hasLatencySample ? `${tailLatencyRatio.toFixed(2)}x` : '-'}
                valueClassName={toTextClass(tailLatencyTone)}
              />
            </div>
            <div className="mt-3 space-y-1">
              <p className="text-xs uppercase tracking-wide text-base-content/60">Top error patterns (7d)</p>
              {stats.reliability.topErrorPatterns7d.length === 0 && (
                <p className="text-xs text-base-content/60">None in the last 7 days.</p>
              )}
              {stats.reliability.topErrorPatterns7d.map((row) => (
                <p key={`${row.pattern}-${row.count}`} className="text-xs text-base-content/80">
                  <span className={toTextClass(toneForPresence(row.count, 2, 4))}>{row.count}x</span>
                  {' '}
                  {truncate(row.pattern, 120)}
                </p>
              ))}
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">Resources</h2>
            <div className="mt-2 space-y-2 text-sm">
              <SignalRow label="Active Leases" value={stats.resources.activeLeases} />
              <SignalRow label="Leased Repositories" value={stats.resources.leasedRepos} />
              <SignalRow
                label="Expiring Leases"
                value={stats.resources.expiringLeases}
                valueClassName={toTextClass(expiringLeaseTone)}
              />
              <SignalRow
                label="Expired Leases"
                value={stats.resources.expiredLeases}
                valueClassName={toTextClass(expiredLeaseTone)}
              />
              <SignalRow label="Active Worktrees" value={stats.resources.activeWorktrees} />
              <SignalRow
                label="Missing Worktrees"
                value={stats.resources.missingWorktrees}
                valueClassName={toTextClass(missingWorktreeTone)}
              />
              <SignalRow
                label="Stale Completed Worktrees"
                value={stats.resources.staleWorktrees}
                valueClassName={toTextClass(staleWorktreeTone)}
              />
            </div>
          </div>
        </article>

        <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <h2 className="card-title text-lg">Merge Queue</h2>
            <div className="mt-2 space-y-2 text-sm">
              <SignalRow label="Active Batches" value={stats.queue.activeBatches} />
              <SignalRow label="Batch Statuses" value={formatStatusMix(stats.queue.statuses)} />
              <SignalRow
                label="Active Phases"
                value={stats.phaseCounts.length > 0 ? stats.phaseCounts.map((row) => `${row.phase}:${row.count}`).join(' | ') : '-'}
              />
            </div>
          </div>
        </article>
      </section>

      <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-4 sm:p-5">
          <h2 className="card-title text-lg">Top Repositories (30d)</h2>
          {stats.topRepos30d.length === 0 ? (
            <p className="mt-2 text-sm text-base-content/70">No repository run history in the last 30 days.</p>
          ) : (
            <div className="mt-3 grid gap-2">
              {stats.topRepos30d.map((row) => {
                const terminalCount = row.completedRuns + row.blockedRuns + row.errorRuns
                const successPct = terminalCount > 0 ? (row.completedRuns / terminalCount) * 100 : 0
                const successToneClass = toTextClass(toneForHigherIsBetter(successPct, 80, 60))

                return (
                  <div
                    key={row.repo}
                    className="rounded-box border border-base-300/70 bg-base-100/70 px-3 py-2 text-sm"
                  >
                    <p className="font-semibold text-base-content">{truncate(row.repo, 96)}</p>
                    <p className="mt-1 text-xs text-base-content/80">
                      runs {row.totalRuns} | completed {row.completedRuns} | blocked {row.blockedRuns} | error {row.errorRuns}
                    </p>
                    <p className="mt-1 text-xs text-base-content/80">
                      success <span className={successToneClass}>{successPct.toFixed(0)}%</span>
                      {' | '}
                      cost ${formatMoney(row.totalCostUsd)}
                      {' | '}
                      avg iterations {row.avgIterations.toFixed(1)}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

interface OverviewStatProps {
  label: string
  value: number
  toneClass?: string
}

function OverviewStat({ label, value, toneClass }: OverviewStatProps): ReactElement {
  return (
    <div className="rounded-box border border-base-300/70 bg-base-100/70 px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-base-content/60">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass ?? 'text-base-content'}`}>{value}</p>
    </div>
  )
}

interface SignalRowProps {
  label: string
  value: ReactNode
  valueClassName?: string
}

function SignalRow({ label, value, valueClassName }: SignalRowProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 rounded-box border border-base-300/70 bg-base-100/70 px-3 py-2">
      <span className="text-base-content/70">{label}</span>
      <span className={`text-right font-medium ${valueClassName ?? 'text-base-content'}`}>{value}</span>
    </div>
  )
}

function formatStatusMix(statuses: StatusAggregate[]): string {
  if (statuses.length === 0) return '-'
  return statuses.map((row) => `${row.status}:${row.count}`).join(' | ')
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '-'
  if (minutes < 1) return `${Math.round(minutes * 60)}s`
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  const hours = Math.floor(minutes / 60)
  const mins = Math.round(minutes % 60)
  return `${hours}h${String(mins).padStart(2, '0')}m`
}

function toneForHigherIsBetter(value: number, greenAt: number, yellowAt: number): Tone {
  if (value >= greenAt) return 'success'
  if (value >= yellowAt) return 'warning'
  return 'error'
}

function toneForLowerIsBetter(value: number, greenAt: number, yellowAt: number): Tone {
  if (value <= greenAt) return 'success'
  if (value <= yellowAt) return 'warning'
  return 'error'
}

function toneForPresence(value: number, yellowAt = 1, redAt = 3): Tone {
  if (value < yellowAt) return 'success'
  if (value < redAt) return 'warning'
  return 'error'
}

function toneForRatioToBaseline(
  value: number,
  baseline: number,
  greenAtRatio: number,
  yellowAtRatio: number,
): Tone {
  if (baseline <= 0) {
    return value <= 0 ? 'success' : 'warning'
  }
  const ratio = value / baseline
  if (ratio <= greenAtRatio) return 'success'
  if (ratio <= yellowAtRatio) return 'warning'
  return 'error'
}

function toTextClass(tone: Tone): string {
  switch (tone) {
    case 'success':
      return 'text-success'
    case 'warning':
      return 'text-warning'
    case 'error':
      return 'text-error'
    default:
      return 'text-base-content'
  }
}

function buildAsciiSparkline(values: number[]): string {
  if (values.length === 0) return '-'
  const max = Math.max(...values, 0)
  if (max <= 0) return '.'.repeat(values.length)

  const bars = '.:-=+*#%@'
  return values
    .map((value) => {
      const ratio = Math.max(0, Math.min(1, value / max))
      const index = Math.round(ratio * (bars.length - 1))
      return bars[index] ?? '.'
    })
    .join('')
}
