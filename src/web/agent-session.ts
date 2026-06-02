import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Config, WorkerProfile } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import { buildWorkerCommand } from '../workers/command.js'
import { buildWorkerEnv } from '../workers/env.js'
import { isRecord, summarizeValue } from '../workers/events.js'
import { streamingExec } from '../workers/streaming-exec.js'

export type InteractiveAgentType = 'claude' | 'codex'
export type InteractiveAgentSessionStatus = 'idle' | 'running' | 'failed' | 'closed'
export type InteractiveAgentSessionEventType = 'status' | 'stdout' | 'stderr' | 'text' | 'tool_call'

export interface InteractiveAgentProfileSummary {
  name: string
  type: InteractiveAgentType
  command: string
  args: string[]
}

export interface InteractiveAgentSessionSummary {
  id: string
  agent: InteractiveAgentType
  profileName: string | null
  status: InteractiveAgentSessionStatus
  cwd: string
  createdAt: string
  updatedAt: string
  turnCount: number
  lastError: string | null
}

export interface InteractiveAgentSessionDetail extends InteractiveAgentSessionSummary {
  continueSessionId: string | null
  runningTurnId: string | null
}

export interface InteractiveAgentSessionEvent {
  id: number
  sessionId: string
  timestamp: string
  type: InteractiveAgentSessionEventType
  data: Record<string, unknown>
}

interface InteractiveAgentSessionState {
  id: string
  agent: InteractiveAgentType
  profileName: string | null
  profile: WorkerProfile
  status: InteractiveAgentSessionStatus
  cwd: string
  createdAt: string
  updatedAt: string
  turnCount: number
  lastError: string | null
  continueSessionId: string | null
  runningTurnId: string | null
  events: InteractiveAgentSessionEvent[]
  inFlight: Promise<void> | null
}

export interface InteractiveAgentSessionList {
  generatedAt: string
  workspacePath: string
  profiles: InteractiveAgentProfileSummary[]
  sessions: InteractiveAgentSessionSummary[]
}

export interface InteractiveAgentSessionEventList {
  sessionId: string
  status: InteractiveAgentSessionStatus
  events: InteractiveAgentSessionEvent[]
  lastEventId: number
}

interface CreateSessionInput {
  agent: InteractiveAgentType
  profileName?: string | null
  cwd?: string | null
}

interface SessionEventListener {
  (sessionId: string): void
}

interface ManagerOptions {
  workspacePath?: string
  maxEventsPerSession?: number
}

const DEFAULT_MAX_EVENTS_PER_SESSION = 2_000

export class InteractiveAgentSessionManager {
  private readonly sessions = new Map<string, InteractiveAgentSessionState>()
  private readonly listeners = new Set<SessionEventListener>()
  private readonly workspacePath: string
  private readonly maxEventsPerSession: number
  private nextEventId = 1

  constructor(
    private readonly config: Config,
    options: ManagerOptions = {},
  ) {
    const workspacePath = options.workspacePath?.trim()
    if (!workspacePath) {
      throw new Error('agent-session workspacePath is required; configure storage.worktreeRoot before using web agent sessions')
    }
    this.workspacePath = resolve(workspacePath)
    this.maxEventsPerSession = clampInt(
      options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION,
      100,
      20_000,
    )
  }

  listSessions(): InteractiveAgentSessionList {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => this.toSummary(session))

