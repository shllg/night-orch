import { execa } from 'execa'
import { logger } from '../utils/logger.js'

export type BootstrapWhen = 'always' | 'dedicated' | 'shared'

export interface BootstrapCommand {
  command: string
  when: BootstrapWhen
}

/**
 * Run bootstrap commands sequentially in the worktree directory.
 * Respects `when` filter. Fails fast on non-zero exit.
 */
export async function runBootstrapCommands(
  worktreePath: string,
  commands: BootstrapCommand[],
  mode: 'shared' | 'dedicated',
): Promise<void> {
  for (const cmd of commands) {
    if (cmd.when !== 'always' && cmd.when !== mode) {
      logger.debug({ command: cmd.command, when: cmd.when, mode }, 'Skipping bootstrap command')
      continue
    }

    logger.info({ command: cmd.command, worktreePath }, 'Running bootstrap command')

    const parts = cmd.command.split(/\s+/)
    const binary = parts[0]!
    const args = parts.slice(1)

    const result = await execa(binary, args, {
      cwd: worktreePath,
      timeout: 300_000, // 5 min timeout for bootstrap commands
      reject: false,
    })

    if (result.exitCode !== 0) {
      logger.error(
        { command: cmd.command, exitCode: result.exitCode, stderr: result.stderr },
        'Bootstrap command failed',
      )
      throw new Error(
        `Bootstrap command failed: ${cmd.command}\nExit code: ${result.exitCode}\n${result.stderr}`,
      )
    }

    logger.debug({ command: cmd.command }, 'Bootstrap command succeeded')
  }
}
