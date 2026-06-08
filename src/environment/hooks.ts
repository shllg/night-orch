import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, describeSpawnFailure, type CommandSpec, type SpawnFailure } from '../utils/command.js'
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
  | {
      command: CommandSpec
      failureHints?: RunHookFailureHint[]
      env?: Record<string, string>
      timeoutSeconds?: number
    }

const DEFAULT_HOOK_TIMEOUT_MS = 300_000 // 5 min — overridable per hook via `timeoutSeconds`

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
    const { command, failureHints, env: hookEnvRaw, timeoutMs } = normalizeHook(hook)
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

    let result: { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean; signal?: string }
    // Lifted out of the try so the catch can name the binary in a spawn-failure
    // diagnostic; empty until `parseCommandSpec` succeeds.
    let binary = ''
    try {
      const parsed = parseCommandSpec(resolved)
      binary = parsed.binary
      result = await execa(binary, parsed.args, {
        cwd: worktreePath,
        timeout: timeoutMs,
        reject: false,
        extendEnv: false,
        env,
      })
    } catch (err) {
      // execa with reject:false resolves spawn errors, so this catch is for
      // parse errors / unexpected throws; still surface a spawn diagnostic if one is present.
      const spawnFailure = binary ? describeSpawnFailure(err, binary, worktreePath) : null
      const detail = spawnFailure ? spawnFailure.message : sanitizeErrorMessage(String(err))
      if (mode === 'attempt-all') {
        logger.warn({ command: label, stderrTail: sanitizeErrorMessage(detail.slice(-500)) }, 'Run hook crashed (continuing teardown)')
        continue
      }
      throw new Error(`Run hook crashed: ${label}\n${detail}`)
    }

    if (result.exitCode !== 0) {
      // execa with `reject: false` resolves a timeout with exitCode undefined +
      // timedOut: true. Surface 124 (coreutils convention) + a "raise
      // timeoutSeconds" hint — same shape as verify-command timeouts, so
      // operators see a uniform diagnostic.
      const timedOut = result.timedOut === true
      // A missing/non-executable hook resolves here (not the catch) with
      // exitCode undefined + a `code` errno; name the file instead of "Exit code: undefined".
      const spawnFailure = !timedOut ? describeSpawnFailure(result, binary, worktreePath) : null
      const reportedExit = timedOut ? 124 : result.exitCode
      const timeoutNote = timedOut
        ? `Run hook timed out after ${Math.round(timeoutMs / 1000)}s and was killed${result.signal ? ` (${result.signal})` : ''}. Raise this hook's \`timeoutSeconds\` if it needs longer.`
        : null
      if (mode === 'attempt-all') {
        logger.warn(
          spawnFailure
            ? { command: label, spawnFailure: spawnFailure.message }
            : timedOut
              ? { command: label, exitCode: 124, timedOut: true, note: timeoutNote }
              : { command: label, exitCode: result.exitCode, stderrTail: sanitizeErrorMessage(String(result.stderr ?? '').slice(-500)) },
          timedOut ? 'Run hook timed out (continuing teardown)' : 'Run hook failed (continuing teardown)',
        )
        continue
      }
      logger.error(
        spawnFailure
          ? { command: label, spawnFailure: spawnFailure.message }
          : timedOut
            ? { command: label, exitCode: 124, timedOut: true, note: timeoutNote }
            : { command: label, exitCode: result.exitCode, stdout: sanitizeErrorMessage(result.stdout ?? ''), stderr: sanitizeErrorMessage(result.stderr ?? '') },
        timedOut ? 'Run hook timed out' : 'Run hook failed',
      )
      throw new Error(formatHookFailure(label, { ...result, exitCode: reportedExit }, failureHints, spawnFailure, timeoutNote))
    }

    logger.debug({ command: label }, 'Run hook succeeded')
  }
}

function normalizeHook(hook: RunHookCommand): { command: CommandSpec; failureHints: RunHookFailureHint[]; env: Record<string, string>; timeoutMs: number } {
  if (Array.isArray(hook) || typeof hook === 'string') {
    return { command: hook, failureHints: [], env: {}, timeoutMs: DEFAULT_HOOK_TIMEOUT_MS }
  }
  const timeoutMs = hook.timeoutSeconds !== undefined && hook.timeoutSeconds > 0
    ? hook.timeoutSeconds * 1000
    : DEFAULT_HOOK_TIMEOUT_MS
  return { command: hook.command, failureHints: hook.failureHints ?? [], env: hook.env ?? {}, timeoutMs }
}

const OUTPUT_TAIL_LIMIT = 4000

function formatHookFailure(
  label: string,
  result: { exitCode?: number; stdout?: string; stderr?: string },
  failureHints: RunHookFailureHint[],
  spawnFailure?: SpawnFailure | null,
  timeoutNote?: string | null,
): string {
  const headline = timeoutNote ? `Run hook timed out: ${label}` : `Run hook failed: ${label}`
  const lines: string[] = [headline, spawnFailure ? spawnFailure.message : `Exit code: ${result.exitCode}`]
  if (timeoutNote) lines.push(timeoutNote)
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
