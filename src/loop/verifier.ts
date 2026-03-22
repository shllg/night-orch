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

      results.push({
        command: commandLabel,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - start,
        passed: result.exitCode === 0,
      })
    } catch (err) {
      results.push({
        command: commandLabel,
        exitCode: 1,
        stdout: '',
        stderr: String(err),
        durationMs: Date.now() - start,
        passed: false,
      })
    }
  }

  return results
}

export function allVerifyPassed(results: VerifyResult[]): boolean {
  return results.every((r) => r.passed)
}
