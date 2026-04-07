import {
  type ShellSessionEvent,
  type ShellSessionEventsPayload,
} from '../types/dashboard.js'

export function asShellSessionEventsPayload(
  payload: unknown,
): ShellSessionEventsPayload | null {
  if (!payload || typeof payload !== 'object') return null

  const sessionId = (payload as { sessionId?: unknown }).sessionId
  const status = (payload as { status?: unknown }).status
  const events = (payload as { events?: unknown }).events
  const lastEventId = (payload as { lastEventId?: unknown }).lastEventId

  if (typeof sessionId !== 'string') return null
  if (status !== 'running' && status !== 'closed') return null
  if (!Array.isArray(events)) return null
  if (typeof lastEventId !== 'number') return null

  return {
    sessionId,
    status,
    events: events.filter((event): event is ShellSessionEvent => {
      if (!event || typeof event !== 'object') return false
      const maybeId = (event as { id?: unknown }).id
      return typeof maybeId === 'number'
    }),
    lastEventId,
  }
}

export function mergeShellSessionEvents(
  existing: ShellSessionEvent[],
  incoming: ShellSessionEvent[],
): ShellSessionEvent[] {
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
