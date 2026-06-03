import type Database from 'better-sqlite3'
import { listHandoffs, type AgentHandoff } from './handoffs.js'
import { loadRunLogEvents, type RunLogEventRecord, type RunLogSource } from './run-log-events.js'

export type TimelineKind = 'handoff' | 'event' | 'cost' | 'prompt'

/**
 * Cross-table sort ordering. Each source table has its own auto-increment
 * `id` so the per-table id alone is not globally unique. The composite key
 * (ts, kindWeight, id) gives a stable total order even when multiple rows
 * land in the same millisecond.
 *
 * Weights are intentionally small integers so an ascending sort feels
 * natural: phases come before handoffs come before low-level events.
 */
export const KIND_WEIGHT: Record<TimelineKind, number> = {
  // Phase entries are derived from `run_log_events` (event_type in
  // PHASE_EVENT_TYPES) so they share weight=1 to surface above bulk events
  // when timestamps collide.
  handoff: 2,
  event: 3,
  cost: 4,
  prompt: 5,
}

const PHASE_EVENT_TYPES = new Set([
  'phase_started',
  'phase_completed',
  'phase_failed',
  'phase_skipped',
])

export interface TimelineEntry {
  /** epoch milliseconds — normalized across source tables */
  ts: number
  /** secondary sort key; see KIND_WEIGHT */
  kindWeight: number
  /** per-table primary key — third sort tiebreak */
  id: number
  kind: TimelineKind | 'phase'
  source: RunLogSource
  phase: string | null
  summary: string
  detailMd?: string
  detailJson?: unknown
}

export interface BuildTimelineOptions {
  /** Only include entries from these sources. */
  sources?: RunLogSource[]
  /** Only include entries of these kinds. */
  kinds?: Array<TimelineEntry['kind']>
  /** Earliest entry to include, epoch ms inclusive. */
  sinceMs?: number
  /** Maximum entries returned (post-filter, post-sort). */
  limit?: number
  /** Set true to omit the `prompt_compilations` source even if the table exists. */
  excludePrompts?: boolean
}

/**
 * Merge handoffs, run log events, and cost ledger entries for a run into a
 * single chronologically-ordered timeline. Pure function — only reads.
 *
 * Phase transitions are derived from `run_log_events` (event_type in
 * PHASE_EVENT_TYPES) — they share the timestamp/id of the underlying event
 * but render as kind='phase' for filtering and visual grouping.
 *
 * If migration 034 has run and `prompt_compilations` exists, prompt
 * compilations are also included (kind='prompt'). Otherwise that source is
 * skipped silently.
 */
export function buildTimeline(
  db: Database.Database,
  runId: string,
  options: BuildTimelineOptions = {},
): TimelineEntry[] {
  const all: TimelineEntry[] = []

  for (const handoff of listHandoffs(db, runId)) {
    all.push(handoffToEntry(handoff))
  }

  for (const event of loadRunLogEvents(db, runId, 0, Number.MAX_SAFE_INTEGER)) {
    all.push(eventToEntry(event))
  }

  for (const row of readCostEntries(db, runId)) {
    all.push(costEntryToEntry(row))
  }

  if (!options.excludePrompts && tableExists(db, 'prompt_compilations')) {
    for (const row of readPromptCompilations(db, runId)) {
      all.push(promptCompilationToEntry(row))
    }
  }

  const filtered = all.filter((entry) => matchesFilters(entry, options))
  filtered.sort(compareEntries)
  return options.limit !== undefined ? filtered.slice(0, options.limit) : filtered
}

function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.ts !== b.ts) return a.ts - b.ts
  if (a.kindWeight !== b.kindWeight) return a.kindWeight - b.kindWeight
  return a.id - b.id
}

function matchesFilters(entry: TimelineEntry, options: BuildTimelineOptions): boolean {
  if (options.sinceMs !== undefined && entry.ts < options.sinceMs) return false
  if (options.sources && !options.sources.includes(entry.source)) return false
  if (options.kinds && !options.kinds.includes(entry.kind)) return false
  return true
}

