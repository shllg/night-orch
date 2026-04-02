import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { execWithTimeout } from './timeout.js'
import { streamingExec } from './streaming-exec.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { buildWorkerCommand } from './command.js'
import { normalizePathForSubprocess } from './env.js'
import { logger } from '../utils/logger.js'
import { emitWorkerEvent, isRecord, summarizeValue } from './events.js'

export class ClaudeWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    const maxTurns = '50'
    const taskArgs = [
      ...input.profile.args,
      '--output-format', 'json',
      '--max-turns', maxTurns,
      '--append-system-prompt', 'IMPORTANT: Do NOT use plan mode. Do NOT call EnterPlanMode. Output everything directly in your response. Do NOT write files to ~/.claude/plans/.',
    ]
    if (!hasExplicitPermissionMode(input.profile.args)) {
      taskArgs.push('--permission-mode', resolveDefaultPermissionMode())
    }

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

    emitWorkerEvent(input, 'session_start', {
      agent: 'claude',
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
        emitClaudeStreamEvents(line, input)
      },
    })

    if (result.timedOut) {
      logger.warn({ role: input.role, durationMs: result.durationMs }, 'Claude worker timed out')
      emitWorkerEvent(input, 'error', {
        error: `Claude worker timed out after ${input.timeoutSeconds}s`,
      })
    }

    // With --output-format json, extract assistant text and session ID from the JSON envelope.
    // Fall back to raw text if not parseable as JSON.
    const { assistantText, sessionId } = extractFromJsonOutput(result.stdout)

    logger.info({ role: input.role, rawLength: result.stdout.length, textLength: assistantText.length, sessionId }, 'Claude output received')

    if (result.stdout.length === 0 && result.stderr.length > 0) {
      logger.warn({ role: input.role, stderrTail: result.stderr.slice(-1000) }, 'Claude produced no stdout — stderr may contain error details')
    }

    if (result.stderr.trim().length > 0) {
      emitWorkerEvent(input, 'error', { error: summarizeValue(result.stderr, 400) })
    }

    // Parse output based on role
    const { parsed, parseError } = parseOutput(input.role, assistantText)

    emitWorkerEvent(input, 'session_end', {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      sessionId,
    })

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
        env: { PATH: normalizePathForSubprocess(process.env['PATH'], process.env['HOME']) },
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

function hasExplicitPermissionMode(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) return true
    if (arg === '--dangerously-skip-permissions') return true
    if (arg === '--allow-dangerously-skip-permissions') return true
  }
  return false
}

function resolveDefaultPermissionMode(): 'acceptEdits' | 'bypassPermissions' {
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return 'acceptEdits'
    }
  } catch {
    // Ignore and fall back to non-root default.
  }
  return 'bypassPermissions'
}

function emitClaudeStreamEvents(line: string, input: WorkerTaskInput): void {
  const parsed = tryParseJson(line)
  if (!parsed) return

  if (Array.isArray(parsed)) {
    for (const event of parsed) {
      if (!isRecord(event)) continue
      emitClaudeEvent(event, input)
    }
    return
  }

  if (!isRecord(parsed)) return
  emitClaudeEvent(parsed, input)
}

function emitClaudeEvent(event: Record<string, unknown>, input: WorkerTaskInput): void {
  const eventType = event['type']
  if (eventType === 'system' && isRecord(event['session'])) {
    const sid = event['session']['session_id']
    if (typeof sid === 'string') {
      emitWorkerEvent(input, 'session_start', { sessionId: sid, agent: 'claude' })
    }
    return
  }

  if (eventType === 'assistant') {
    const message = event['message']
    if (!isRecord(message) || !Array.isArray(message['content'])) return
    for (const block of message['content']) {
      if (!isRecord(block)) continue
      const blockType = block['type']
      if (blockType === 'text' && typeof block['text'] === 'string') {
        emitWorkerEvent(input, 'text', { text: block['text'] })
      } else if (blockType === 'tool_use') {
        emitWorkerEvent(input, 'tool_call', {
          toolName: typeof block['name'] === 'string' ? block['name'] : 'tool',
          toolArgs: summarizeValue(block['input']),
        })
      } else if (blockType === 'tool_result') {
        emitWorkerEvent(input, 'tool_result', { text: summarizeValue(block['content']) })
      } else if (blockType === 'thinking') {
        emitWorkerEvent(input, 'thinking', { text: summarizeValue(block['thinking'] ?? block['text']) })
      }
    }
    return
  }

  if (eventType === 'result') {
    const usage = event['usage']
    if (isRecord(usage)) {
      const outputTokens = usage['output_tokens']
      if (typeof outputTokens === 'number') {
        emitWorkerEvent(input, 'turn_complete', { tokenCount: outputTokens })
      }
    }
    return
  }

  if (eventType === 'error') {
    emitWorkerEvent(input, 'error', { error: summarizeValue(event['error']) })
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

function tryParseJson(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
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
