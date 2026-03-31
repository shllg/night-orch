export interface WindowedSlice<T> {
  start: number
  rows: T[]
}

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
