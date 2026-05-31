import type { WebSocket } from 'ws'
import type { MCPDependencies } from '../../mcp/server.js'
import { handleToolCall } from '../../mcp/tools/index.js'
import type {
  InteractiveAgentSessionManager,
  InteractiveAgentSessionEventList,
} from '../agent-session.js'
import type { WsClientState, WebSocketCommand } from '../server.js'
import { sendWebsocket } from '../server.js'
import { buildDashboardSnapshot } from '../snapshots.js'
import { z } from 'zod'

const WebSocketCommandSchema: z.ZodType<WebSocketCommand> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe-run-events'),
    runId: z.string(),
    since: z.number().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('unsubscribe-run-events'),
    runId: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal('subscribe-issue-events'),
    repo: z.string(),
    issueNumber: z.number(),
    since: z.number().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('unsubscribe-issue-events'),
    repo: z.string(),
    issueNumber: z.number(),
  }).passthrough(),
  z.object({
    type: z.literal('subscribe-agent-session-events'),
    sessionId: z.string(),
    since: z.number().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('unsubscribe-agent-session-events'),
    sessionId: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal('refresh'),
  }).passthrough(),
])

export async function handleWsMessage(
  ws: WebSocket,
  state: WsClientState,
  rawMessage: string,
  deps: MCPDependencies,
  agentSessionManager: InteractiveAgentSessionManager,
): Promise<void> {
  let parsedMessage: unknown
  try {
    parsedMessage = JSON.parse(rawMessage)
  } catch {
    sendWebsocket(ws, { type: 'error', error: 'Invalid JSON message' })
    return
  }

  const parsedCommand = WebSocketCommandSchema.safeParse(parsedMessage)
  if (!parsedCommand.success) {
    sendWebsocket(ws, { type: 'error', error: 'Invalid websocket command payload' })
    return
  }

  const command = parsedCommand.data

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

  if (command.type === 'subscribe-issue-events') {
    const repo = typeof command.repo === 'string' ? command.repo.trim() : ''
    const issueNumber = typeof command.issueNumber === 'number' ? command.issueNumber : Number.NaN
    if (!repo || !Number.isInteger(issueNumber) || issueNumber < 1) {
      sendWebsocket(ws, { type: 'error', error: 'repo and issueNumber are required for subscribe-issue-events' })
      return
    }

    const cursor = Number.isFinite(command.since) ? Math.max(0, Math.floor(command.since ?? 0)) : 0
    state.issueSubscriptions.set(`${repo}#${issueNumber}`, { repo, issueNumber, since: cursor })
    sendWebsocket(ws, { type: 'subscribed', payload: { repo, issueNumber, since: cursor } })
    return
  }

  if (command.type === 'unsubscribe-issue-events') {
    const repo = typeof command.repo === 'string' ? command.repo.trim() : ''
    const issueNumber = typeof command.issueNumber === 'number' ? command.issueNumber : Number.NaN
    if (!repo || !Number.isInteger(issueNumber) || issueNumber < 1) {
      sendWebsocket(ws, { type: 'error', error: 'repo and issueNumber are required for unsubscribe-issue-events' })
      return
    }

    state.issueSubscriptions.delete(`${repo}#${issueNumber}`)
    sendWebsocket(ws, { type: 'unsubscribed', payload: { repo, issueNumber } })
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

export async function publishIssueSubscriptions(
  ws: WebSocket,
  state: WsClientState,
  deps: MCPDependencies,
): Promise<void> {
  for (const [subscriptionKey, subscription] of state.issueSubscriptions.entries()) {
    try {
      const result = await handleToolCall(
        'night-orch-stream-events',
        { repo: subscription.repo, issueNumber: subscription.issueNumber, since: subscription.since, limit: 200 },
        deps,
      )

      const eventPayload = toRunEventPayload(result)
      if (!eventPayload) {
        continue
      }

      state.issueSubscriptions.set(subscriptionKey, {
        ...subscription,
        since: eventPayload.lastEventId,
      })

      if (eventPayload.events.length === 0) {
        continue
      }

      sendWebsocket(ws, {
        type: 'issue-events',
        payload: {
          repo: subscription.repo,
          issueNumber: subscription.issueNumber,
          events: eventPayload.events,
          lastEventId: eventPayload.lastEventId,
        },
      })
    } catch (err) {
      sendWebsocket(ws, {
        type: 'error',
        error: `Failed to stream events for ${subscription.repo}#${subscription.issueNumber}: ${(err as Error).message}`,
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
