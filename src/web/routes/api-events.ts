import { WebSocket } from 'ws'
import type { MCPDependencies } from '../../mcp/server.js'
import { handleToolCall } from '../../mcp/tools/index.js'
import type {
  InteractiveAgentSessionManager,
  InteractiveAgentSessionEventList,
} from '../agent-session.js'
import type {
  ShellSessionManager,
  ShellSessionEventList,
} from '../shell-session.js'
import type { WsClientState, WebSocketCommand } from '../server.js'
import { sendWebsocket } from '../server.js'
import { buildDashboardSnapshot } from '../snapshots.js'

export async function handleWsMessage(
  ws: WebSocket,
  state: WsClientState,
  rawMessage: string,
  deps: MCPDependencies,
  agentSessionManager: InteractiveAgentSessionManager,
  shellSessionManager: ShellSessionManager,
): Promise<void> {
  let command: WebSocketCommand
  try {
    command = JSON.parse(rawMessage) as WebSocketCommand
  } catch {
    sendWebsocket(ws, { type: 'error', error: 'Invalid JSON message' })
    return
  }

  if (!ensureWebSocketShellAuthorized(ws, state, command.type)) {
    return
  }

  if (command.type === 'subscribe-run-events') {
    const runId = typeof command.runId === 'string' ? command.runId : ''
    if (!runId) {
      sendWebsocket(ws, { type: 'error', error: 'runId is required for subscribe-run-events' })
      return
    }

    const cursor = Number.isFinite(command.since) ? Math.max(0, Math.floor(command.since ?? 0)) : 0
    state.runSubscriptions.set(runId, cursor)
    sendWebsocket(ws, { type: 'subscribed', payload: { runId, since: cursor } })
    return
  }

  if (command.type === 'unsubscribe-run-events') {
    const runId = typeof command.runId === 'string' ? command.runId : ''
    if (!runId) {
      sendWebsocket(ws, { type: 'error', error: 'runId is required for unsubscribe-run-events' })
      return
    }

    state.runSubscriptions.delete(runId)
    sendWebsocket(ws, { type: 'unsubscribed', payload: { runId } })
    return
  }

  if (command.type === 'subscribe-agent-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for subscribe-agent-session-events' })
      return
    }

    const cursor = Number.isFinite(command.since) ? Math.max(0, Math.floor(command.since ?? 0)) : 0
    state.agentSessionSubscriptions.set(sessionId, cursor)
    sendWebsocket(ws, { type: 'subscribed', payload: { sessionId, since: cursor } })
    publishAgentSessionSubscriptions(ws, state, agentSessionManager)
    return
  }

  if (command.type === 'unsubscribe-agent-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for unsubscribe-agent-session-events' })
      return
    }

    state.agentSessionSubscriptions.delete(sessionId)
    sendWebsocket(ws, { type: 'unsubscribed', payload: { sessionId } })
    return
  }

  if (command.type === 'subscribe-shell-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for subscribe-shell-session-events' })
      return
    }

    const cursor = Number.isFinite(command.since) ? Math.max(0, Math.floor(command.since ?? 0)) : 0
    state.shellSessionSubscriptions.set(sessionId, cursor)
    sendWebsocket(ws, { type: 'subscribed', payload: { sessionId, since: cursor } })
    publishShellSessionSubscriptions(ws, state, shellSessionManager)
    return
  }

  if (command.type === 'unsubscribe-shell-session-events') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for unsubscribe-shell-session-events' })
      return
    }

    state.shellSessionSubscriptions.delete(sessionId)
    sendWebsocket(ws, { type: 'unsubscribed', payload: { sessionId } })
    return
  }

  if (command.type === 'shell-input') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    const data = typeof command.data === 'string' ? command.data : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for shell-input' })
      return
    }
    if (!data) {
      sendWebsocket(ws, { type: 'error', error: 'data is required for shell-input' })
      return
    }
    try {
      shellSessionManager.writeInput(sessionId, data)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to write shell input for ${sessionId}: ${(err as Error).message}`,
      })
    }
    return
  }

  if (command.type === 'shell-resize') {
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!sessionId) {
      sendWebsocket(ws, { type: 'error', error: 'sessionId is required for shell-resize' })
      return
    }

    const cols = typeof command.cols === 'number' ? command.cols : NaN
    const rows = typeof command.rows === 'number' ? command.rows : NaN
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      sendWebsocket(ws, { type: 'error', error: 'cols and rows are required for shell-resize' })
      return
    }
    try {
      shellSessionManager.resize(sessionId, cols, rows)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to resize shell session ${sessionId}: ${(err as Error).message}`,
      })
    }
    return
  }

  if (command.type === 'refresh') {
    const snapshot = await buildDashboardSnapshot(deps)
    sendWebsocket(ws, { type: 'snapshot', payload: snapshot })
    return
  }

  sendWebsocket(ws, { type: 'error', error: 'Unknown command type' })
}

