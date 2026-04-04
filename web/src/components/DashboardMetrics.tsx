import { type ReactElement } from 'react'

import { formatMoney } from '../lib/format.js'
import { type DashboardSnapshot } from '../types/dashboard.js'
import { MetricCard } from './MetricCard.js'

interface DashboardMetricsProps {
  snapshot: DashboardSnapshot | null
}

export function DashboardMetrics({ snapshot }: DashboardMetricsProps): ReactElement {
  const usageFirst = snapshot?.stats.cost.model === 'subscription'

  return (
    <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Active" value={snapshot?.status.activeRuns ?? 0} accent="cyan" />
      <MetricCard label="Running" value={snapshot?.stats.overview.runningRuns ?? 0} accent="amber" />
      <MetricCard
        label={usageFirst ? 'Daily Usage' : 'Daily Cost'}
        value={usageFirst ? formatTokenCount(snapshot?.stats.usage.todayTotalTokens ?? 0) : `$${formatMoney(snapshot?.status.dailyCostUsd ?? 0)}`}
        accent="emerald"
        subValue={usageFirst
          ? `Est. $${formatMoney(snapshot?.status.dailyCostUsd ?? 0)} today`
          : `Budget $${formatMoney(snapshot?.cost.dailyBudgetUsd ?? 0)}`}
      />
      <MetricCard
        label="24h Throughput"
        value={snapshot?.stats.throughput.runs24h ?? 0}
        accent="sky"
        subValue={`${(snapshot?.stats.throughput.successRate7d ?? 0).toFixed(1)}% success (7d)`}
      />
    </section>
  )
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}
