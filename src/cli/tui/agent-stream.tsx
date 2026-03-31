import React from 'react'
import { Box, Text } from 'ink'
import type Database from 'better-sqlite3'

interface AgentStreamProps {
  db: Database.Database
  tick: number
  maxLines?: number
}

interface ActiveRunRow {
  id: string
}

interface AgentEventRow {
  id: number
  run_id: string
  role: string
  event_type: string
  data: string | null
  created_at: string
}

const EVENT_COLORS: Record<string, 'gray' | 'cyan' | 'green' | 'yellow' | 'red' | 'magenta'> = {
  session_start: 'green',
  session_end: 'green',
  text: 'gray',
  tool_call: 'cyan',
  tool_result: 'magenta',
  thinking: 'yellow',
  turn_complete: 'yellow',
  error: 'red',
}

export function AgentStream({ db, tick: _tick, maxLines = 10 }: AgentStreamProps): React.ReactElement {
  const activeRun = db
    .prepare("SELECT id FROM runs WHERE status IN ('running', 'queued') ORDER BY updated_at DESC LIMIT 1")
    .get() as ActiveRunRow | undefined

  if (!activeRun) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Agent Activity</Text>
        <Text color="gray">  No live agent activity</Text>
      </Box>
    )
  }

  const rows = db
    .prepare(
      `SELECT id, run_id, role, event_type, data, created_at
       FROM agent_events
       WHERE run_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(activeRun.id, maxLines) as AgentEventRow[]
  const events = [...rows].reverse()

  const total = db
    .prepare('SELECT COUNT(*) as count FROM agent_events WHERE run_id = ?')
    .get(activeRun.id) as { count: number }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Agent Activity ({activeRun.id})</Text>
      {events.length === 0 && (
        <Text color="gray">  Waiting for agent events...</Text>
      )}
      {events.map((event) => {
        const color = EVENT_COLORS[event.event_type] ?? 'gray'
        return (
          <Text key={event.id}>
            {'  '}
            <Text color="gray">[{formatTime(event.created_at)}]</Text>
            {' '}
            <Text color="gray">{event.role}</Text>
            {' '}
            <Text color={color}>{event.event_type}</Text>
            {' '}
            <Text>{formatSummary(event)}</Text>
          </Text>
        )
      })}
      <Text color="gray">  streaming... {total.count} events</Text>
    </Box>
  )
}

function formatSummary(event: AgentEventRow): string {
  const data = parseEventData(event.data)
  if (!data) return ''

  if (event.event_type === 'tool_call') {
    const toolName = asString(data['toolName']) ?? 'tool'
    const args = asString(data['toolArgs'])
    return truncate(args ? `${toolName} ${args}` : toolName)
  }
  if (event.event_type === 'text' || event.event_type === 'thinking') {
    return truncate(asString(data['text']) ?? '')
  }
  if (event.event_type === 'error') {
    return truncate(asString(data['error']) ?? '')
  }
  if (event.event_type === 'turn_complete' && typeof data['tokenCount'] === 'number') {
    return `${data['tokenCount']} tokens`
  }
  if (event.event_type === 'session_start' || event.event_type === 'session_end') {
    const sessionId = asString(data['sessionId'])
    return sessionId ? `session ${sessionId}` : ''
  }
  return truncate(JSON.stringify(data))
}

function parseEventData(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return { raw: value }
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function truncate(value: string, maxLen = 64): string {
  if (value.length <= maxLen) return value
  return `${value.slice(0, maxLen - 3)}...`
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toISOString().slice(11, 19)
}