    return {
      generatedAt: nowUtcIso(),
      workspacePath: this.workspacePath,
      profiles: this.listProfiles(),
      sessions,
    }
  }

  listProfiles(): InteractiveAgentProfileSummary[] {
    const out: InteractiveAgentProfileSummary[] = []
    for (const [name, profile] of Object.entries(this.config.workerProfiles)) {
      if (profile.type !== 'claude' && profile.type !== 'codex') continue
      out.push({
        name,
        type: profile.type,
        command: profile.command,
        args: [...profile.args],
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  createSession(input: CreateSessionInput): InteractiveAgentSessionDetail {
    const profileSelection = this.resolveProfile(input.agent, input.profileName ?? null)
    const cwd = this.resolveSessionCwd(input.cwd ?? null)
    const now = nowUtcIso()
    const id = randomUUID()

    const session: InteractiveAgentSessionState = {
      id,
      agent: input.agent,
      profileName: profileSelection.profileName,
      profile: profileSelection.profile,
      status: 'idle',
      cwd,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      lastError: null,
      continueSessionId: null,
      runningTurnId: null,
      events: [],
      inFlight: null,
    }

    this.sessions.set(id, session)
    this.appendEvent(session, 'status', {
      message: `Created ${input.agent} interactive session`,
      profile: profileSelection.profileName ?? '(fallback)',
      cwd,
    })

    return this.toDetail(session)
  }

  getSession(sessionId: string): InteractiveAgentSessionDetail | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return this.toDetail(session)
  }

  closeSession(sessionId: string): InteractiveAgentSessionDetail {
    const session = this.requireSession(sessionId)
    if (session.status === 'running') {
      throw new Error('Session is currently running and cannot be closed')
    }
    if (session.status === 'closed') {
      return this.toDetail(session)
    }

    session.status = 'closed'
    session.updatedAt = nowUtcIso()
    session.runningTurnId = null
    this.appendEvent(session, 'status', { message: 'Session closed' })
    return this.toDetail(session)
  }

  getEvents(
    sessionId: string,
    since = 0,
    limit = 200,
  ): InteractiveAgentSessionEventList {
    const session = this.requireSession(sessionId)
    const boundedSince = Math.max(0, Math.floor(since))
    const boundedLimit = clampInt(limit, 1, 400)
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

  sendPrompt(sessionId: string, prompt: string): { accepted: true; sessionId: string; turnId: string } {
    const session = this.requireSession(sessionId)
    const cleanedPrompt = prompt.trim()
    if (!cleanedPrompt) {
      throw new Error('prompt is required')
    }
    if (session.status === 'closed') {
      throw new Error('Session is closed')
    }
    if (session.inFlight) {
      throw new Error('Session already has a running prompt')
    }

    const turnId = randomUUID()
    session.status = 'running'
    session.updatedAt = nowUtcIso()
    session.turnCount += 1
    session.runningTurnId = turnId
    session.lastError = null

    this.appendEvent(session, 'status', {
      message: 'Turn started',
      turnId,
      turnCount: session.turnCount,
    })

    const runPromise = this.runTurn(session, turnId, cleanedPrompt)
    session.inFlight = runPromise
    void runPromise
      .catch((err) => {
        const message = summarizeValue((err as Error).message ?? String(err), 1_000)
        session.status = 'failed'
        session.lastError = `Unexpected turn failure: ${message}`
        session.runningTurnId = null
        session.updatedAt = nowUtcIso()
        this.appendEvent(session, 'status', {
          message: session.lastError,
          turnId,
        })
      })
      .finally(() => {
        if (session.inFlight === runPromise) {
          session.inFlight = null
        }
      })

    return { accepted: true, sessionId, turnId }
  }

  onSessionEvent(listener: SessionEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async runTurn(
    session: InteractiveAgentSessionState,
    turnId: string,
    prompt: string,
  ): Promise<void> {
    const tempOutputDir = join(tmpdir(), 'night-orch-codex-output')
    const tempOutputFile = session.agent === 'codex'
      ? join(tempOutputDir, `interactive-${randomUUID()}.txt`)
      : null

    try {
      if (tempOutputFile) {
        await mkdir(tempOutputDir, { recursive: true })
      }

      const taskArgs = buildInteractiveTaskArgs(
        session.agent,
        session.profile,
        session.continueSessionId,
        tempOutputFile,
      )
      const workerCommand = buildWorkerCommand(session.profile, taskArgs)
      const env = buildWorkerEnv(session.profile)

      const result = await streamingExec({
        command: workerCommand.command,
        args: workerCommand.args,
        cwd: session.cwd,
        env,
        timeoutMs: session.profile.workerTimeoutSeconds * 1000,
        stdin: prompt,
        onStdoutLine: (line) => {
          this.handleStdoutLine(session, line)
        },
        onStderrLine: (line) => {
          this.appendEvent(session, 'stderr', { text: summarizeValue(line, 1_000) })
        },
      })

      if (tempOutputFile) {
        try {
          const lastMessage = (await readFile(tempOutputFile, 'utf-8')).trim()
          if (lastMessage.length > 0) {
            this.appendEvent(session, 'text', {
              text: summarizeValue(lastMessage, 8_000),
              source: 'codex-output-last-message',
            })
          }
        } catch {
          // Best-effort only; some codex invocations may skip output file.
        } finally {
          void unlink(tempOutputFile).catch(() => {})
        }
      }

      const sessionId = session.agent === 'codex'
        ? extractCodexThreadId(result.stdout)
        : extractClaudeSessionId(result.stdout)
      if (sessionId) {
        session.continueSessionId = sessionId
      }

      if (result.outputTruncated) {
        this.appendEvent(session, 'status', {
          message: 'Output was truncated to tail window',
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        })
      }

      if (result.exitCode === 0 && !result.timedOut) {
        session.status = 'idle'
        session.lastError = null
        session.runningTurnId = null
        session.updatedAt = nowUtcIso()
        this.appendEvent(session, 'status', {
          message: 'Turn completed',
          turnId,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          sessionId: session.continueSessionId,
        })
        return
      }

      const failureMessage = result.timedOut
        ? `Agent timed out after ${session.profile.workerTimeoutSeconds}s`
        : `Agent exited with code ${result.exitCode}`
      session.status = 'failed'
      session.lastError = failureMessage
      session.runningTurnId = null
      session.updatedAt = nowUtcIso()
      this.appendEvent(session, 'status', {
        message: failureMessage,
        turnId,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      })
    } catch (err) {
      const message = summarizeValue((err as Error).message ?? String(err), 1_000)
      session.status = 'failed'
      session.lastError = message
      session.runningTurnId = null
      session.updatedAt = nowUtcIso()
      this.appendEvent(session, 'status', {
        message: `Turn failed: ${message}`,
        turnId,
      })
      logger.warn({ sessionId: session.id, err }, 'Interactive agent turn failed')
    }
  }

  private handleStdoutLine(session: InteractiveAgentSessionState, line: string): void {
    const parsed = tryParseJson(line)
    if (!parsed) {
      this.appendEvent(session, 'stdout', { text: summarizeValue(line, 1_000) })
      return
    }

    const handled = session.agent === 'codex'
      ? emitCodexEvent(parsed, (type, data) => this.appendEvent(session, type, data))
      : emitClaudeEvent(parsed, (type, data) => this.appendEvent(session, type, data))

    if (!handled) {
      this.appendEvent(session, 'stdout', { text: summarizeValue(line, 1_000) })
    }
  }

  private appendEvent(
    session: InteractiveAgentSessionState,
    type: InteractiveAgentSessionEventType,
    data: Record<string, unknown>,
  ): void {
    const event: InteractiveAgentSessionEvent = {
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
        logger.warn({ err, sessionId }, 'Agent-session listener failed')
      }
    }
  }

  private resolveProfile(
    agent: InteractiveAgentType,
    explicitProfileName: string | null,
  ): { profileName: string | null; profile: WorkerProfile } {
    if (explicitProfileName) {
      const byName = this.config.workerProfiles[explicitProfileName]
      if (!byName) {
        throw new Error(`Unknown profile: ${explicitProfileName}`)
      }
      if (byName.type !== agent) {
        throw new Error(`Profile ${explicitProfileName} has type ${byName.type}; expected ${agent}`)
      }
      return { profileName: explicitProfileName, profile: byName }
    }

    for (const [name, profile] of Object.entries(this.config.workerProfiles)) {
      if (profile.type === agent) {
        return { profileName: name, profile }
      }
    }

    return {
      profileName: null,
      profile: buildFallbackProfile(agent),
    }
  }

  private resolveSessionCwd(rawCwd: string | null): string {
    if (!rawCwd) return this.workspacePath

    const resolved = resolve(this.workspacePath, rawCwd)
    if (resolved !== this.workspacePath && !resolved.startsWith(this.workspacePath + sep)) {
      throw new Error('cwd must be inside the night-orch workspace')
    }
    return resolved
  }

  private requireSession(sessionId: string): InteractiveAgentSessionState {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }

  private toSummary(session: InteractiveAgentSessionState): InteractiveAgentSessionSummary {
    return {
      id: session.id,
      agent: session.agent,
      profileName: session.profileName,
      status: session.status,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      turnCount: session.turnCount,
      lastError: session.lastError,
    }
  }

  private toDetail(session: InteractiveAgentSessionState): InteractiveAgentSessionDetail {
    return {
      ...this.toSummary(session),
      continueSessionId: session.continueSessionId,
      runningTurnId: session.runningTurnId,
    }
  }
}

function buildFallbackProfile(agent: InteractiveAgentType): WorkerProfile {
  return {
    type: agent,
    command: agent,
    args: agent === 'codex' ? ['exec'] : ['-p'],
    workerTimeoutSeconds: 1800,
    minimalEnv: true,
    runtimeWrapper: null,
    env: {},
    sandbox: { type: 'host', mounts: [], env: {} },
    allowAgentSessionBypass: false,
  }
}

function buildInteractiveTaskArgs(
  agent: InteractiveAgentType,
  profile: WorkerProfile,
  continueSessionId: string | null,
  outputFile: string | null,
): string[] {
  if (agent === 'codex') {
    const args = [...profile.args]
    if (outputFile) {
      args.push('--output-last-message', outputFile)
    }

    if (continueSessionId) {
      const execIndex = args.indexOf('exec')
      if (execIndex >= 0) {
        args.splice(execIndex + 1, 0, 'resume', continueSessionId)
      }
    }

    return args
  }

  const args = [
    ...profile.args,
    '--output-format', 'json',
    '--max-turns', '50',
  ]
  rejectUnsafePermissionMode(args, profile.allowAgentSessionBypass === true)
  if (!hasExplicitPermissionMode(args)) {
    args.push('--permission-mode', resolveDefaultPermissionMode())
  }
  if (continueSessionId) {
    args.push('--continue', continueSessionId)
  }
  return args
}

function rejectUnsafePermissionMode(args: string[], allowAgentSessionBypass: boolean): void {
  if (allowAgentSessionBypass) return

  const unsafeMode = findUnsafePermissionMode(args)
  if (!unsafeMode) return

  throw new Error(
    `workerProfiles.*.allowAgentSessionBypass must be true before agent-session may use ${unsafeMode}`,
  )
}

function findUnsafePermissionMode(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--dangerously-skip-permissions' || arg === '--allow-dangerously-skip-permissions') {
      return arg
    }
    if (arg === '--permission-mode') {
      const mode = args[i + 1]
      if (mode === 'bypassPermissions' || mode === 'acceptEdits') {
        return mode
      }
      continue
    }
    const inlinePrefix = '--permission-mode='
    if (arg.startsWith(inlinePrefix)) {
      const mode = arg.slice(inlinePrefix.length)
      if (mode === 'bypassPermissions' || mode === 'acceptEdits') {
        return mode
      }
    }
  }
  return null
}

function hasExplicitPermissionMode(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) return true
    if (arg === '--dangerously-skip-permissions') return true
    if (arg === '--allow-dangerously-skip-permissions') return true
  }
  return false
}

