import { isAbsolute, resolve } from 'node:path'

export interface ParsedCommand {
  binary: string
  args: string[]
}

export type CommandSpec = string | string[]

/**
 * errno codes execa surfaces on `result.code` (or a thrown error) when the
 * child process could never be spawned — the command did not run at all.
 * Mapped to a short human reason and the conventional shell exit code
 * (127 = not found, 126 = found-but-not-executable).
 */
const SPAWN_FAILURE_REASONS: Record<string, { reason: string; exitCode: number }> = {
  ENOENT: { reason: 'command not found', exitCode: 127 },
  EACCES: { reason: 'command not executable', exitCode: 126 },
  EISDIR: { reason: 'command path is a directory', exitCode: 126 },
  ENOTDIR: { reason: 'command path has a non-directory parent', exitCode: 126 },
  ENOEXEC: { reason: 'command is not a valid executable', exitCode: 126 },
  EPERM: { reason: 'command not permitted', exitCode: 126 },
}

export interface SpawnFailure {
  /** The errno execa reported (`ENOENT`, `EACCES`, …). */
  code: string
  /** Diagnostic naming the binary, the reason, and — for path-form commands — the resolved path. */
  message: string
  /** Conventional shell exit code: 127 (not found) / 126 (not executable). */
  exitCode: number
}

/**
 * Recognise an execa *spawn* failure — the child never started because the
 * binary is missing or not executable — from either a `reject:false` result
 * object or a thrown execa error.
 *
 * execa reports these as `code: 'ENOENT' | 'EACCES' | …` with
 * `exitCode: undefined`, otherwise indistinguishable from a killed process —
 * so a missing `bin/…` script surfaces as a bare `Exit code: undefined`.
 * Keying on `code` is safe: normal exits (success or non-zero) and
 * timeout/signal kills carry no `code`, only genuine spawn errors do. Returns
 * a diagnostic naming the file + reason, or `null` when not a spawn failure.
 *
 * For path-form commands (`bin/…`, `./…`, absolute) the message includes the
 * path resolved against `cwd`, since that is the file the operator must fix.
 */
export function describeSpawnFailure(errOrResult: unknown, binary: string, cwd: string): SpawnFailure | null {
  if (errOrResult == null || typeof errOrResult !== 'object') return null
  const o = errOrResult as { code?: unknown; exitCode?: unknown; timedOut?: unknown; signal?: unknown }
  const code = o.code
  if (typeof code !== 'string') return null
  // A genuine spawn failure never produced an exit code and was not killed by a
  // timeout/signal — this guards the generic-errno fallback below from
  // misclassifying other execa/Node errors that merely carry a string `code`.
  if (o.exitCode != null || o.timedOut === true || o.signal != null) return null
  const known = SPAWN_FAILURE_REASONS[code]
  const reason = known?.reason ?? 'command could not be executed'
  const exitCode = known?.exitCode ?? 126
  const pathForm = isAbsolute(binary) || binary.includes('/') || binary.includes('\\')
  const location = pathForm
    ? `${binary} (${isAbsolute(binary) ? binary : resolve(cwd, binary)})`
    : binary
  return { code, message: `${reason} in worktree: ${location} [${code}]`, exitCode }
}

export function parseCommandSpec(spec: CommandSpec): ParsedCommand {
  if (Array.isArray(spec)) {
    const [binary, ...args] = spec
    if (!binary || binary.trim() === '') {
      throw new Error('Command array must contain at least one non-empty argument')
    }
    return { binary, args }
  }
  return parseCommandString(spec)
}

export function parseCommandString(command: string): ParsedCommand {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!

    if (escaping) {
      current += ch
      escaping = false
      continue
    }

    if (ch === '\\') {
      if (quote === "'") {
        current += ch
      } else {
        escaping = true
      }
      continue
    }

    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (escaping) {
    current += '\\'
  }
  if (quote) {
    throw new Error(`Unterminated ${quote} quote in command: ${command}`)
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  if (tokens.length === 0) {
    throw new Error('Command cannot be empty')
  }

  return {
    binary: tokens[0]!,
    args: tokens.slice(1),
  }
}
