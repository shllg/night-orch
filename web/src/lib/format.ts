import { type RunEvent, type RunSummary } from '../types/dashboard.js'

export function extractMessage(payload: Record<string, unknown>): string | null {
  const direct = payload['message']
  if (typeof direct === 'string' && direct.trim()) {
    return direct
  }

  const reason = payload['reason']
  if (typeof reason === 'string' && reason.trim()) {
    return reason
  }

  return null
}

export function formatMoney(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

export function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function formatRunTime(run: RunSummary): string {
  if (run.endedAt) {
    return `Ended ${formatTimestamp(run.endedAt)}`
  }
  if (run.startedAt) {
    return `Started ${formatTimestamp(run.startedAt)}`
  }
  return 'Not started'
}

export function describeEventData(data: RunEvent['data']): string {
  if (!data) return 'No payload'

  if (typeof data['text'] === 'string' && data['text'].trim()) {
    return truncate(data['text'], 220)
  }

  if (typeof data['toolName'] === 'string') {
    return `Tool: ${data['toolName']}`
  }

  if (typeof data['error'] === 'string') {
    return truncate(data['error'], 220)
  }

  try {
    return truncate(JSON.stringify(data), 220)
  } catch {
    return 'Unserializable event payload'
  }
}

export function describeRunEvent(event: RunEvent): string {
  if (event.source === 'user' && event.type === 'user_action') {
    const kind = typeof event.data?.['kind'] === 'string' ? event.data['kind'] : 'action'
    const strategy = typeof event.data?.['strategy'] === 'string' ? ` (${event.data['strategy']})` : ''
    const actor = typeof event.data?.['actor'] === 'string' ? ` by ${event.data['actor']}` : ''
    return `${kind}${strategy}${actor}`
  }

  const phase = event.phase ?? '-'
  const role = event.role ?? event.source
  const detail = describeEventData(event.data)
  return `${phase}/${role} ${event.type} ${detail}`.trim()
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3)}...`
}
