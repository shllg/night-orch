import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { execWithTimeout } from './timeout.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { buildWorkerCommand } from './command.js'
import { logger } from '../utils/logger.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, unlink, mkdir } from 'node:fs/promises'

export class CodexWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    // Use --output-last-message to reliably capture the final agent response,
    // since streaming JSONL events don't include sub-agent output.
    // Store outside worktree (in system tmpdir) to avoid polluting target repos.
    const outputDir = join(tmpdir(), 'night-orch-codex-output')
    await mkdir(outputDir, { recursive: true })
    const outputFile = join(outputDir, `codex-output-${randomUUID()}.txt`)

    const taskArgs = [...input.profile.args, '--output-last-message', outputFile]

    // Resume a prior session if available
    if (input.continueSessionId) {
      taskArgs.push('--resume', input.continueSessionId)
      logger.info({ role: input.role, sessionId: input.continueSessionId }, 'Resuming Codex session')
    }
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

    // Parse output based on role
    const { parsed, parseError } = parseOutput(input.role, assistantText)

    return {
      rawOutput: result.stdout,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      parsed,
      parseError,
      sessionId,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
