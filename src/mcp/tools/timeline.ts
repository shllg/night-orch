import type { MCPDependencies } from '../server.js'
import { buildTimeline, type BuildTimelineOptions, type TimelineEntry } from '../../state/timeline.js'
import type { RunLogSource } from '../../state/run-log-events.js'
import { RunManager } from '../../state/runs.js'

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000

export interface TimelineToolArgs {
  runId: string
  sources?: RunLogSource[]
  kinds?: Array<TimelineEntry['kind']>
  sinceMs?: number
  limit?: number
}

export async function handleTimeline(args: TimelineToolArgs, deps: MCPDependencies): Promise<unknown> {
  const runManager = new RunManager(deps.db)
  const run = runManager.getById(args.runId)
  if (!run) throw new Error(`Run not found: ${args.runId}`)

  const limit = clampLimit(args.limit ?? DEFAULT_LIMIT)
  const opts: BuildTimelineOptions = { limit }
  if (args.sources) opts.sources = args.sources
  if (args.kinds) opts.kinds = args.kinds
  if (args.sinceMs !== undefined) opts.sinceMs = args.sinceMs

  const entries = buildTimeline(deps.db, args.runId, opts)
  return {
    runId: args.runId,
    count: entries.length,
    limit,
    entries: entries.map((entry) => ({
      ts: entry.ts,
      tsIso: new Date(entry.ts).toISOString(),
      kind: entry.kind,
      source: entry.source,
      phase: entry.phase,
      summary: entry.summary,
      ...(entry.detailMd !== undefined ? { detailMd: entry.detailMd } : {}),
      ...(entry.detailJson !== undefined ? { detailJson: entry.detailJson } : {}),
    })),
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(limit, MAX_LIMIT)
}
