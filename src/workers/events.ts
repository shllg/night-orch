import type { AgentEventType } from '../events/types.js'
import type { WorkerTaskInput } from './types.js'

export function emitWorkerEvent(
  input: WorkerTaskInput,
  type: AgentEventType,
  data: Record<string, unknown> = {},
): void {
  input.onEvent?.({
    runId: input.runId ?? 'unknown-run',
    phase: input.phase ?? 'unknown-phase',
    role: input.role,
    type,
    timestamp: new Date().toISOString(),
    data,
  })
}

export function summarizeValue(value: unknown, maxLen = 240): string {
  if (typeof value === 'string') return truncate(value, maxLen)
  try {
    return truncate(JSON.stringify(value), maxLen)
  } catch {
    return truncate(String(value), maxLen)
  }
}

export function truncate(value: string, maxLen = 240): string {
  if (value.length <= maxLen) return value
  return `${value.slice(0, maxLen - 3)}...`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
