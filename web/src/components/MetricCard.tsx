import { type ReactElement } from 'react'

interface MetricCardProps {
  label: string
  value: number | string
  accent: 'cyan' | 'amber' | 'emerald' | 'sky'
  subValue?: string
}

export function MetricCard({ label, value, accent, subValue }: MetricCardProps): ReactElement {
  const accentClass = accent === 'amber'
    ? 'border-warning/50 bg-warning/10'
    : accent === 'emerald'
      ? 'border-success/50 bg-success/10'
      : accent === 'sky'
        ? 'border-accent/50 bg-accent/10'
        : 'border-info/50 bg-info/10'

  return (
    <article className={`stat rounded-box border px-4 py-3 shadow-panel ${accentClass}`}>
      <div className="stat-title text-[11px] uppercase tracking-wider text-base-content/70">{label}</div>
      <div className="stat-value text-2xl text-base-content">{value}</div>
      {subValue && <div className="stat-desc text-[11px] text-base-content/70">{subValue}</div>}
    </article>
  )
}
