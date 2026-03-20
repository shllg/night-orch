import { execa } from 'execa'
import type { VerifyResult } from './types.js'
import { logger } from '../utils/logger.js'

const VERIFY_TIMEOUT_MS = 60_000

/**
 * Run all configured verify commands sequentially in the worktree.
 * Continues running all commands even if one fails (collect all results).
 */
export async function runVerifyCommands(
  worktreePath: string,
  commands: string[],
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = []

  for (const cmd of commands) {
    const parts = cmd.split(/\s+/)
    const binary = parts[0]!
    const args = parts.slice(1)

    const start = Date.now()
    logger.info({ command: cmd, worktreePath }, 'Running verify command')

    try {
      const result = await execa(binary, args, {
        cwd: worktreePath,
        timeout: VERIFY_TIMEOUT_MS,
        reject: false,
      })

      results.push({
        command: cmd,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - start,
        passed: result.exitCode === 0,
      })
    } catch (err) {
      results.push({
        command: cmd,
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