function handoffToEntry(handoff: AgentHandoff): TimelineEntry {
  return {
    ts: handoff.createdAt.getTime(),
    kindWeight: KIND_WEIGHT.handoff,
    id: handoff.id,
    kind: 'handoff',
    source: 'agent',
    phase: handoff.stepId,
    summary: `${handoff.kind}: ${handoff.summary}`,
    detailMd: handoff.contentMd,
    detailJson: handoff.contentJson,
  }
}

function eventToEntry(event: RunLogEventRecord): TimelineEntry {
  const isPhaseEvent = PHASE_EVENT_TYPES.has(event.type)
  return {
    ts: parseIsoToMs(event.timestamp),
    // Phase transitions get weight=1 so they appear above handoffs when
    // timestamps collide; ordinary log events stay at the regular event
    // weight.
    kindWeight: isPhaseEvent ? 1 : KIND_WEIGHT.event,
    id: event.id,
    kind: isPhaseEvent ? 'phase' : 'event',
    source: event.source,
    phase: event.phase,
    summary: summarizeEvent(event),
    ...(event.data !== null ? { detailJson: event.data } : {}),
  }
}

function summarizeEvent(event: RunLogEventRecord): string {
  const data = event.data
  if (data) {
    const maybeMessage = data['message']
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
      return `${event.type}: ${maybeMessage}`
    }
  }
  return event.type
}

interface CostEntryRow {
  id: number
  step_id: string
  worker_type: string | null
  cost_usd: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_tokens: number
  created_at: string
}

function readCostEntries(db: Database.Database, runId: string): CostEntryRow[] {
  return db
    .prepare(
      `SELECT id, step_id, worker_type, cost_usd, prompt_tokens, completion_tokens,
              cache_read_tokens, created_at
       FROM run_cost_entries
       WHERE run_id = ?
       ORDER BY id ASC`,
    )
    .all(runId) as CostEntryRow[]
}

function costEntryToEntry(row: CostEntryRow): TimelineEntry {
  const usd = row.cost_usd.toFixed(4)
  const totalTokens = row.prompt_tokens + row.completion_tokens + row.cache_read_tokens
  return {
    ts: parseIsoToMs(row.created_at),
    kindWeight: KIND_WEIGHT.cost,
    id: row.id,
    kind: 'cost',
    source: 'system',
    phase: row.step_id,
    summary: `$${usd} • ${totalTokens} tokens • ${row.worker_type ?? 'unknown'}`,
    detailJson: {
      stepId: row.step_id,
      workerType: row.worker_type,
      costUsd: row.cost_usd,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cacheReadTokens: row.cache_read_tokens,
    },
  }
}

interface PromptCompilationRow {
  id: number
  step_id: string
  phase: string
  template_path: string | null
  template_sha: string
  system_sha: string
  user_sha: string
  created_at: number
}

function readPromptCompilations(db: Database.Database, runId: string): PromptCompilationRow[] {
  return db
    .prepare(
      `SELECT id, step_id, phase, template_path, template_sha, system_sha, user_sha, created_at
       FROM prompt_compilations
       WHERE run_id = ?
       ORDER BY id ASC`,
    )
    .all(runId) as PromptCompilationRow[]
}

function promptCompilationToEntry(row: PromptCompilationRow): TimelineEntry {
  return {
    ts: row.created_at,
    kindWeight: KIND_WEIGHT.prompt,
    id: row.id,
    kind: 'prompt',
    source: 'system',
    phase: row.phase,
    summary: `compiled prompt for ${row.step_id} (template=${row.template_path ?? '<inline>'})`,
    detailJson: {
      stepId: row.step_id,
      templatePath: row.template_path,
      templateSha: row.template_sha,
      systemSha: row.system_sha,
      userSha: row.user_sha,
    },
  }
}

function parseIsoToMs(value: string): number {
  const parsed = Date.parse(value)
  // Date.parse returns NaN on malformed strings; surface as 0 so the entry
  // sinks to the top of the timeline rather than throwing. Operators can
  // notice via the bogus timestamp.
  return Number.isFinite(parsed) ? parsed : 0
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined
  return row !== undefined
}
