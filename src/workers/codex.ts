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
 * Codex CLI outputs newline-delimited JSON streaming events.
 * Agent text is in item.completed events with item.type === "agent_message".
 * Extract and concatenate all agent message text.
 */
function extractCodexOutput(raw: string): string {
  const textParts: string[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (
        event.type === 'item.completed' &&
        typeof event.item === 'object' &&
        event.item !== null
      ) {
        const item = event.item as Record<string, unknown>
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          textParts.push(item.text)
        }
      }
    } catch {
      // Not JSON — skip
    }
  }

  if (textParts.length > 0) return textParts.join('\n')
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
