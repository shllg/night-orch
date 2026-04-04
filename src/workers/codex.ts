import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { execWithTimeout } from './timeout.js'
import { streamingExec } from './streaming-exec.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { buildWorkerCommand } from './command.js'
import { logger } from '../utils/logger.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, unlink, mkdir } from 'node:fs/promises'
import { emitWorkerEvent, summarizeValue, isRecord } from './events.js'

export class CodexWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    // Use --output-last-message to reliably capture the final agent response,
    // since streaming JSONL events don't include sub-agent output.
    // Store outside worktree (in system tmpdir) to avoid polluting target repos.
    const outputDir = join(tmpdir(), 'night-orch-codex-output')
    await mkdir(outputDir, { recursive: true })
    const outputFile = join(outputDir, `codex-output-${randomUUID()}.txt`)

    const taskArgs = [...input.profile.args, '--output-last-message', outputFile]

    // Resume a prior session if available.
    // Newer Codex CLI expects: `codex exec resume <sessionId>`.
    if (input.continueSessionId) {
      const execIndex = taskArgs.indexOf('exec')
      if (execIndex >= 0) {
        taskArgs.splice(execIndex + 1, 0, 'resume', input.continueSessionId)
        logger.info({ role: input.role, sessionId: input.continueSessionId }, 'Resuming Codex session')
      } else {
        logger.warn(
          { role: input.role, sessionId: input.continueSessionId, args: input.profile.args },
          'Codex profile args missing "exec"; running without session resume',
        )
      }
    }
    const { command, args } = buildWorkerCommand(input.profile, taskArgs)

    logger.info(
      { role: input.role, cwd: input.worktreePath, timeout: input.timeoutSeconds },
      'Running Codex worker',
    )

    emitWorkerEvent(input, 'session_start', {
      agent: 'codex',
      continueSessionId: input.continueSessionId ?? null,
    })

    const result = await streamingExec({
      command,
      args,
      cwd: input.worktreePath,
      env: input.env,
      timeoutMs: input.timeoutSeconds * 1000,
      stdin: input.prompt,
      onStdoutLine: (line) => {
        emitCodexStreamEvents(line, input)
      },
    })

    if (result.timedOut) {
      logger.warn({ role: input.role, durationMs: result.durationMs }, 'Codex worker timed out')
      emitWorkerEvent(input, 'error', {
        error: `Codex worker timed out after ${input.timeoutSeconds}s`,
      })
    }

    // Read the final message from the output file (preferred),
    // fall back to extracting from streaming events if file missing
    let assistantText: string
    try {
      assistantText = await readFile(outputFile, 'utf-8')
      logger.info({ role: input.role, outputFileLength: assistantText.length }, 'Read Codex output from --output-last-message')
    } catch {
      logger.warn({ role: input.role }, 'Could not read --output-last-message file, falling back to stream extraction')
      assistantText = extractCodexOutput(result.stdout)
      if (assistantText !== result.stdout) {
        logger.info({ role: input.role, rawLength: result.stdout.length, extractedLength: assistantText.length }, 'Codex output extracted from stream')
      }
    } finally {
      unlink(outputFile).catch(() => {})
    }

    // Extract thread ID from Codex streaming events for session continuity
    const sessionId = extractCodexThreadId(result.stdout)
    const tokenUsage = extractCodexTokenUsage(result.stdout)

    // Parse output based on role
    const { parsed, parseError } = parseOutput(input.role, assistantText)

    if (result.stderr.trim().length > 0) {
      emitWorkerEvent(input, 'error', { error: summarizeValue(result.stderr, 400) })
    }

    emitWorkerEvent(input, 'session_end', {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      sessionId,
      tokenUsage,
    })

    return {
      rawOutput: result.stdout,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      parsed,
      parseError,
      sessionId,
      tokenUsage,
    }
  }

  async checkAvailability(): Promise<{ available: boolean; version: string | null }> {
    try {
      const result = await execWithTimeout('codex', ['--version'], {
        cwd: '.',
        env: { PATH: process.env['PATH'] ?? '' },
        timeoutMs: 5000,
      })
      if (result.exitCode === 0) {
        return { available: true, version: result.stdout.trim().split('\n')[0] ?? null }
      }
      return { available: false, version: null }
    } catch {
      return { available: false, version: null }
    }
  }
}

