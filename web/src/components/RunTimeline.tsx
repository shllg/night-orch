import { type ReactElement, useEffect, useMemo, useState } from 'react'

type TimelineKind = 'phase' | 'handoff' | 'event' | 'cost' | 'prompt'
type TimelineSource = 'system' | 'agent' | 'user'

interface TimelineEntry {
  ts: number
  tsIso: string
  kind: TimelineKind
  source: TimelineSource
  phase: string | null
  summary: string
  detailMd?: string
  detailJson?: unknown
}

interface RunTimelineProps {
  runId: string
  /** Bumped by the parent when a WebSocket `timeline-stale` arrives. */
  refreshKey?: number
}

const SOURCE_LABELS: Record<TimelineSource, string> = {
  system: 'system',
  agent: 'agent',
  user: 'user',
}

const KIND_LABELS: Record<TimelineKind, string> = {
  phase: 'phase',
  handoff: 'handoff',
  event: 'event',
  cost: 'cost',
  prompt: 'prompt',
}

export function RunTimeline({ runId, refreshKey }: RunTimelineProps): ReactElement {
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [sources, setSources] = useState<Set<TimelineSource>>(() => new Set(['system', 'agent', 'user']))
  const [kinds, setKinds] = useState<Set<TimelineKind>>(() => new Set(['phase', 'handoff', 'event', 'cost', 'prompt']))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let aborted = false
    fetch(`/api/runs/${encodeURIComponent(runId)}/timeline?limit=500`)
      .then((res) => res.json() as Promise<{ entries?: TimelineEntry[] }>)
      .then((body) => {
        if (aborted) return
        setEntries(body.entries ?? [])
        setError(null)
      })
      .catch((err: unknown) => {
        if (aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      aborted = true
    }
  }, [runId, refreshKey])

  const filtered = useMemo(
    () => entries.filter((e) => sources.has(e.source) && kinds.has(e.kind)),
    [entries, sources, kinds],
  )

  function toggleSource(source: TimelineSource): void {
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }

  function toggleKind(kind: TimelineKind): void {
    setKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  return (
    <section className="min-w-0 rounded-box border border-base-300/70 bg-base-100/70 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-base-content">Timeline</h3>
        <p className="text-xs text-base-content/65">
          {filtered.length} of {entries.length} entries
        </p>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <span className="text-xs uppercase tracking-wide text-base-content/55">source:</span>
        {(['system', 'agent', 'user'] as TimelineSource[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`badge badge-sm ${sources.has(s) ? 'badge-info' : 'badge-ghost'}`}
            onClick={() => toggleSource(s)}
          >
            {SOURCE_LABELS[s]}
          </button>
        ))}
        <span className="ml-3 text-xs uppercase tracking-wide text-base-content/55">kind:</span>
        {(['phase', 'handoff', 'event', 'cost', 'prompt'] as TimelineKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`badge badge-sm ${kinds.has(k) ? 'badge-secondary' : 'badge-ghost'}`}
            onClick={() => toggleKind(k)}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      {error !== null && (
        <p className="mt-3 text-xs text-error">Failed to load timeline: {error}</p>
      )}

      {filtered.length === 0 && error === null ? (
        <p className="mt-3 text-xs text-base-content/60">
          No timeline entries yet. Phases, handoffs, and events appear here as the run progresses.
        </p>
      ) : (
        <div className="mt-3 max-h-[60vh] min-w-0 overflow-y-auto rounded-box border border-base-300/60 bg-base-200/50 p-3 font-mono text-xs">
          {filtered.map((entry, idx) => (
            <div
              key={`${entry.kind}-${entry.ts}-${idx}`}
              className="grid min-w-0 grid-cols-[auto_auto_auto_auto_1fr] gap-x-3 gap-y-1 border-b border-b-base-300/30 py-1 last:border-b-0"
            >
              <span className="text-base-content/55">{formatTs(entry.tsIso)}</span>
              <span className={`badge badge-xs ${kindBadge(entry.kind)}`}>{entry.kind}</span>
              <span className={`text-xs ${sourceColor(entry.source)}`}>{entry.source}</span>
              <span className="text-base-content/60">{entry.phase ?? '-'}</span>
              <span className="whitespace-pre-wrap break-words text-base-content/85">
                {entry.summary}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour12: false })
}

function kindBadge(kind: TimelineKind): string {
  switch (kind) {
    case 'phase':
      return 'badge-warning'
    case 'handoff':
      return 'badge-success'
    case 'event':
      return 'badge-ghost'
    case 'cost':
      return 'badge-secondary'
    case 'prompt':
      return 'badge-info'
  }
}

function sourceColor(source: TimelineSource): string {
  switch (source) {
    case 'system':
      return 'text-secondary'
    case 'agent':
      return 'text-info'
    case 'user':
      return 'text-accent'
  }
}
