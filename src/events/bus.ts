import type { AgentEvent } from './types.js'

type EventHandler = (event: AgentEvent) => void

export class AgentEventBus {
  private subscribers = new Map<string, Set<EventHandler>>()
  private history = new Map<string, AgentEvent[]>()
  private nextId = 1

  constructor(private maxEventsPerRun = 500) {}

  setRetentionLimit(limit: number): void {
    if (!Number.isFinite(limit) || limit < 1) return
    this.maxEventsPerRun = Math.floor(limit)
    for (const [runId, events] of this.history.entries()) {
      if (events.length <= this.maxEventsPerRun) continue
      this.history.set(runId, events.slice(-this.maxEventsPerRun))
    }
  }

  subscribe(runId: string, handler: EventHandler): () => void {
    const set = this.subscribers.get(runId) ?? new Set<EventHandler>()
    set.add(handler)
    this.subscribers.set(runId, set)

    return () => {
      const handlers = this.subscribers.get(runId)
      if (!handlers) return
      handlers.delete(handler)
      if (handlers.size === 0) this.subscribers.delete(runId)
    }
  }

  emit(event: AgentEvent): AgentEvent {
    const withId: AgentEvent = {
      ...event,
      id: event.id ?? this.nextId++,
    }

    const runHistory = this.history.get(withId.runId) ?? []
    runHistory.push(withId)
    if (runHistory.length > this.maxEventsPerRun) {
      runHistory.splice(0, runHistory.length - this.maxEventsPerRun)
    }
    this.history.set(withId.runId, runHistory)

    const handlers = this.subscribers.get(withId.runId)
    if (handlers) {
      for (const handler of handlers) {
        handler(withId)
      }
    }

    return withId
  }

  getHistory(runId: string, limit = 50): AgentEvent[] {
    const events = this.history.get(runId) ?? []
    if (limit <= 0) return []
    return events.slice(-limit)
  }

  getSince(runId: string, sinceId: number, limit = 50): AgentEvent[] {
    if (limit <= 0) return []
    const events = this.history.get(runId) ?? []
    const filtered = events.filter((e) => (e.id ?? 0) > sinceId)
    return filtered.slice(0, limit)
  }

  clear(runId: string): void {
    this.history.delete(runId)
    this.subscribers.delete(runId)
  }
}

export const agentEventBus = new AgentEventBus()

