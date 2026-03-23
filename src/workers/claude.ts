import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { execWithTimeout } from './timeout.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { buildWorkerCommand } from './command.js'
import { logger } from '../utils/logger.js'

export class ClaudeWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    const maxTurns = input.role === 'coder' ? '50' : '1'
    const taskArgs = [
      ...input.profile.args,
      '--output-format', 'json',
      '--max-turns', maxTurns,
    ]
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

    // Extract assistant text from Claude CLI JSON envelope
    const assistantText = extractClaudeOutput(result.stdout)
    const extracted = assistantText !== result.stdout
    logger.info({ role: input.role, rawLength: result.stdout.length, extractedLength: assistantText.length, extracted, extractedHead: assistantText.slice(0, 500) }, 'Claude output extraction')

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
 * Claude CLI with --output-format json returns a JSON array of streaming events.
 * Extract the assistant's text content from the event stream.
 * Falls back to raw string if not parseable.
 */
function extractClaudeOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw)

    // Streaming format: array of event objects
    if (Array.isArray(parsed)) {
      const textParts: string[] = []
      for (const event of parsed) {
        if (typeof event !== 'object' || event === null) continue
        // assistant message events contain content blocks with text
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              textParts.push(block.text)
            }
          }
        }
        // result message at the end
        if (event.type === 'result' && Array.isArray(event.result)) {
          for (const block of event.result) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              textParts.push(block.text)
            }
          }
        }
        if (event.type === 'result' && typeof event.result === 'string') {
          textParts.push(event.result)
        }
      }
      if (textParts.length > 0) return textParts.join('\n')
    }

    // Single object envelope: { result: "..." }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.result === 'string') return parsed.result
    }
  } catch {
    // Not JSON — return raw
  }
  return raw
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