function emitCodexStreamEvents(line: string, input: WorkerTaskInput): void {
  const event = tryParseJson(line)
  if (!isRecord(event)) return
  const type = event['type']

  if (type === 'item.completed' && isRecord(event['item'])) {
    const item = event['item']
    if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
      emitWorkerEvent(input, 'text', { text: item['text'] })
      return
    }
    if ((item['type'] === 'function_call' || item['type'] === 'tool_call') && typeof item['name'] === 'string') {
      emitWorkerEvent(input, 'tool_call', {
        toolName: item['name'],
        toolArgs: summarizeValue(item['arguments'] ?? item['args']),
      })
      return
    }
    if (item['type'] === 'function_call_output' || item['type'] === 'tool_result') {
      emitWorkerEvent(input, 'tool_result', { text: summarizeValue(item['output'] ?? item['result']) })
      return
    }
    if (item['type'] === 'reasoning' && typeof item['text'] === 'string') {
      emitWorkerEvent(input, 'thinking', { text: item['text'] })
    }
    return
  }

  if (type === 'function_call') {
    emitWorkerEvent(input, 'tool_call', {
      toolName: typeof event['name'] === 'string' ? event['name'] : 'tool',
      toolArgs: summarizeValue(event['arguments'] ?? event['args']),
    })
    return
  }

  if (type === 'error') {
    emitWorkerEvent(input, 'error', { error: summarizeValue(event['error']) })
    return
  }

  if (type === 'response.completed' || type === 'turn.completed') {
    const usage = event['usage']
    if (!isRecord(usage)) return
    const outputTokens = usage['output_tokens']
    if (typeof outputTokens === 'number') {
      emitWorkerEvent(input, 'turn_complete', { tokenCount: outputTokens })
    }
  }
}

/**
 * Codex CLI outputs streaming events in two possible formats:
 * 1. A JSON array: [{...}, {...}, ...]
 * 2. Newline-delimited JSON (NDJSON): {...}\n{...}\n...
 *
 * Agent text is in events where type === "item.completed" and
 * item.type === "agent_message", with text in item.text.
 *
 * Also handles the "message" event type with content array containing
 * text entries.
 */
export function extractCodexOutput(raw: string): string {
  const events = parseCodexEvents(raw)
  if (events.length === 0) return raw

  const textParts: string[] = []

  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const e = event as Record<string, unknown>

    // Format: { type: "item.completed", item: { type: "agent_message", text: "..." } }
    if (e.type === 'item.completed' && typeof e.item === 'object' && e.item !== null) {
      const item = e.item as Record<string, unknown>
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        textParts.push(item.text)
      }
    }

    // Format: { type: "message", content: [{ type: "text", text: "..." }] }
    if (e.type === 'message' && Array.isArray(e.content)) {
      for (const block of e.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text)
        }
      }
    }
  }

  if (textParts.length > 0) return textParts.join('\n')
  return raw
}

/** Parse Codex output as either a JSON array or NDJSON. */
function parseCodexEvents(raw: string): unknown[] {
  const trimmed = raw.trim()

  // Try JSON array first (starts with [)
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Might be truncated array — fall through to NDJSON
    }
  }

  // Try NDJSON (one JSON object per line)
  const events: unknown[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      events.push(JSON.parse(t))
    } catch {
      // Not JSON — skip
    }
  }

  return events
}

function extractCodexTokenUsage(raw: string): WorkerTaskResult['tokenUsage'] {
  const events = parseCodexEvents(raw)
  if (events.length === 0) return undefined

  const fromResponseCompleted = sumUsageForEventType(events, 'response.completed')
  const totals = fromResponseCompleted.seen
    ? fromResponseCompleted
    : sumUsageForEventType(events, 'turn.completed')

  if (totals.promptTokens <= 0 && totals.completionTokens <= 0) return undefined
  return {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
  }
}

function sumUsageForEventType(
  events: unknown[],
  expectedType: string,
): { seen: boolean; promptTokens: number; completionTokens: number } {
  let promptTokens = 0
  let completionTokens = 0
  let seen = false

  for (const event of events) {
    if (!isRecord(event)) continue
    if (event['type'] !== expectedType) continue
    const usage = extractUsageFromCodexEvent(event)
    if (usage.promptTokens <= 0 && usage.completionTokens <= 0) continue
    seen = true
    promptTokens += usage.promptTokens
    completionTokens += usage.completionTokens
  }

  return { seen, promptTokens, completionTokens }
}

function extractUsageFromCodexEvent(event: Record<string, unknown>): {
  promptTokens: number
  completionTokens: number
} {
  const directUsage = event['usage']
  if (isRecord(directUsage)) {
    return {
      promptTokens: parseTokenCount(directUsage['input_tokens']),
      completionTokens: parseTokenCount(directUsage['output_tokens']),
    }
  }

  const response = event['response']
  if (isRecord(response) && isRecord(response['usage'])) {
    return {
      promptTokens: parseTokenCount(response['usage']['input_tokens']),
      completionTokens: parseTokenCount(response['usage']['output_tokens']),
    }
  }

  return { promptTokens: 0, completionTokens: 0 }
}

/**
 * Extract a thread/session ID from Codex streaming events.
 * Codex emits thread_id in session-related events.
 */
function extractCodexThreadId(raw: string): string | null {
  const events = parseCodexEvents(raw)
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const e = event as Record<string, unknown>
    // Look for thread_id in various event shapes
    if (typeof e['thread_id'] === 'string') return e['thread_id']
    if (typeof e['id'] === 'string' && e['object'] === 'thread') return e['id']
    if (isRecord(e['session']) && typeof e['session']['thread_id'] === 'string') {
      return e['session']['thread_id']
    }
  }
  return null
}

function tryParseJson(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function parseTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function parseOutput(role: string, raw: string): { parsed: WorkerTaskResult['parsed']; parseError: string | null } {
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
