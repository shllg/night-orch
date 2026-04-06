import type Database from 'better-sqlite3'
import { logger } from '../utils/logger.js'
import { utcIsoFromMs } from '../utils/time.js'

export interface RetentionOptions {
  /** Compact phase_data and delete events after this many days. */
  detailDays: number
  /** Delete entire run records after this many days. */
  archiveDays: number
  /** Run incremental vacuum after pruning. */
  vacuum: boolean
  dryRun: boolean
}

export interface RetentionResult {
  compactedRuns: number
  deletedRuns: number
  deletedEvents: number
  deletedMentions: number
  vacuumed: boolean
}

/**
 * Prunes old DB data using a compact-then-delete strategy.
 * - Compact: runs > detailDays have phase_data summarized and events deleted.
 * - Delete: runs > archiveDays are fully deleted along with associated data.
 * - Uses incremental_vacuum instead of full VACUUM to avoid locking.
 */
export class RetentionEngine {
  constructor(private db: Database.Database) {}

  prune(options: RetentionOptions): RetentionResult {
    const result: RetentionResult = {
      compactedRuns: 0,
      deletedRuns: 0,
      deletedEvents: 0,
      deletedMentions: 0,
      vacuumed: false,
    }

    const detailCutoff = utcIsoFromMs(Date.now() - options.detailDays * 24 * 60 * 60 * 1000)
    const archiveCutoff = utcIsoFromMs(Date.now() - options.archiveDays * 24 * 60 * 60 * 1000)

    if (options.dryRun) {
      const compactCount = this.db
        .prepare("SELECT COUNT(*) as c FROM runs WHERE ended_at < ? AND ended_at >= ? AND phase_data IS NOT NULL AND status IN ('completed', 'error')")
        .get(detailCutoff, archiveCutoff) as { c: number }
      result.compactedRuns = compactCount.c

      const deleteCount = this.db
        .prepare("SELECT COUNT(*) as c FROM runs WHERE ended_at < ? AND status IN ('completed', 'error')")
        .get(archiveCutoff) as { c: number }
      result.deletedRuns = deleteCount.c

      return result
    }

    const runPrune = this.db.transaction(() => {
      // Step 1: Compact — summarize phase_data for old completed/error runs.
      // We must preserve routing metadata (`issueRepo`) so post-compaction
      // continue/retry/rebase/delete flows on linked projects still reach
      // the correct upstream repo via `resolveIssueRepo(phaseData, ...)`.
      const compactRows = this.db
        .prepare("SELECT id, estimated_cost_usd, status, phase_data FROM runs WHERE ended_at < ? AND ended_at >= ? AND phase_data IS NOT NULL AND status IN ('completed', 'error')")
        .all(detailCutoff, archiveCutoff) as Array<{
          id: string
          estimated_cost_usd: number
          status: string
          phase_data: string | null
        }>

      for (const row of compactRows) {
        const preservedIssueRepo = extractIssueRepo(row.phase_data)
        const summary: Record<string, unknown> = {
          compacted: true,
          costUsd: row.estimated_cost_usd,
          status: row.status,
        }
        if (preservedIssueRepo) {
          summary['issueRepo'] = preservedIssueRepo
        }
        this.db.prepare('UPDATE runs SET phase_data = ? WHERE id = ?').run(JSON.stringify(summary), row.id)
      }
      result.compactedRuns = compactRows.length

      // Delete events for compacted runs
      if (compactRows.length > 0) {
        const ids = compactRows.map((r) => r.id)
        const placeholders = ids.map(() => '?').join(',')
        const eventInfo = this.db.prepare(`DELETE FROM events WHERE run_id IN (${placeholders})`).run(...ids)
        const agentEventInfo = this.db.prepare(`DELETE FROM agent_events WHERE run_id IN (${placeholders})`).run(...ids)
        result.deletedEvents += eventInfo.changes + agentEventInfo.changes
      }

      // Step 2: Delete — remove entire runs older than archiveDays
      const archiveRows = this.db
        .prepare("SELECT id FROM runs WHERE ended_at < ? AND status IN ('completed', 'error')")
        .all(archiveCutoff) as Array<{ id: string }>

      if (archiveRows.length > 0) {
        const ids = archiveRows.map((r) => r.id)
        const placeholders = ids.map(() => '?').join(',')

        // Delete associated events
        const eventInfo = this.db.prepare(`DELETE FROM events WHERE run_id IN (${placeholders})`).run(...ids)
        const agentEventInfo = this.db.prepare(`DELETE FROM agent_events WHERE run_id IN (${placeholders})`).run(...ids)
        result.deletedEvents += eventInfo.changes + agentEventInfo.changes

        // Delete runs
        const runInfo = this.db.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...ids)
        result.deletedRuns = runInfo.changes
      }

      // Delete old mention_tracking entries
      const mentionInfo = this.db
        .prepare('DELETE FROM mention_tracking WHERE posted_at < ?')
        .run(archiveCutoff)
      result.deletedMentions = mentionInfo.changes
    })

    runPrune()

    // Step 3: Incremental vacuum (outside transaction)
    if (options.vacuum && (result.deletedRuns > 0 || result.compactedRuns > 0)) {
      try {
        this.db.pragma('incremental_vacuum(100)')
        result.vacuumed = true
      } catch (err) {
        logger.warn({ err }, 'Incremental vacuum failed')
      }
    }

    return result
  }
}

/**
 * Pull the `issueRepo` routing key out of a phase_data JSON blob, if
 * present. Used by retention compaction to preserve cross-repo routing
 * when a run's detailed phase_data is summarized. Degrades to null on
 * any parse error or missing field.
 */
function extractIssueRepo(phaseDataJson: string | null): string | null {
  if (!phaseDataJson) return null
  try {
    const parsed = JSON.parse(phaseDataJson) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>)['issueRepo']
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}