function resolveDefaultPermissionMode(): 'plan' {
  return 'plan'
}

function emitCodexEvent(
  parsed: unknown,
  emit: (type: InteractiveAgentSessionEventType, data: Record<string, unknown>) => void,
): boolean {
  if (!isRecord(parsed)) return false

  const type = parsed['type']
  if (type === 'item.completed' && isRecord(parsed['item'])) {
    const item = parsed['item']
    if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
      emit('text', { text: summarizeValue(item['text'], 8_000) })
      return true
    }
    if ((item['type'] === 'function_call' || item['type'] === 'tool_call') && typeof item['name'] === 'string') {
      emit('tool_call', {
        toolName: item['name'],
        toolArgs: summarizeValue(item['arguments'] ?? item['args'], 1_000),
      })
      return true
    }
  }

  if (type === 'function_call' && typeof parsed['name'] === 'string') {
    emit('tool_call', {
      toolName: parsed['name'],
      toolArgs: summarizeValue(parsed['arguments'] ?? parsed['args'], 1_000),
    })
    return true
  }

  if (type === 'error') {
    emit('stderr', { text: summarizeValue(parsed['error'], 1_000) })
    return true
  }

  return false
}

function emitClaudeEvent(
  parsed: unknown,
  emit: (type: InteractiveAgentSessionEventType, data: Record<string, unknown>) => void,
): boolean {
  if (Array.isArray(parsed)) {
    let handled = false
    for (const item of parsed) {
      handled = emitClaudeEvent(item, emit) || handled
    }
    return handled
  }
  if (!isRecord(parsed)) return false

  const type = parsed['type']
  if (type !== 'assistant') {
    if (type === 'error') {
      emit('stderr', { text: summarizeValue(parsed['error'], 1_000) })
      return true
    }
    return false
  }

  const message = parsed['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return false

  let handled = false
  for (const block of message['content']) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      emit('text', { text: summarizeValue(block['text'], 8_000) })
      handled = true
      continue
    }
    if (block['type'] === 'tool_use') {
      emit('tool_call', {
        toolName: typeof block['name'] === 'string' ? block['name'] : 'tool',
        toolArgs: summarizeValue(block['input'], 1_000),
      })
      handled = true
    }
  }
  return handled
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function extractCodexThreadId(raw: string): string | null {
  for (const event of parseCodexEvents(raw)) {
    if (!isRecord(event)) continue
    if (isRecord(event['session']) && typeof event['session']['thread_id'] === 'string') {
      return event['session']['thread_id']
    }
    if (typeof event['thread_id'] === 'string') {
      return event['thread_id']
    }
  }
  return null
}

function parseCodexEvents(raw: string): unknown[] {
  const trimmed = raw.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  const out: unknown[] = []
  for (const line of trimmed.split('\n')) {
    const parsed = tryParseJson(line.trim())
    if (parsed) out.push(parsed)
  }
  return out
}

function extractClaudeSessionId(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = tryParseJson(trimmed)
  if (!parsed) return null

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!isRecord(item)) continue
      if (item['type'] === 'system' && isRecord(item['session']) && typeof item['session']['session_id'] === 'string') {
        return item['session']['session_id']
      }
      if (typeof item['session_id'] === 'string') {
        return item['session_id']
      }
    }
    return null
  }

  if (isRecord(parsed)) {
    if (typeof parsed['session_id'] === 'string') return parsed['session_id']
    if (isRecord(parsed['session']) && typeof parsed['session']['session_id'] === 'string') {
      return parsed['session']['session_id']
    }
  }
  return null
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const floor = Math.floor(value)
  if (floor < min) return min
  if (floor > max) return max
  return floor
}
