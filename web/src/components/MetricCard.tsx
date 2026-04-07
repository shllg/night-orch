import { type ReactElement } from 'react'

interface MetricCardProps {
  label: string
  value: number | string
  accent: 'cyan' | 'amber' | 'emerald' | 'sky'
  subValue?: string
  compactOnMobile?: boolean
}

export function MetricCard({
  label,
  value,
  accent,
  subValue,
  compactOnMobile = false,
}: MetricCardProps): ReactElement {
  const accentClass = accent === 'amber'
    ? 'border-warning/50 bg-warning/10'
    : accent === 'emerald'
      ? 'border-success/50 bg-success/10'
      : accent === 'sky'
        ? 'border-accent/50 bg-accent/10'
        : 'border-info/50 bg-info/10'
  const containerClass = compactOnMobile
    ? 'gap-0.5 px-2 py-1.5 sm:gap-1 sm:px-3 sm:py-2'
    : 'gap-1 px-3 py-2'
  const titleClass = compactOnMobile
    ? 'stat-title text-[9px] uppercase tracking-[0.12em] text-base-content/70 sm:text-[10px]'
    : 'stat-title text-[10px] uppercase tracking-[0.12em] text-base-content/70'
  const valueClass = compactOnMobile
    ? 'stat-value text-base leading-tight text-base-content sm:text-xl'
    : 'stat-value text-xl leading-tight text-base-content'
  const subValueClass = compactOnMobile
    ? 'stat-desc hidden text-[10px] text-base-content/70 sm:block'
    : 'stat-desc text-[10px] text-base-content/70'

  return (
    <article className={`stat min-h-0 rounded-box border shadow-panel ${containerClass} ${accentClass}`}>
      <div className={titleClass}>{label}</div>
      <div className={valueClass}>{value}</div>
      {subValue && <div className={subValueClass}>{subValue}</div>}
    </article>
  )
}
