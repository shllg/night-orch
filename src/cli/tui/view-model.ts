export interface WindowedSlice<T> {
  start: number
  rows: T[]
}

export interface PartitionedRows<T> {
  active: T[]
  recent: T[]
}

export type MetricColor = 'white' | 'gray' | 'green' | 'yellow' | 'red' | 'cyan' | 'magenta'

export function sliceWindow<T>(rows: T[], selectedIndex: number, windowSize: number): WindowedSlice<T> {
  if (rows.length === 0) return { start: 0, rows: [] }
  const safeWindow = Math.max(1, windowSize)
  const safeIndex = Math.max(0, Math.min(rows.length - 1, selectedIndex))
  const half = Math.floor(safeWindow / 2)
  const maxStart = Math.max(0, rows.length - safeWindow)
  const start = Math.min(maxStart, Math.max(0, safeIndex - half))
  return {
    start,
    rows: rows.slice(start, start + safeWindow),
  }
}

export function isActiveRunStatus(status: string): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'blocked' ||
    status === 'review_ready' ||
    status === 'error'
  )
}

export function partitionRowsByActivity<T extends { status: string }>(rows: T[]): PartitionedRows<T> {
  const active: T[] = []
  const recent: T[] = []

  for (const row of rows) {
    if (isActiveRunStatus(row.status)) {
      active.push(row)
      continue
    }
    recent.push(row)
  }

  return { active, recent }
}

export function buildSparkline(values: number[]): string {
  if (values.length === 0) return '-'
  const max = Math.max(...values, 0)
  if (max <= 0) return '▁'.repeat(values.length)
  const bars = '▁▂▃▄▅▆▇█'
  return values
    .map((value) => {
      const ratio = Math.max(0, Math.min(1, value / max))
      const index = Math.round(ratio * (bars.length - 1))
      return bars[index] ?? '▁'
    })
    .join('')
}

export function colorForHigherIsBetter(value: number, greenAt: number, yellowAt: number): MetricColor {
  if (value >= greenAt) return 'green'
  if (value >= yellowAt) return 'yellow'
  return 'red'
}

export function colorForLowerIsBetter(value: number, greenAt: number, yellowAt: number): MetricColor {
  if (value <= greenAt) return 'green'
  if (value <= yellowAt) return 'yellow'
  return 'red'
}

export function colorForPresence(value: number, yellowAt = 1, redAt = 3): MetricColor {
  if (value < yellowAt) return 'green'
  if (value < redAt) return 'yellow'
  return 'red'
}

export function colorForRatioToBaseline(
  value: number,
  baseline: number,
  greenAtRatio: number,
  yellowAtRatio: number,
): MetricColor {
  if (baseline <= 0) {
    return value <= 0 ? 'green' : 'yellow'
  }
  const ratio = value / baseline
  if (ratio <= greenAtRatio) return 'green'
  if (ratio <= yellowAtRatio) return 'yellow'
  return 'red'
}
