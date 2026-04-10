import type Database from 'better-sqlite3'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config } from '../config/schema.js'
import { insertRunLogEvents } from '../state/run-log-events.js'
import { logger } from '../utils/logger.js'
import { agentEventBus } from './bus.js'
import type { AgentEvent } from './types.js'

const FLUSH_INTERVAL_MS = 2_000
const FLUSH_BATCH_SIZE = 50

export class AgentObservability {
  private pending: AgentEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private streams = new Map<string, WriteStream>()
  private insertEvents: (events: AgentEvent[]) => void
  private options: {
    agentStreaming: boolean
    eventRetention: number
    sessionLogs: boolean
  }

  constructor(
    private db: Database.Database,
    private config: Config,
  ) {
    this.insertEvents = this.db.transaction((events: AgentEvent[]) => {
      const stmt = this.db.prepare(
        `INSERT INTO agent_events (run_id, phase, role, event_type, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const event of events) {
        stmt.run(
          event.runId,
          event.phase,
          event.role,
          event.type,
          JSON.stringify(event.data),
          event.timestamp,
        )
      }
      insertRunLogEvents(this.db, events.map((event) => ({
        runId: event.runId,
        source: 'agent',
        phase: event.phase,
        role: event.role,
        type: event.type,
        data: event.data,
        timestamp: event.timestamp,
      })))
    })
    this.options = normalizeObservabilityOptions(config)
    agentEventBus.setRetentionLimit(this.options.eventRetention)
  }

  record(event: AgentEvent): void {
    if (!this.options.agentStreaming) return

    const emitted = agentEventBus.emit(event)
    this.pending.push(emitted)

    if (this.options.sessionLogs) {
      this.writeSessionLog(emitted)
    }

    if (this.pending.length >= FLUSH_BATCH_SIZE) {
      this.flush()
      return
    }

    this.ensureFlushTimer()
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.length === 0) return

    const batch = this.pending.splice(0, this.pending.length)
    try {
      this.insertEvents(batch)
    } catch (err) {
      logger.warn({ err, events: batch.length }, 'Failed to persist agent events')
    }
  }

  async close(): Promise<void> {
    this.flush()
    await this.closeStreams()
  }

  /**
   * Release per-run resources: close any session log streams for the
   * run and clear its entry from the in-memory event history. Called
   * from the poller when a run reaches a terminal state so that the
   * daemon does not accumulate map entries and open file descriptors
   * for every run it has ever processed.
   */
  async closeRun(runId: string): Promise<void> {
    const toClose: Array<[string, WriteStream]> = []
    for (const [key, stream] of this.streams.entries()) {
      if (key.startsWith(`${runId}:`)) {
        toClose.push([key, stream])
      }
    }
    for (const [key] of toClose) {
      this.streams.delete(key)
    }
    await Promise.all(
      toClose.map(([, stream]) => new Promise<void>((resolve) => stream.end(() => resolve()))),
    )
    agentEventBus.clear(runId)
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
  }

  private writeSessionLog(event: AgentEvent): void {
    const key = `${event.runId}:${event.phase}`
    const existing = this.streams.get(key)
    if (existing) {
      existing.write(`${JSON.stringify(event)}\n`)
      return
    }
    // Lazy-open the stream asynchronously so mkdirSync does not block the
    // event loop on every new run×phase combination.
    void this.openStreamAndWrite(event, key)
  }

  private async openStreamAndWrite(event: AgentEvent, key: string): Promise<void> {
    // Re-check after await to avoid double-open races
    if (this.streams.has(key)) {
      this.streams.get(key)!.write(`${JSON.stringify(event)}\n`)
      return
    }
    try {
      const safePhase = sanitizeSegment(event.phase)
      const dir = join(this.config.storage.logsRoot, event.runId)
      const path = join(dir, `${safePhase}.jsonl`)
      await mkdir(dirname(path), { recursive: true })

      const stream = createWriteStream(path, { flags: 'a' })
      stream.on('error', (err) => {
        logger.warn({ err, runId: event.runId, phase: event.phase, path }, 'Session log stream error')
      })
      this.streams.set(key, stream)
      stream.write(`${JSON.stringify(event)}\n`)
    } catch (err) {
      logger.warn({ err, runId: event.runId, phase: event.phase }, 'Failed to open session log stream')
    }
  }

  private async closeStreams(): Promise<void> {
    const streams = [...this.streams.values()]
    this.streams.clear()
    await Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
      stream.end(() => resolve())
    })))
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function normalizeObservabilityOptions(config: Config): {
  agentStreaming: boolean
  eventRetention: number
  sessionLogs: boolean
} {
  const raw = config.observability as Partial<Config['observability']> | undefined
  return {
    agentStreaming: raw?.agentStreaming ?? true,
    eventRetention: raw?.eventRetention ?? 1000,
    sessionLogs: raw?.sessionLogs ?? true,
  }
}

let activeAgentObservability: AgentObservability | null = null

export function setActiveAgentObservability(instance: AgentObservability | null): void {
  activeAgentObservability = instance
}

export function flushActiveAgentObservability(): void {
  activeAgentObservability?.flush()
}

export function clearActiveAgentObservability(instance: AgentObservability): void {
  if (activeAgentObservability === instance) {
    activeAgentObservability = null
  }
}
