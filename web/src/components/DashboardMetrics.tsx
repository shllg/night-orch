import { type ReactElement } from 'react'

import { formatMoney } from '../lib/format.js'
import { type DashboardSnapshot } from '../types/dashboard.js'
import { MetricCard } from './MetricCard.js'

interface DashboardMetricsProps {
  snapshot: DashboardSnapshot | null
}

export function DashboardMetrics({ snapshot }: DashboardMetricsProps): ReactElement {
  const usageFirst = snapshot?.stats.cost.model === 'subscription'
  const dailyOverride = snapshot?.cost.dailyBudgetOverrideUsd ?? null
  const effectiveBudget = snapshot?.cost.effectiveDailyBudgetUsd ?? snapshot?.cost.dailyBudgetUsd ?? 0
  const dailyCost = snapshot?.status.dailyCostUsd ?? 0
  const dailyTheoretical = snapshot?.status.dailyTheoreticalCostUsd ?? dailyCost
  const budgetHeadroom = effectiveBudget - dailyCost
  const budgetLabel = dailyOverride !== null
    ? `Budget $${formatMoney(effectiveBudget)} (override)`
    : `Budget $${formatMoney(snapshot?.cost.dailyBudgetUsd ?? 0)}`

  return (
    <section className="grid grid-cols-2 gap-1.5 sm:gap-2 xl:grid-cols-4">
      <MetricCard
        label={usageFirst ? 'Daily Usage' : 'Daily Cost'}
        value={usageFirst ? formatTokenCount(snapshot?.stats.usage.todayTotalTokens ?? 0) : `$${formatMoney(dailyCost)}`}
        accent="emerald"
        compactOnMobile
        subValue={usageFirst
          ? `$${formatMoney(dailyCost)} real / $${formatMoney(dailyTheoretical)} metered`
          : `${budgetLabel} · metered $${formatMoney(dailyTheoretical)}`}
      />
      <MetricCard
        label="Budget Headroom"
        value={formatSignedUsd(budgetHeadroom)}
        accent={budgetHeadroom >= 0 ? 'cyan' : 'amber'}
        compactOnMobile
        subValue={`Daily cap $${formatMoney(effectiveBudget)}`}
      />
      <MetricCard
        label="24h Throughput"
        value={snapshot?.stats.throughput.runs24h ?? 0}
        accent="cyan"
        compactOnMobile
        subValue={`${(snapshot?.stats.throughput.successRate7d ?? 0).toFixed(1)}% success (7d)`}
      />
      <MetricCard
        label="Review Ready"
        value={snapshot?.stats.overview.reviewReadyRuns ?? 0}
        accent="sky"
        compactOnMobile
        subValue={`${snapshot?.stats.overview.completedRuns ?? 0} completed`}
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

function formatSignedUsd(value: number): string {
  const magnitude = `$${formatMoney(Math.abs(value))}`
  return value >= 0 ? `+${magnitude}` : `-${magnitude}`
}
