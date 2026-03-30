import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { execWithTimeout } from './timeout.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { buildWorkerCommand } from './command.js'
import { logger } from '../utils/logger.js'

export class ClaudeWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    const maxTurns = '50'
    const taskArgs = [
      ...input.profile.args,
      '--output-format', 'json',
      '--max-turns', maxTurns,
    ]

    // Continue from a prior session if available
    if (input.continueSessionId) {
      taskArgs.push('--continue', input.continueSessionId)
      logger.info({ role: input.role, sessionId: input.continueSessionId }, 'Continuing Claude session')
    }

    const { command, args } = buildWorkerCommand(input.profile, taskArgs)

    logger.info(
      { role: input.role, cwd: input.worktreePath, timeout: input.timeoutSeconds },
      'Running Claude worker',
    )

    const result = await execWithTimeout(command, args, {
      cwd: input.worktreePath,
      env: input.env,
      timeoutMs: input.timeoutSeconds * 1000,
      stdin: input.prompt,
    })

    if (result.timedOut) {
      logger.warn({ role: input.role, durationMs: result.durationMs }, 'Claude worker timed out')
    }

    // With --output-format json, extract assistant text and session ID from the JSON envelope.
    // Fall back to raw text if not parseable as JSON.
    const { assistantText, sessionId } = extractFromJsonOutput(result.stdout)

    logger.info({ role: input.role, rawLength: result.stdout.length, textLength: assistantText.length, sessionId }, 'Claude output received')

    if (result.stdout.length === 0 && result.stderr.length > 0) {
      logger.warn({ role: input.role, stderrTail: result.stderr.slice(-1000) }, 'Claude produced no stdout — stderr may contain error details')
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
      sessionId,
    }
  }

  async checkAvailability(): Promise<{ available: boolean; version: string | null }> {
    try {
      const result = await execWithTimeout('claude', ['--version'], {
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
 * Extract assistant text and session ID from Claude's JSON output format.
 * The JSON output is an array of streaming events or a result envelope.
 *
 * Falls back to treating the raw string as the assistant text if not parseable.
 */
function extractFromJsonOutput(raw: string): { assistantText: string; sessionId: string | null } {
  const trimmed = raw.trimStart()

  // If it doesn't look like JSON, treat as raw text
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return { assistantText: raw, sessionId: null }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    let sessionId: string | null = null
    const textParts: string[] = []

    // Streaming format: array of event objects
    if (Array.isArray(parsed)) {
      for (const event of parsed) {
        if (!isRecord(event)) continue
        const eventType = event['type']

        // Extract session ID from init or result events
        if (eventType === 'system' && isRecord(event['session'])) {
          const sid = event['session']['session_id']
          if (typeof sid === 'string') sessionId = sid
        }

        // assistant message events contain content blocks with text
        if (eventType === 'assistant') {
          const message = event['message']
          if (isRecord(message) && Array.isArray(message['content'])) {
            for (const block of message['content']) {
              const text = getTextBlock(block)
              if (text) textParts.push(text)
            }
          }
        }

        // result message at the end — also may contain session_id
        if (eventType === 'result') {
          const result = event['result']
          if (Array.isArray(result)) {
            for (const block of result) {
              const text = getTextBlock(block)
              if (text) textParts.push(text)
            }
          }
          if (typeof result === 'string') {
            textParts.push(result)
          }
          // Session ID can appear at the result level
          const sid = event['session_id']
          if (typeof sid === 'string') sessionId = sid
        }
      }
      if (textParts.length > 0) {
        return { assistantText: textParts.join('\n'), sessionId }
      }
    }

    // Single object envelope: { result: "...", session_id: "..." }
    if (isRecord(parsed)) {
      const result = parsed['result']
      const sid = parsed['session_id']
      if (typeof sid === 'string') sessionId = sid
      if (typeof result === 'string') return { assistantText: result, sessionId }
    }
  } catch {
    // Not JSON — fall through
  }

  return { assistantText: raw, sessionId: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getTextBlock(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (value['type'] !== 'text') return null
  const text = value['text']
  return typeof text === 'string' ? text : null
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
