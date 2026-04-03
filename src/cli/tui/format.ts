import type { StatusAggregate } from '../../state/stats.js'
import { formatUtcClock } from '../../utils/time.js'
import type { AgentEventRow } from './data.js'
import type { TuiLogLine } from './types.js'

export function formatStatusMix(statuses: StatusAggregate[]): string {
  if (statuses.length === 0) return '-'
  return statuses.map((row) => `${row.status}:${row.count}`).join('  ')
}

export function formatEventSummary(event: AgentEventRow): string {
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

export function truncate(value: string, maxLen = 72): string {
  if (value.length <= maxLen) return value
  return `${value.slice(0, maxLen - 3)}...`
}

export function formatTime(timestamp: string): string {
  return formatUtcClock(timestamp)
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '-'
  if (minutes < 1) return `${Math.round(minutes * 60)}s`
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  const hours = Math.floor(minutes / 60)
  const mins = Math.round(minutes % 60)
  return `${hours}h${String(mins).padStart(2, '0')}m`
}

export function formatPrList(prNumbersRaw: string): string {
  try {
    const parsed: unknown = JSON.parse(prNumbersRaw)
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value)).join(', ')
    }
    return '-'
  } catch {
    return '-'
  }
}

export function formatLogLine(line: TuiLogLine, maxLen = 180): string {
  const prefix = `${formatTime(line.createdAt)} ${line.level.toUpperCase().padEnd(5)}`
  return `${prefix} ${truncate(line.message, maxLen)}`
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
