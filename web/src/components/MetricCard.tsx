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
    <article className={`stat min-h-0 gap-1 rounded-box border px-3 py-2 shadow-panel ${accentClass}`}>
      <div className="stat-title text-[10px] uppercase tracking-[0.12em] text-base-content/70">{label}</div>
      <div className="stat-value text-xl leading-tight text-base-content">{value}</div>
      {subValue && <div className="stat-desc text-[10px] text-base-content/70">{subValue}</div>}
    </article>
  )
}
