import { type ReactElement } from 'react'

import { formatMoney } from '../lib/format.js'
import { type DashboardSnapshot } from '../types/dashboard.js'
import { MetricCard } from './MetricCard.js'

interface DashboardMetricsProps {
  snapshot: DashboardSnapshot | null
}

export function DashboardMetrics({ snapshot }: DashboardMetricsProps): ReactElement {
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Active" value={snapshot?.status.activeRuns ?? 0} accent="cyan" />
      <MetricCard label="Running" value={snapshot?.stats.overview.runningRuns ?? 0} accent="amber" />
      <MetricCard
        label="Daily Cost"
        value={`$${formatMoney(snapshot?.status.dailyCostUsd ?? 0)}`}
        accent="emerald"
        subValue={`Budget $${formatMoney(snapshot?.cost.dailyBudgetUsd ?? 0)}`}
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
