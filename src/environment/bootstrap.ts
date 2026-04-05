import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'

export type BootstrapWhen = 'always' | 'dedicated' | 'shared'

export interface BootstrapCommand {
  command: CommandSpec
  when: BootstrapWhen
  failureHints?: BootstrapFailureHint[]
}

interface BootstrapFailureHint {
  contains: string
  message: string
  output?: 'combined' | 'stdout' | 'stderr'
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
        {
          command: commandLabel,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        'Bootstrap command failed',
      )
      throw new Error(formatBootstrapFailure(commandLabel, result, cmd.failureHints))
    }

    logger.debug({ command: commandLabel }, 'Bootstrap command succeeded')
  }
}

function formatCommand(command: CommandSpec): string {
  return Array.isArray(command) ? command.join(' ') : command
}

const OUTPUT_TAIL_LIMIT = 4000

function formatBootstrapFailure(
  commandLabel: string,
  result: { exitCode?: number | undefined; stdout?: string; stderr?: string },
  failureHints: BootstrapFailureHint[] | undefined,
): string {
  const lines: string[] = [
    `Bootstrap command failed: ${commandLabel}`,
    `Exit code: ${result.exitCode}`,
  ]
  const stdoutTail = tail(result.stdout)
  if (stdoutTail) {
    lines.push('stdout:', stdoutTail)
  }
  const stderrTail = tail(result.stderr)
  if (stderrTail) {
    lines.push('stderr:', stderrTail)
  }
  const hint = detectBootstrapHint(result, failureHints)
  if (hint) {
    lines.push('hint:', hint)
  }
  return lines.join('\n')
}

function tail(output: string | undefined): string {
  if (!output) return ''
  if (output.length <= OUTPUT_TAIL_LIMIT) return output
  const omitted = output.length - OUTPUT_TAIL_LIMIT
  return `... (truncated, ${omitted} chars omitted)\n${output.slice(-OUTPUT_TAIL_LIMIT)}`
}

function detectBootstrapHint(
  result: { stdout?: string; stderr?: string },
  failureHints: BootstrapFailureHint[] | undefined,
): string | null {
  if (!failureHints || failureHints.length === 0) return null

  for (const hint of failureHints) {
    const output = hint.output ?? 'combined'
    const haystack =
      output === 'stdout'
        ? result.stdout ?? ''
        : output === 'stderr'
          ? result.stderr ?? ''
          : [result.stdout, result.stderr].filter(Boolean).join('\n')
    if (haystack.includes(hint.contains)) {
      return hint.message
    }
  }

  return null
}
