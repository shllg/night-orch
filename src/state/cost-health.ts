import type Database from 'better-sqlite3'

export interface CostHealthReport {
  reportedCli: number
  measuredApi: number
  estimatedDuration: number
  fallbackZero: number
  totalEntries: number
  last24h: {
    reportedCli: number
    measuredApi: number
    estimatedDuration: number
    fallbackZero: number
    totalEntries: number
    fallbackRate: number
  }
}

/**
 * Cost-health report used by `/api/cost/health`.
 *
 * Returns per-source counts from the `run_cost_entries` ledger plus the 24h
 * fallback rate.
 */
export function loadCostHealthReport(db: Database.Database): CostHealthReport {
  const allTimeRows = db
    .prepare(
      `SELECT token_source, COUNT(*) AS count
       FROM run_cost_entries
       GROUP BY token_source`,
    )
    .all() as Array<{ token_source: string; count: number }>

  const last24hRows = db
    .prepare(
      `SELECT token_source, COUNT(*) AS count
       FROM run_cost_entries
       WHERE datetime(created_at) >= datetime('now', '-1 day')
       GROUP BY token_source`,
    )
    .all() as Array<{ token_source: string; count: number }>

  const emptyBreakdown = () => ({
    reportedCli: 0,
    measuredApi: 0,
    estimatedDuration: 0,
    fallbackZero: 0,
    totalEntries: 0,
  })

  const applyRows = (
    rows: Array<{ token_source: string; count: number }>,
    target: ReturnType<typeof emptyBreakdown>,
  ) => {
    for (const row of rows) {
      target.totalEntries += row.count
      switch (row.token_source) {
        case 'reported_cli':
          target.reportedCli += row.count
          break
        case 'measured_api':
          target.measuredApi += row.count
          break
        case 'estimated_duration':
          target.estimatedDuration += row.count
          break
        case 'fallback_zero':
          target.fallbackZero += row.count
          break
        // Unknown tags are still counted toward totalEntries so operators
        // can see unexpected rows in the ledger.
      }
    }
  }

  const allTime = emptyBreakdown()
  applyRows(allTimeRows, allTime)

  const last24h = { ...emptyBreakdown(), fallbackRate: 0 }
  applyRows(last24hRows, last24h)
  const degraded24h = last24h.estimatedDuration + last24h.fallbackZero
  last24h.fallbackRate = last24h.totalEntries > 0 ? degraded24h / last24h.totalEntries : 0

  return { ...allTime, last24h }
}