export async function publishRunSubscriptions(
  ws: WebSocket,
  state: WsClientState,
  deps: MCPDependencies,
): Promise<void> {
  for (const [runId, since] of state.runSubscriptions.entries()) {
    try {
      const result = await handleToolCall(
        'night-orch-stream-events',
        { runId, since, limit: 200 },
        deps,
      )

      const eventPayload = toRunEventPayload(result)
      if (!eventPayload) {
        continue
      }

      state.runSubscriptions.set(runId, eventPayload.lastEventId)

      if (eventPayload.events.length === 0) {
        continue
      }

      sendWebsocket(ws, {
        type: 'run-events',
        payload: {
          runId,
          events: eventPayload.events,
          lastEventId: eventPayload.lastEventId,
        },
      })
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to stream events for ${runId}: ${(err as Error).message}`,
      })
    }
  }
}

export function publishAgentSessionSubscriptions(
  ws: WebSocket,
  state: WsClientState,
  manager: InteractiveAgentSessionManager,
): void {
  for (const [sessionId, since] of state.agentSessionSubscriptions.entries()) {
    let result: InteractiveAgentSessionEventList
    try {
      result = manager.getEvents(sessionId, since, 200)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to stream agent-session events for ${sessionId}: ${(err as Error).message}`,
      })
      continue
    }

    state.agentSessionSubscriptions.set(sessionId, result.lastEventId)

    if (result.events.length === 0) {
      continue
    }

    sendWebsocket(ws, {
      type: 'agent-session-events',
      payload: {
        sessionId,
        status: result.status,
        events: result.events,
        lastEventId: result.lastEventId,
      },
    })
  }
}

export function publishShellSessionSubscriptions(
  ws: WebSocket,
  state: WsClientState,
  manager: ShellSessionManager,
): void {
  for (const [sessionId, since] of state.shellSessionSubscriptions.entries()) {
    let result: ShellSessionEventList
    try {
      result = manager.getEvents(sessionId, since, 500)
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to stream shell-session events for ${sessionId}: ${(err as Error).message}`,
      })
      continue
    }

    state.shellSessionSubscriptions.set(sessionId, result.lastEventId)

    if (result.events.length === 0) {
      continue
    }

    sendWebsocket(ws, {
      type: 'shell-session-events',
      payload: {
        sessionId,
        status: result.status,
        events: result.events,
        lastEventId: result.lastEventId,
      },
    })
  }
}

function requiresWebSocketShellAuth(commandType: WebSocketCommand['type']): boolean {
  return commandType === 'subscribe-shell-session-events'
    || commandType === 'unsubscribe-shell-session-events'
    || commandType === 'shell-input'
    || commandType === 'shell-resize'
}

function ensureWebSocketShellAuthorized(
  ws: WebSocket,
  state: WsClientState,
  commandType: WebSocketCommand['type'],
): boolean {
  if (!requiresWebSocketShellAuth(commandType)) {
    return true
  }

  if (state.isAuthenticated) {
    return true
  }

  sendWebsocket(ws, {
    type: 'error',
    error: `Unauthorized websocket command: ${commandType}`,
  })
  return false
}

function toRunEventPayload(input: unknown): { events: unknown[]; lastEventId: number } | null {
  if (!input || typeof input !== 'object') return null

  const maybeEvents = (input as { events?: unknown }).events
  const maybeLastEventId = (input as { lastEventId?: unknown }).lastEventId

  if (!Array.isArray(maybeEvents)) return null
  if (typeof maybeLastEventId !== 'number' || !Number.isFinite(maybeLastEventId)) return null

  return {
    events: maybeEvents,
    lastEventId: Math.max(0, Math.floor(maybeLastEventId)),
  }
}
