import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import * as nodePty from 'node-pty'
import type { IPty } from 'node-pty'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'

export type ShellSessionStatus = 'running' | 'closed'
export type ShellSessionEventType = 'status' | 'output' | 'exit'

export interface ShellSessionSummary {
  id: string
  status: ShellSessionStatus
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: string
  updatedAt: string
  exitCode: number | null
  exitSignal: number | null
}

export type ShellSessionDetail = ShellSessionSummary

export interface ShellSessionEvent {
  id: number
  sessionId: string
  timestamp: string
  type: ShellSessionEventType
  data: Record<string, unknown>
}

interface ShellSessionState {
  id: string
  status: ShellSessionStatus
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: string
  updatedAt: string
  exitCode: number | null
  exitSignal: number | null
  closeRequested: boolean
  events: ShellSessionEvent[]
  ptyProcess: IPty | null
}

export interface ShellSessionList {
  generatedAt: string
  homePath: string
  sessions: ShellSessionSummary[]
}

export interface ShellSessionEventList {
  sessionId: string
  status: ShellSessionStatus
  events: ShellSessionEvent[]
  lastEventId: number
}

interface CreateShellSessionInput {
  cwd?: string | null
  cols?: number
  rows?: number
}

interface SessionEventListener {
  (sessionId: string): void
}

interface ManagerOptions {
  homePath?: string
  maxEventsPerSession?: number
  defaultCols?: number
  defaultRows?: number
}

const DEFAULT_MAX_EVENTS_PER_SESSION = 8_000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
const MAX_INPUT_CHARS = 32_000

export class ShellSessionManager {
  private readonly sessions = new Map<string, ShellSessionState>()
  private readonly listeners = new Set<SessionEventListener>()
  private readonly homePath: string
  private readonly maxEventsPerSession: number
  private readonly defaultCols: number
  private readonly defaultRows: number
  private nextEventId = 1

  constructor(options: ManagerOptions = {}) {
    this.homePath = resolve(options.homePath ?? homedir())
    this.maxEventsPerSession = clampInt(
      options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION,
      500,
      30_000,
    )
    this.defaultCols = clampInt(options.defaultCols ?? DEFAULT_COLS, 40, 400)
    this.defaultRows = clampInt(options.defaultRows ?? DEFAULT_ROWS, 10, 240)
  }

  listSessions(): ShellSessionList {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => this.toSummary(session))

