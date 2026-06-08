import { execa } from 'execa'
import type { VerifyResult } from './types.js'
import { logger } from '../utils/logger.js'
import { parseCommandSpec, type CommandSpec } from '../utils/command.js'
import { sanitizeErrorMessage } from '../utils/sanitize-error.js'

const VERIFY_TIMEOUT_MS = 60_000

/** Hook command list run before/after a verify command (e.g. `docker compose up/down`). */
type HookCommand = CommandSpec
type VerifyCommandObject = {
  command: CommandSpec
  timeoutSeconds?: number
  before?: HookCommand[]
  after?: HookCommand[]
  env?: Record<string, string>
}
type VerifyCommandSpec = CommandSpec | VerifyCommandObject

interface NormalizedVerifyCommand {
  command: CommandSpec
  timeoutMs: number
  before: HookCommand[]
  after: HookCommand[]
  env: Record<string, string> | undefined
}

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
    const unitEnv = cmd.env ? { ...(env ?? {}), ...cmd.env } : env
    const start = Date.now()

    try {
      // `before` hooks fail-fast: a failed setup records the command as failed
      // and skips it, but the `after` hooks still run (finally) to clean up.
      const beforeError = await runHookCommands(worktreePath, cmd.before, unitEnv, cmd.timeoutMs, 'before')
      if (beforeError) {
        const durationMs = Date.now() - start
        logger.warn({ command: commandLabel, durationMs, stderrTail: sanitizeErrorMessage(beforeError.slice(-500)) }, 'Verify command before-hook failed')
        results.push({ command: commandLabel, exitCode: 1, stdout: '', stderr: beforeError, durationMs, passed: false })
        continue
      }

      logger.info({ command: commandLabel, worktreePath }, 'Running verify command')
      try {
        const { binary, args } = parseCommandSpec(cmd.command)
        const result = await execa(binary, args, {
          cwd: worktreePath,
          env: unitEnv,
          extendEnv: false,
          timeout: cmd.timeoutMs,
          reject: false,
        })

        const durationMs = Date.now() - start

        // execa with `reject: false` returns `exitCode: undefined` when the
        // process is killed (timeout or signal) — never a clean 0. Surfacing it
        // as exit 0 (`?? 0`) would make a killed run look like a clean exit that
        // somehow "failed", which is exactly the kind of misleading telemetry
        // that hides a too-low `timeoutSeconds`. Record a real non-zero code
        // (124 = timeout, matching coreutils) and annotate stderr.
        const rawExit = result.exitCode
        const timedOut = result.timedOut === true
        const exitCode: number = rawExit == null ? (timedOut ? 124 : 1) : rawExit
        const passed = exitCode === 0
        let stderr = result.stderr
        if (timedOut) {
          const seconds = Math.round(cmd.timeoutMs / 1000)
          const note = `Verify command timed out after ${seconds}s and was killed${result.signal ? ` (${result.signal})` : ''}. Raise this command's \`timeoutSeconds\` if it needs longer.`
          stderr = stderr ? `${stderr}\n${note}` : note
        }

        if (passed) {
          logger.info({ command: commandLabel, durationMs }, 'Verify command passed')
        } else {
          logger.warn({
            command: commandLabel,
            exitCode,
            timedOut,
            durationMs,
            stderrTail: sanitizeErrorMessage(stderr.slice(-500)),
          }, timedOut ? 'Verify command timed out' : 'Verify command failed')
        }

        results.push({
          command: commandLabel,
          exitCode,
          stdout: result.stdout,
          stderr,
          durationMs,
          passed,
        })
      } catch (err) {
        const durationMs = Date.now() - start
        const stderr = String(err)
        logger.warn({
          command: commandLabel,
          durationMs,
          stderrTail: sanitizeErrorMessage(stderr.slice(-500)),
        }, 'Verify command crashed')

        results.push({
          command: commandLabel,
          exitCode: 1,
          stdout: '',
          stderr,
          durationMs,
          passed: false,
        })
      }
    } finally {
      // `after` hooks always run (teardown), attempt-all, never throw.
      await runHookCommands(worktreePath, cmd.after, unitEnv, cmd.timeoutMs, 'after')
    }
  }

  return results
}

/**
 * Run a list of hook commands (before/after a verify command) in the worktree.
 *
 * `before` (phase `'before'`) is fail-fast: returns the failure text of the
 * first non-zero/crashing hook so the caller can skip the command. `after`
 * (phase `'after'`) is attempt-all: every hook runs even if an earlier one
 * fails, failures are logged and swallowed, and it always returns null.
 */
async function runHookCommands(
  worktreePath: string,
  hooks: HookCommand[],
  env: Record<string, string> | undefined,
  timeoutMs: number,
  phase: 'before' | 'after',
): Promise<string | null> {
  for (const hook of hooks) {
    const label = Array.isArray(hook) ? hook.join(' ') : hook
    try {
      const { binary, args } = parseCommandSpec(hook)
      const result = await execa(binary, args, {
        cwd: worktreePath,
        env,
        extendEnv: false,
        timeout: timeoutMs,
        reject: false,
      })
      if (result.exitCode !== 0) {
        const failure = `${phase} hook failed: ${label} (exit ${result.exitCode})\n${result.stderr ?? ''}`
        logger.warn({ hook: label, phase, exitCode: result.exitCode, stderrTail: sanitizeErrorMessage(String(result.stderr ?? '').slice(-500)) }, 'Verify hook failed')
        if (phase === 'before') return failure
      }
    } catch (err) {
      const failure = `${phase} hook crashed: ${label}\n${String(err)}`
      logger.warn({ hook: label, phase, stderrTail: sanitizeErrorMessage(String(err).slice(-500)) }, 'Verify hook crashed')
      if (phase === 'before') return failure
    }
  }
  return null
}

/**
 * Drop `before`/`after`/`env` from a verify command, keeping only the command
 * (and timeout). Used by call sites without per-run tokens (preflight base-gate,
 * rebase post-check) where service hooks and `{port}`/`{project}` tokens can't
 * be resolved — service-dependent verification only runs in the main loop.
 */
export function stripVerifyHooks(spec: VerifyCommandSpec): VerifyCommandSpec {
  if (typeof spec === 'string' || Array.isArray(spec)) return spec
  return spec.timeoutSeconds !== undefined
    ? { command: spec.command, timeoutSeconds: spec.timeoutSeconds }
    : spec.command
}

export function allVerifyPassed(results: VerifyResult[]): boolean {
  return results.every((r) => r.passed)
}

export function requiredVerifyResults(results: VerifyResult[]): VerifyResult[] {
  return results.filter((result) => result.required !== false)
}

export function allRequiredVerifyPassed(results: VerifyResult[]): boolean {
  const required = requiredVerifyResults(results)
  if (required.length === 0) return true
  return required.every((result) => result.passed)
}

function normalizeVerifyCommand(raw: VerifyCommandSpec): NormalizedVerifyCommand {
  if (Array.isArray(raw) || typeof raw === 'string') {
    return { command: raw, timeoutMs: VERIFY_TIMEOUT_MS, before: [], after: [], env: undefined }
  }

  const timeoutMs = raw.timeoutSeconds !== undefined && Number.isFinite(raw.timeoutSeconds) && raw.timeoutSeconds > 0
    ? raw.timeoutSeconds * 1000
    : VERIFY_TIMEOUT_MS
  return {
    command: raw.command,
    timeoutMs,
    before: raw.before ?? [],
    after: raw.after ?? [],
    env: raw.env,
  }
}
