import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { execWithTimeout } from './timeout.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { buildWorkerCommand } from './command.js'
import { logger } from '../utils/logger.js'

export class CodexWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    const taskArgs = [...input.profile.args]
    const { command, args } = buildWorkerCommand(input.profile, taskArgs)

    logger.info(
      { role: input.role, cwd: input.worktreePath, timeout: input.timeoutSeconds },
      'Running Codex worker',
    )

    const result = await execWithTimeout(command, args, {
      cwd: input.worktreePath,
      env: input.env,
      timeoutMs: input.timeoutSeconds * 1000,
      stdin: input.prompt,
    })

    if (result.timedOut) {
      logger.warn({ role: input.role, durationMs: result.durationMs }, 'Codex worker timed out')
    }

    // Extract text from Codex streaming event format
    const assistantText = extractCodexOutput(result.stdout)
    const extracted = assistantText !== result.stdout
    if (extracted) {
      logger.info({ role: input.role, rawLength: result.stdout.length, extractedLength: assistantText.length }, 'Codex output extraction')
    }

    // Parse output based on role
    const { parsed, parseError } = parseOutput(input.role, assistantText)

    return {
      rawOutput: result.stdout,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      parsed,
      parseError,
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
      const parsed = JSON.parse(trimmed)
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
