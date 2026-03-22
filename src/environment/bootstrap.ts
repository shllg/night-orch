import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'

export type BootstrapWhen = 'always' | 'dedicated' | 'shared'

export interface BootstrapCommand {
  command: CommandSpec
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
      logger.debug({ command: formatCommand(cmd.command), when: cmd.when, mode }, 'Skipping bootstrap command')
      continue
    }

    const commandLabel = formatCommand(cmd.command)
    logger.info({ command: commandLabel, worktreePath }, 'Running bootstrap command')
    const { binary, args } = parseCommandSpec(cmd.command)

    const result = await execa(binary, args, {
      cwd: worktreePath,
      timeout: 300_000, // 5 min timeout for bootstrap commands
      reject: false,
    })

    if (result.exitCode !== 0) {
      logger.error(
        { command: commandLabel, exitCode: result.exitCode, stderr: result.stderr },
        'Bootstrap command failed',
      )
      throw new Error(
        `Bootstrap command failed: ${commandLabel}\nExit code: ${result.exitCode}\n${result.stderr}`,
      )
    }

    logger.debug({ command: commandLabel }, 'Bootstrap command succeeded')
  }
}

function formatCommand(command: CommandSpec): string {
  return Array.isArray(command) ? command.join(' ') : command
}