    return {
      generatedAt: nowUtcIso(),
      homePath: this.homePath,
      sessions,
    }
  }

  createSession(input: CreateShellSessionInput = {}): ShellSessionDetail {
    const cwd = this.resolveSessionCwd(input.cwd ?? null)
    const cols = clampInt(input.cols ?? this.defaultCols, 40, 400)
    const rows = clampInt(input.rows ?? this.defaultRows, 10, 240)
    const shell = resolveDefaultShell()

    let ptyProcess: IPty
    try {
      ptyProcess = nodePty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: buildShellEnv(cwd),
      })
    } catch (err) {
      throw new Error(`Failed to start shell: ${(err as Error).message}`)
    }

    const now = nowUtcIso()
    const id = randomUUID()

    const session: ShellSessionState = {
      id,
      status: 'running',
      shell,
      cwd,
      cols,
      rows,
      createdAt: now,
      updatedAt: now,
      exitCode: null,
      exitSignal: null,
      closeRequested: false,
      events: [],
      ptyProcess,
    }

    this.sessions.set(id, session)
    this.appendEvent(session, 'status', {
      message: `Started shell session (${shell})`,
      cwd,
      cols,
      rows,
    })

    ptyProcess.onData((chunk) => {
      if (!chunk) return
      this.appendEvent(session, 'output', { text: chunk })
    })

    ptyProcess.onExit((exit) => {
      session.status = 'closed'
      session.exitCode = typeof exit.exitCode === 'number' ? exit.exitCode : null
      session.exitSignal = typeof exit.signal === 'number' ? exit.signal : null
      session.ptyProcess = null
      session.updatedAt = nowUtcIso()
      this.appendEvent(session, 'exit', {
        exitCode: session.exitCode,
        signal: session.exitSignal,
        byRequest: session.closeRequested,
      })
    })

    return this.toDetail(session)
  }

  getSession(sessionId: string): ShellSessionDetail | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return this.toDetail(session)
  }

  closeSession(sessionId: string): ShellSessionDetail {
    const session = this.requireSession(sessionId)
    if (session.status === 'closed') {
      return this.toDetail(session)
    }

    session.closeRequested = true
    session.status = 'closed'
    session.updatedAt = nowUtcIso()
    this.appendEvent(session, 'status', { message: 'Closing shell session' })
    try {
      session.ptyProcess?.kill()
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, 'Failed to kill shell session PTY')
      session.status = 'closed'
      session.updatedAt = nowUtcIso()
      this.appendEvent(session, 'exit', {
        exitCode: session.exitCode,
        signal: session.exitSignal,
        byRequest: true,
      })
    }

    return this.toDetail(session)
  }

  closeAll(): void {
    for (const sessionId of this.sessions.keys()) {
      try {
        this.closeSession(sessionId)
      } catch (err) {
        logger.warn({ err, sessionId }, 'Failed to close shell session during shutdown')
      }
    }
  }

  writeInput(sessionId: string, data: string): void {
    const session = this.requireSession(sessionId)
    if (session.status !== 'running' || !session.ptyProcess) {
      throw new Error('Session is not running')
    }
    if (data.length > MAX_INPUT_CHARS) {
      throw new Error(`input exceeds ${MAX_INPUT_CHARS} characters`)
    }

    session.ptyProcess.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireSession(sessionId)
    if (session.status !== 'running' || !session.ptyProcess) {
      throw new Error('Session is not running')
    }

    const boundedCols = clampInt(cols, 40, 400)
    const boundedRows = clampInt(rows, 10, 240)

    session.cols = boundedCols
    session.rows = boundedRows
    session.updatedAt = nowUtcIso()
    session.ptyProcess.resize(boundedCols, boundedRows)
  }

  getEvents(sessionId: string, since = 0, limit = 200): ShellSessionEventList {
    const session = this.requireSession(sessionId)
    const boundedSince = Math.max(0, Math.floor(since))
    const boundedLimit = clampInt(limit, 1, 1_000)
    const events = session.events
      .filter((event) => event.id > boundedSince)
      .slice(0, boundedLimit)

    return {
      sessionId,
      status: session.status,
      events,
      lastEventId: events.length > 0 ? events[events.length - 1]!.id : boundedSince,
    }
  }

  onSessionEvent(listener: SessionEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private appendEvent(
    session: ShellSessionState,
    type: ShellSessionEventType,
    data: Record<string, unknown>,
  ): void {
    const event: ShellSessionEvent = {
      id: this.nextEventId++,
      sessionId: session.id,
      timestamp: nowUtcIso(),
      type,
      data,
    }

    session.events.push(event)
    if (session.events.length > this.maxEventsPerSession) {
      session.events.splice(0, session.events.length - this.maxEventsPerSession)
    }
    session.updatedAt = event.timestamp
    this.notify(session.id)
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId)
      } catch (err) {
        logger.warn({ err, sessionId }, 'Shell-session listener failed')
      }
    }
  }

  private requireSession(sessionId: string): ShellSessionState {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }

  private resolveSessionCwd(rawCwd: string | null): string {
    if (!rawCwd) return this.homePath

    const trimmed = rawCwd.trim()
    if (!trimmed) return this.homePath

    const expanded = trimmed === '~'
      ? this.homePath
      : trimmed.startsWith('~/')
        ? resolve(this.homePath, trimmed.slice(2))
        : trimmed

    const resolved = resolve(expanded.startsWith(sep) ? expanded : resolve(this.homePath, expanded))
    if (resolved !== this.homePath && !resolved.startsWith(this.homePath + sep)) {
      throw new Error('cwd must be inside the user home directory')
    }

    return resolved
  }

  private toSummary(session: ShellSessionState): ShellSessionSummary {
    return {
      id: session.id,
      status: session.status,
      shell: session.shell,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    }
  }

  private toDetail(session: ShellSessionState): ShellSessionDetail {
    return this.toSummary(session)
  }
}

function resolveDefaultShell(): string {
  const envShell = process.env['SHELL']
  if (typeof envShell === 'string' && envShell.trim().length > 0) {
    return envShell.trim()
  }
  return '/bin/sh'
}

function buildShellEnv(cwd: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    env[key] = value
  }

  if (!env['TERM']) {
    env['TERM'] = 'xterm-256color'
  }

  if (!env['HOME']) {
    env['HOME'] = homedir()
  }

  env['PWD'] = cwd
  return env
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const floor = Math.floor(value)
  if (floor < min) return min
  if (floor > max) return max
  return floor
}
