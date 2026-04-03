import type Database from 'better-sqlite3'
import { nowUtcIso, parseUtcTimestampMs } from '../utils/time.js'

export interface SummaryOptions {
  since: Date
  repo?: string
}

export interface SummaryResult {
  period: { from: string; to: string }
  runs: { started: number; completed: number; blocked: number; errored: number }
  prsCreated: number
  totalCostUsd: number
  currentBlocked: Array<{ repo: string; issueNumber: number; blockReason: string | null }>
  currentRunning: Array<{ repo: string; issueNumber: number; phase: string | null }>
}

/**
 * Parse common time-range arguments like "24h", "7d", "1w", "30d" or ISO dates.
 */
export function parseSinceArg(value: string): Date {
  const match = /^(\d+)([hdwm])$/i.exec(value.trim())
  if (match) {
    const amount = parseInt(match[1]!, 10)
    const unit = match[2]!.toLowerCase()
    const ms = {
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      m: 30 * 24 * 60 * 60 * 1000,
    }[unit]
    if (ms) return new Date(Date.now() - amount * ms)
  }
  const parsed = parseUtcTimestampMs(value)
  if (Number.isFinite(parsed)) return new Date(parsed)
  throw new Error(`Cannot parse time range: ${value}. Use "24h", "7d", "1w", "30d", or an ISO date.`)
}

interface RunCountRow { status: string; count: number }
interface CostRow { total: number }
interface BlockedRow { repo: string; issue_number: number; block_reason: string | null }
interface RunningRow { repo: string; issue_number: number; current_phase: string | null }
interface PRRow { count: number }

/**
 * Generate a "since you were away" summary of what happened.
 */
export class SummaryEngine {
  constructor(private db: Database.Database) {}

  summarize(options: SummaryOptions): SummaryResult {
    const sinceStr = options.since.toISOString()
    const nowStr = nowUtcIso()

    const repoFilter = options.repo ? ' AND repo = ?' : ''
    const repoParams = options.repo ? [options.repo] : []

    const counts = this.db
      .prepare(`SELECT status, COUNT(*) as count FROM runs WHERE created_at >= ?${repoFilter} GROUP BY status`)
      .all(sinceStr, ...repoParams) as RunCountRow[]

    const runCounts = { started: 0, completed: 0, blocked: 0, errored: 0 }
    for (const row of counts) {
      switch (row.status) {
        case 'completed': runCounts.completed += row.count; break
        case 'blocked': runCounts.blocked += row.count; break
        case 'error': runCounts.errored += row.count; break
      }
      runCounts.started += row.count
    }

    const costRow = this.db
      .prepare(`SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM runs WHERE created_at >= ?${repoFilter}`)
      .get(sinceStr, ...repoParams) as CostRow
    const totalCostUsd = Math.round(costRow.total * 100) / 100

    const prRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM runs WHERE pr_number IS NOT NULL AND created_at >= ?${repoFilter}`)
      .get(sinceStr, ...repoParams) as PRRow

    const blocked = this.db
      .prepare(`SELECT repo, issue_number, block_reason FROM runs WHERE status = 'blocked'${repoFilter} ORDER BY created_at DESC`)
      .all(...repoParams) as BlockedRow[]

    const running = this.db
      .prepare(`SELECT repo, issue_number, current_phase FROM runs WHERE status IN ('queued', 'running')${repoFilter} ORDER BY created_at DESC`)
      .all(...repoParams) as RunningRow[]

    return {
      period: { from: sinceStr, to: nowStr },
      runs: runCounts,
      prsCreated: prRow.count,
      totalCostUsd,
      currentBlocked: blocked.map((b) => ({
        repo: b.repo,
        issueNumber: b.issue_number,
        blockReason: b.block_reason,
      })),
      currentRunning: running.map((r) => ({
        repo: r.repo,
        issueNumber: r.issue_number,
        phase: r.current_phase,
      })),
    }
  }
}
