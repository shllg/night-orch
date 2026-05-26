import { execa } from 'execa'
import type { VerifyResult } from './types.js'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'

const VERIFY_TIMEOUT_MS = 60_000
type VerifyCommandSpec = CommandSpec | { command: CommandSpec; timeoutSeconds: number }

/**
 * Run all configured verify commands sequentially in the worktree.
 * Continues running all commands even if one fails (collect all results).
 */
export async function runVerifyCommands(
  worktreePath: string,
  commands: VerifyCommandSpec[],
  env?: Record<string, string>,
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = []

  for (const rawCmd of commands) {
    const cmd = normalizeVerifyCommand(rawCmd)
    const commandLabel = Array.isArray(cmd.command) ? cmd.command.join(' ') : cmd.command
    const start = Date.now()
    logger.info({ command: commandLabel, worktreePath }, 'Running verify command')

    try {
      const { binary, args } = parseCommandSpec(cmd.command)
      const result = await execa(binary, args, {
        cwd: worktreePath,
        env,
        timeout: cmd.timeoutMs,
        reject: false,
      })

      const passed = result.exitCode === 0
      const durationMs = Date.now() - start

      if (passed) {
        logger.info({ command: commandLabel, durationMs }, 'Verify command passed')
      } else {
        logger.warn({ command: commandLabel, exitCode: result.exitCode, durationMs, stderrTail: result.stderr.slice(-500) }, 'Verify command failed')
      }

      results.push({
        command: commandLabel,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        passed,
      })
    } catch (err) {
      const durationMs = Date.now() - start
      const stderr = String(err)
      logger.warn({ command: commandLabel, durationMs, stderrTail: stderr.slice(-500) }, 'Verify command crashed')

      results.push({
        command: commandLabel,
        exitCode: 1,
        stdout: '',
        stderr,
        durationMs,
        passed: false,
      })
    }
  }

  return results
}

export function allVerifyPassed(results: VerifyResult[]): boolean {
  return results.every((r) => r.passed)
}

function normalizeVerifyCommand(raw: VerifyCommandSpec): { command: CommandSpec; timeoutMs: number } {
  if (Array.isArray(raw) || typeof raw === 'string') {
    return { command: raw, timeoutMs: VERIFY_TIMEOUT_MS }
  }

  const timeoutMs = Number.isFinite(raw.timeoutSeconds) && raw.timeoutSeconds > 0
    ? raw.timeoutSeconds * 1000
    : VERIFY_TIMEOUT_MS
  return { command: raw.command, timeoutMs }
}
