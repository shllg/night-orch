import { execWithTimeout } from './timeout.js'
import { normalizePathForSubprocess } from './env.js'

/**
 * Known stderr/stdout patterns that indicate a signed-out or expired-auth
 * state for each CLI. Patterns are tested case-insensitively.
 *
 * Keep these in a single place so they are easy to update when CLI tools
 * change their error messages between versions.
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  // Generic across CLIs
  /not (?:logged|signed) in/i,
  /please (?:log|sign) ?in/i,
  /authentication (?:required|failed|expired)/i,
  /session (?:expired|invalid)/i,
  /unauthorized/i,
  /invalid.*(?:api[_ ]?key|token|credential)/i,
  /expired.*(?:api[_ ]?key|token|credential|session)/i,
  /(?:api[_ ]?key|token|credential).*(?:invalid|expired|missing|revoked)/i,
  /login required/i,
  /re-?authenticate/i,
  /auth(?:orization)? error/i,
]

/**
 * Patterns that look similar to auth errors but indicate a different
 * failure (rate limits, network issues). Checked before auth patterns
 * to prevent false positives.
 */
const FALSE_POSITIVE_PATTERNS: readonly RegExp[] = [
  /rate limit/i,
  /too many requests/i,
  /429/,
  /connection refused/i,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /network error/i,
]

export interface AuthClassification {
  isAuthFailure: boolean
  detail: string | null
}

/**
 * Classify whether a non-zero exit from a worker CLI is an authentication
 * failure based on stderr (and optionally stdout) content.
 *
 * Only call this when `exitCode !== 0` — a successful exit is never
 * classified as an auth failure regardless of output content.
 */
export function classifyAuthFailure(
  stderr: string,
  _exitCode: number,
  _adapterType: string,
  stdout?: string,
): AuthClassification {
  // Combine both streams — some CLIs emit auth errors to stdout
  const combined = `${stderr}\n${stdout ?? ''}`

  // Rule out false positives first
  for (const pattern of FALSE_POSITIVE_PATTERNS) {
    if (pattern.test(combined)) {
      return { isAuthFailure: false, detail: null }
    }
  }

  // Check for auth failure signatures
  for (const pattern of AUTH_FAILURE_PATTERNS) {
    const match = pattern.exec(combined)
    if (match) {
      return { isAuthFailure: true, detail: match[0] }
    }
  }

  return { isAuthFailure: false, detail: null }
}

/** Human-readable remediation commands per CLI type. */
export const REMEDIATION_HINTS: Readonly<Record<string, string>> = {
  claude: 'Run `claude login` to re-authenticate.',
  codex: 'Run `codex auth login` to re-authenticate.',
}

export function getRemediation(adapterType: string): string {
  return REMEDIATION_HINTS[adapterType] ?? `Re-authenticate the ${adapterType} CLI.`
}

export interface AuthCheckResult {
  authenticated: boolean
  error: string | null
  remediation: string | null
}

/**
 * Pre-flight auth check: run a lightweight command that requires
 * authentication to verify the CLI is signed in.
 *
 * Used by the doctor command. Not called during normal loop execution
 * (post-failure classification handles that).
 */
export async function checkWorkerAuth(
  command: string,
  adapterType: string,
): Promise<AuthCheckResult> {
  const env = {
    PATH: normalizePathForSubprocess(process.env['PATH'], process.env['HOME']),
    HOME: process.env['HOME'] ?? '',
  }

  try {
    // Both Claude and Codex support a lightweight invocation that requires auth.
    // `claude --print "hi" --max-turns 1` and `codex exec "echo hi"` both need
    // a valid session. We use a short timeout since this is advisory.
    const args = adapterType === 'codex'
      ? ['exec', '--quiet', 'echo hello']
      : ['--print', 'hello', '--max-turns', '1', '--output-format', 'json']

    const result = await execWithTimeout(command, args, {
      cwd: '.',
      env,
      timeoutMs: 15_000,
    })

    if (result.exitCode === 0) {
      return { authenticated: true, error: null, remediation: null }
    }

    const classification = classifyAuthFailure(result.stderr, result.exitCode, adapterType, result.stdout)
    if (classification.isAuthFailure) {
      return {
        authenticated: false,
        error: classification.detail ?? 'Authentication check failed',
        remediation: getRemediation(adapterType),
      }
    }

    // Non-zero exit but not clearly auth — treat as unknown (don't false-positive)
    return { authenticated: true, error: null, remediation: null }
  } catch {
    // Command failed entirely (not found, crash, etc.) — not an auth issue
    return { authenticated: true, error: null, remediation: null }
  }
}
