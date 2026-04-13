import { execa } from 'execa'
import { parseCommandSpec } from '../utils/command.js'
import { buildVerifierEnv } from '../workers/env.js'
import type { FileLoopConfig } from '../config/schema.js'
import type { FileLoopVerifyResult } from './types.js'
import type { VerifyResult } from '../workers/types.js'

export async function verifyFile(
  worktreePath: string,
  _filePath: string,
  config: FileLoopConfig,
): Promise<FileLoopVerifyResult> {
  if (!config.perEditVerify.enabled) {
    return { results: [], passed: true }
  }
  const results = await runCommands(worktreePath, config.perEditVerify.commands, config.perEditVerify.timeoutSeconds)
  return { results, passed: results.every((result) => result.passed) }
}

export async function verifyAll(
  worktreePath: string,
  config: FileLoopConfig,
): Promise<FileLoopVerifyResult> {
  if (!config.finalizeVerify.enabled) {
    return { results: [], passed: true }
  }
  const results = await runCommands(worktreePath, config.finalizeVerify.commands, config.finalizeVerify.timeoutSeconds)
  return { results, passed: results.every((result) => result.passed) }
}

async function runCommands(
  worktreePath: string,
  commands: string[],
  timeoutSeconds: number,
): Promise<VerifyResult[]> {
  const env = buildVerifierEnv()
  const results: VerifyResult[] = []

  for (const command of commands) {
    const start = Date.now()
    try {
      const parsed = parseCommandSpec(command)
      const result = await execa(parsed.binary, parsed.args, {
        cwd: worktreePath,
        env,
        extendEnv: false,
        timeout: timeoutSeconds * 1000,
        reject: false,
      })
      results.push({
        command,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - start,
        passed: result.exitCode === 0,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({
        command,
        exitCode: 1,
        stdout: '',
        stderr: message,
        durationMs: Date.now() - start,
        passed: false,
      })
    }
  }

  return results
}
