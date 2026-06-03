import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { buildTimeline, type TimelineEntry, type BuildTimelineOptions } from '../../state/timeline.js'
import type { RunLogSource } from '../../state/run-log-events.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
}

export interface TimelineCommandOptions {
  source?: string
  kind?: string
  since?: string
  limit?: string
}

const VALID_SOURCES: ReadonlySet<RunLogSource> = new Set<RunLogSource>(['system', 'agent', 'user'])
const VALID_KINDS: ReadonlySet<TimelineEntry['kind']> = new Set<TimelineEntry['kind']>([
  'phase',
  'handoff',
  'event',
  'cost',
  'prompt',
])

export async function timelineCommand(
  runId: string,
  opts: TimelineCommandOptions,
  globalOpts?: GlobalOpts,
): Promise<void> {
  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exit(1)
  }

  const buildOpts = parseBuildOptions(opts)
  const db = initDatabase(config.storage.dbPath)
  try {
    const entries = buildTimeline(db, runId, buildOpts)
    console.log(`\nnight-orch timeline: ${runId}`)
    if (entries.length === 0) {
      console.log('  none')
      return
    }
    console.log(formatHeader())
    for (const entry of entries) {
      console.log(formatEntry(entry))
    }
  } finally {
    db.close()
  }
}

function parseBuildOptions(opts: TimelineCommandOptions): BuildTimelineOptions {
  const out: BuildTimelineOptions = {}
  if (opts.source) {
    const sources = opts.source.split(',').map((s) => s.trim()).filter(Boolean)
    for (const s of sources) {
      if (!VALID_SOURCES.has(s as RunLogSource)) {
        process.stderr.write(`Unknown source: ${s} (valid: system|agent|user)\n`)
        process.exit(1)
      }
    }
    out.sources = sources as RunLogSource[]
  }
  if (opts.kind) {
    const kinds = opts.kind.split(',').map((k) => k.trim()).filter(Boolean)
    for (const k of kinds) {
      if (!VALID_KINDS.has(k as TimelineEntry['kind'])) {
        process.stderr.write(`Unknown kind: ${k} (valid: phase|handoff|event|cost|prompt)\n`)
        process.exit(1)
      }
    }
    out.kinds = kinds as Array<TimelineEntry['kind']>
  }
  if (opts.since) {
    const parsed = Date.parse(opts.since)
    if (!Number.isFinite(parsed)) {
      process.stderr.write(`Invalid --since timestamp: ${opts.since} (expected ISO 8601)\n`)
      process.exit(1)
    }
    out.sinceMs = parsed
  }
  if (opts.limit) {
    const n = Number.parseInt(opts.limit, 10)
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`Invalid --limit: ${opts.limit}\n`)
      process.exit(1)
    }
    out.limit = n
  }
  return out
}

function formatHeader(): string {
  const cols = [
    'timestamp'.padEnd(24),
    'kind'.padEnd(8),
    'source'.padEnd(7),
    'phase'.padEnd(12),
    'summary',
  ]
  return cols.join(' ')
}

function formatEntry(entry: TimelineEntry): string {
  const ts = new Date(entry.ts).toISOString().padEnd(24)
  const kind = entry.kind.padEnd(8)
  const source = entry.source.padEnd(7)
  const phase = (entry.phase ?? '-').padEnd(12)
  return `${ts} ${kind} ${source} ${phase} ${entry.summary}`
}
