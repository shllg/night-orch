import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'
import { buildBootstrapEnv } from '../workers/env.js'
import { sanitizeErrorMessage } from '../utils/sanitize-error.js'
import {
  findUnresolvedPortToken,
  substituteCommandTokens,
  substituteEnvTokens,
  unresolvedPortMessage,
  type RunTokens,
} from './tokens.js'

export interface RunHookFailureHint {
  contains: string
  message: string
  output?: 'combined' | 'stdout' | 'stderr'
}

/**
 * A run-level hook: a bare command or an object carrying failure hints and/or
 * an explicit, token-substituted `env`.
 */
export type RunHookCommand =
  | CommandSpec
  | { command: CommandSpec; failureHints?: RunHookFailureHint[]; env?: Record<string, string> }

const HOOK_TIMEOUT_MS = 300_000 // 5 min

/**
 * Run a list of run-level lifecycle hooks (`beforeRun` / `afterRun`) in the
 * worktree.
 *
 * `mode: 'fail-fast'` (beforeRun) throws on the first non-zero/crashing hook
 * with a formatted, secret-scrubbed message (plus any matched failure hint).
 * `mode: 'attempt-all'` (afterRun) runs every hook even if earlier ones fail,
 * logs failures at `warn`, and never throws — teardown must not mask the run's
 * real outcome.
 *
 * Tokens (`{issue}`/`{run}`/`{project}` plus `{port}`/`{port:NAME}`) are
 * substituted into each command AND into the hook's `env` values; an unresolved
 * port token (in command or env) fails loudly (fail-fast) or is skipped with a
 * warning (attempt-all).
 *
 * Env base is the bootstrap whitelist (includes `DOCKER_*`/`COMPOSE_*`; the
 * daemon's secrets are never inherited). A hook's explicit `env` is layered raw
 * on top and **bypasses the secret blacklist** — parity with verify-command
 * `env`, so allocated ports reach the service stack under repo-specific names
 * (and local non-secret creds work). Env values are never logged.
 */
export async function runRunHooks(
  worktreePath: string,
  hooks: RunHookCommand[],
  tokens: RunTokens,
  mode: 'fail-fast' | 'attempt-all',
): Promise<void> {
  if (hooks.length === 0) return
  const baseEnv = buildBootstrapEnv()

  for (const hook of hooks) {
    const { command, failureHints, env: hookEnvRaw } = normalizeHook(hook)
    const resolved = substituteCommandTokens(command, tokens)
    const hookEnv = substituteEnvTokens(hookEnvRaw, tokens)
    const label = Array.isArray(resolved) ? resolved.join(' ') : resolved
    const segments = Array.isArray(resolved) ? resolved : [resolved]
    // Scan both command segments and env values for unresolved port tokens.
    const unresolved = findUnresolvedPortToken([...segments, ...Object.values(hookEnv)])
    if (unresolved) {
      const msg = `${unresolvedPortMessage(unresolved, tokens, 'Run hook')}: ${label}`
      if (mode === 'fail-fast') throw new Error(msg)
      logger.warn({ command: label }, msg)
      continue
    }
    logger.info({ command: label, worktreePath }, 'Running run hook')

    // Raw merge AFTER the whitelist base = blacklist bypass (operator opt-in),
    // mirroring verify-command env. NEVER add `env` to a log record below.
    const env = { ...baseEnv, ...hookEnv }

    let result: { exitCode?: number; stdout?: string; stderr?: string }
    try {
      const { binary, args } = parseCommandSpec(resolved)
      result = await execa(binary, args, {
        cwd: worktreePath,
        timeout: HOOK_TIMEOUT_MS,
        reject: false,
        extendEnv: false,
        env,
      })
    } catch (err) {
      if (mode === 'attempt-all') {
        logger.warn({ command: label, stderrTail: sanitizeErrorMessage(String(err).slice(-500)) }, 'Run hook crashed (continuing teardown)')
        continue
      }
      throw new Error(`Run hook crashed: ${label}\n${sanitizeErrorMessage(String(err))}`)
    }

    if (result.exitCode !== 0) {
      if (mode === 'attempt-all') {
        logger.warn(
          { command: label, exitCode: result.exitCode, stderrTail: sanitizeErrorMessage(String(result.stderr ?? '').slice(-500)) },
          'Run hook failed (continuing teardown)',
        )
        continue
      }
      logger.error(
        { command: label, exitCode: result.exitCode, stdout: sanitizeErrorMessage(result.stdout ?? ''), stderr: sanitizeErrorMessage(result.stderr ?? '') },
        'Run hook failed',
      )
      throw new Error(formatHookFailure(label, result, failureHints))
    }

    logger.debug({ command: label }, 'Run hook succeeded')
  }
}

function normalizeHook(hook: RunHookCommand): { command: CommandSpec; failureHints: RunHookFailureHint[]; env: Record<string, string> } {
  if (Array.isArray(hook) || typeof hook === 'string') {
    return { command: hook, failureHints: [], env: {} }
  }
  return { command: hook.command, failureHints: hook.failureHints ?? [], env: hook.env ?? {} }
}

const OUTPUT_TAIL_LIMIT = 4000

function formatHookFailure(
  label: string,
  result: { exitCode?: number; stdout?: string; stderr?: string },
  failureHints: RunHookFailureHint[],
): string {
  const lines: string[] = [`Run hook failed: ${label}`, `Exit code: ${result.exitCode}`]
  const stdoutTail = tail(sanitizeErrorMessage(result.stdout ?? ''))
  if (stdoutTail) lines.push('stdout:', stdoutTail)
  const stderrTail = tail(sanitizeErrorMessage(result.stderr ?? ''))
  if (stderrTail) lines.push('stderr:', stderrTail)
  const hint = detectHint(result, failureHints)
  if (hint) lines.push('hint:', hint)
  return lines.join('\n')
}

function tail(output: string | undefined): string {
  if (!output) return ''
  if (output.length <= OUTPUT_TAIL_LIMIT) return output
  const omitted = output.length - OUTPUT_TAIL_LIMIT
  return `... (truncated, ${omitted} chars omitted)\n${output.slice(-OUTPUT_TAIL_LIMIT)}`
}

function detectHint(
  result: { stdout?: string; stderr?: string },
  failureHints: RunHookFailureHint[],
): string | null {
  for (const hint of failureHints) {
    const output = hint.output ?? 'combined'
    const haystack =
      output === 'stdout'
        ? result.stdout ?? ''
        : output === 'stderr'
          ? result.stderr ?? ''
          : [result.stdout, result.stderr].filter(Boolean).join('\n')
    if (haystack.includes(hint.contains)) return hint.message
  }
  return null
}
