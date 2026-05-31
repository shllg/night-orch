import type { WorkerTaskResult } from '../types.js'
import { isRecord } from '../events.js'
import { parsePlannerOutput } from './planner.js'
import { parseCoderOutput } from './coder.js'
import { parseReviewerOutput } from './reviewer.js'

export function parseOutput(
  role: string,
  raw: string,
): { parsed: WorkerTaskResult['parsed']; parseError: string | null } {
  switch (role) {
    case 'planner': {
      const { result, error } = parsePlannerOutput(raw)
      return { parsed: result, parseError: error }
    }
    case 'coder': {
      const { result, error } = parseCoderOutput(raw)
      return { parsed: result, parseError: error }
    }
    case 'reviewer': {
      const { result, error } = parseReviewerOutput(raw)
      return { parsed: result, parseError: error }
    }
    default:
      return { parsed: null, parseError: `Unknown role: ${role}` }
  }
}

export function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export function parseTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/**
 * Codex CLI outputs streaming events as either a JSON array or newline-delimited JSON.
 */
export function parseCodexEvents(raw: string): unknown[] {
  const trimmed = raw.trim()

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to line-by-line parsing.
    }
  }

  const events: unknown[] = []
  for (const line of raw.split('\n')) {
    const parsed = tryParseJson(line)
    if (parsed) events.push(parsed)
  }
  return events
}

export function extractCodexOutput(raw: string): string {
  const events = parseCodexEvents(raw)
  if (events.length === 0) return raw

  const textParts: string[] = []

  for (const event of events) {
    if (!isRecord(event)) continue

    if (event['type'] === 'item.completed' && isRecord(event['item'])) {
      const item = event['item']
      if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
        textParts.push(item['text'])
      }
    }

    if (event['type'] === 'message' && Array.isArray(event['content'])) {
      for (const block of event['content']) {
        if (!isRecord(block)) continue
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          textParts.push(block['text'])
        }
      }
    }
  }

  return textParts.length > 0 ? textParts.join('\n') : raw
}

export function extractCodexThreadId(raw: string): string | null {
  const events = parseCodexEvents(raw)
  for (const event of events) {
    if (!isRecord(event)) continue
    if (typeof event['thread_id'] === 'string') return event['thread_id']
    if (typeof event['id'] === 'string' && event['object'] === 'thread') return event['id']
    if (isRecord(event['session']) && typeof event['session']['thread_id'] === 'string') {
      return event['session']['thread_id']
    }
  }
  return null
}

export function extractCodexTokenUsage(raw: string): WorkerTaskResult['tokenUsage'] {
  const events = parseCodexEvents(raw)
  if (events.length === 0) return undefined

  const fromResponseCompleted = sumUsageForEventType(events, 'response.completed')
  const totals = fromResponseCompleted.seen
    ? fromResponseCompleted
    : sumUsageForEventType(events, 'turn.completed')

  if (totals.promptTokens <= 0 && totals.completionTokens <= 0 && totals.cacheReadTokens <= 0) return undefined
  return {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    ...(totals.cacheReadTokens > 0 ? { cacheReadTokens: totals.cacheReadTokens } : {}),
  }
}

function sumUsageForEventType(events: unknown[], expectedType: string): {
  seen: boolean
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
} {
  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens = 0
  let seen = false

  for (const event of events) {
    if (!isRecord(event)) continue
    if (event['type'] !== expectedType) continue
    const usage = extractUsageFromCodexEvent(event)
    if (usage.promptTokens <= 0 && usage.completionTokens <= 0 && usage.cacheReadTokens <= 0) continue
    seen = true
    promptTokens += usage.promptTokens
    completionTokens += usage.completionTokens
    cacheReadTokens += usage.cacheReadTokens
  }

  return { seen, promptTokens, completionTokens, cacheReadTokens }
}

function extractUsageFromCodexEvent(event: Record<string, unknown>): {
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
} {
  const directUsage = event['usage']
  if (isRecord(directUsage)) {
    return {
      promptTokens: parseTokenCount(directUsage['input_tokens']),
      completionTokens: parseTokenCount(directUsage['output_tokens']),
      cacheReadTokens: parseTokenCount(directUsage['cache_read_input_tokens']),
    }
  }

  const response = event['response']
  if (isRecord(response) && isRecord(response['usage'])) {
    return {
      promptTokens: parseTokenCount(response['usage']['input_tokens']),
      completionTokens: parseTokenCount(response['usage']['output_tokens']),
      cacheReadTokens: parseTokenCount(response['usage']['cache_read_input_tokens']),
    }
  }

  return { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 }
}

export function extractClaudeTokenUsage(raw: string): WorkerTaskResult['tokenUsage'] {
  const parsed = tryParseJson(raw)
  if (!parsed) return undefined

  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens = 0

  const addUsage = (usageCandidate: unknown) => {
    if (!isRecord(usageCandidate)) return
    const inputTokens = parseTokenCount(usageCandidate['input_tokens'])
      + parseTokenCount(usageCandidate['cache_creation_input_tokens'])
    const cacheRead = parseTokenCount(usageCandidate['cache_read_input_tokens'])
    const outputTokens = parseTokenCount(usageCandidate['output_tokens'])
    promptTokens += inputTokens
    cacheReadTokens += cacheRead
    completionTokens += outputTokens
  }

  if (Array.isArray(parsed)) {
    for (const event of parsed) {
      if (!isRecord(event)) continue
      if (event['type'] !== 'result') continue
      addUsage(event['usage'])
    }
  } else if (isRecord(parsed) && parsed['type'] === 'result') {
    addUsage(parsed['usage'])
  }

  if (promptTokens <= 0 && completionTokens <= 0 && cacheReadTokens <= 0) return undefined
  return {
    promptTokens,
    completionTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  }
}
