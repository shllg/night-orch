import { execa } from 'execa'
import type { VerifyResult } from './types.js'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'

const VERIFY_TIMEOUT_MS = 60_000

/**
 * Run all configured verify commands sequentially in the worktree.
 * Continues running all commands even if one fails (collect all results).
 */
export async function runVerifyCommands(
  worktreePath: string,
  commands: CommandSpec[],
  env?: Record<string, string>,
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = []

  for (const cmd of commands) {
    const commandLabel = Array.isArray(cmd) ? cmd.join(' ') : cmd
    const start = Date.now()
    logger.info({ command: commandLabel, worktreePath }, 'Running verify command')

    try {
      const { binary, args } = parseCommandSpec(cmd)
      const result = await execa(binary, args, {
        cwd: worktreePath,
        env,
        timeout: VERIFY_TIMEOUT_MS,
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
