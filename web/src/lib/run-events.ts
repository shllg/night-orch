import { type RunEvent, type RunEventsPayload } from '../types/dashboard.js'

export function asRunEventsPayload(payload: unknown): RunEventsPayload | null {
  if (!payload || typeof payload !== 'object') return null

  const runId = (payload as { runId?: unknown }).runId
  const repo = (payload as { repo?: unknown }).repo
  const issueNumber = (payload as { issueNumber?: unknown }).issueNumber
  const events = (payload as { events?: unknown }).events
  const lastEventId = (payload as { lastEventId?: unknown }).lastEventId

  if (typeof runId !== 'string' && typeof repo !== 'string') return null
  if (!Array.isArray(events)) return null
  if (typeof lastEventId !== 'number') return null

  return {
    ...(typeof runId === 'string' ? { runId } : {}),
    ...(typeof repo === 'string' ? { repo } : {}),
    ...(typeof issueNumber === 'number' ? { issueNumber } : {}),
    events: events.filter((event): event is RunEvent => {
      if (!event || typeof event !== 'object') return false
      const maybeId = (event as { id?: unknown }).id
      return typeof maybeId === 'number'
    }),
    lastEventId,
  }
}

export function mergeRunEvents(existing: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const seen = new Set(existing.map((event) => event.id))
  const merged = [...existing]

  for (const event of incoming) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    merged.push(event)
  }

  merged.sort((a, b) => a.id - b.id)
  return merged
}
