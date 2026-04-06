/**
 * Scrub known secret patterns out of an error message before it lands in
 * a log, an HTTP response body, or a forge status comment.
 *
 * Error messages from execa (git push, docker), Octokit, and node-fetch can
 * embed raw tokens in multiple shapes:
 *
 *   - `https://x-access-token:ghp_abc123@github.com/org/repo.git` (git remote)
 *   - `Authorization: token ghp_abc123` (in forwarded headers)
 *   - `GITHUB_TOKEN=ghp_abc123 not set` (environment echo)
 *   - `ghp_abc123` bare in command stdout
 *
 * This helper applies a best-effort regex pass that catches all four. It is
 * intentionally conservative — it never returns the original unmodified
 * string if a token-shaped pattern was matched, and it collapses
 * cross-pattern remnants with a final pass. Do NOT use this for untrusted
 * user content going into prompts — use `sanitizeUntrustedText` for that.
 */

// Matches env-style and prose-style key=value token echoes, e.g.
// `GITHUB_TOKEN=ghp_...`, `api_key: abc`, `PASSWORD = hunter2`. The prefix
// `[A-Za-z_]*` lets us catch UPPER_SNAKE env-var names like GITHUB_TOKEN
// where there is no word boundary between the prefix and the keyword.
const KEY_VALUE_PATTERN =
  /([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key|auth|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|webhook[_-]?url)[A-Za-z_]*)\s*[:=]\s*(\S+)/gi

// Git HTTPS with embedded credentials: https://user:password@host — MUST
// run before KEY_VALUE_PATTERN because `token:ghp_xxx` inside such a URL
// would otherwise match the key=value pattern and destroy the host.
const EMBEDDED_URL_CREDS = /(https?:\/\/)([^/@\s:]+):([^/@\s]+)@/g

// Bearer/token query parameters.
const URL_QUERY_TOKEN = /([?&](?:access_?token|refresh_?token|api_?key|apikey|token|secret)=)([^&\s#]+)/gi

// Token shapes that stand alone (no key= prefix). Only explicit vendor
// prefixes are matched here — we deliberately do NOT include a generic
// high-entropy base64 catch because it creates too many false positives
// against legitimate long command output (hashes, UUIDs, build IDs).
// Vendor-prefix coverage plus the KEY_VALUE and URL patterns above is
// enough to catch the vast majority of real-world token leaks.
const BARE_TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens
  /\bxox[aboprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access keys
  /\bAKIA[0-9A-Z]{16}\b/g,
]

/**
 * Return a scrubbed copy of an arbitrary error message. Safe to pass
 * straight to `logger.error({ err }, ...)` in follow-up context or to
 * embed in forge comments.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message) return message

  let out = message

  // 1. Replace credential portion of embedded URLs first, preserving the host.
  out = out.replace(EMBEDDED_URL_CREDS, '$1[REDACTED]:[REDACTED]@')

  // 2. Token query parameters, preserving key name.
  out = out.replace(URL_QUERY_TOKEN, '$1[REDACTED]')

  // 3. Key=value / key: value echoes (env vars, prose). Preserves key name.
  out = out.replace(KEY_VALUE_PATTERN, (_m, key: string) => `${key}=[REDACTED]`)

  // 4. Bare token shapes that survived the above.
  for (const pattern of BARE_TOKEN_SHAPES) {
    out = out.replace(pattern, '[REDACTED]')
  }

  return out
}

/**
 * Return a scrubbed representation of an arbitrary error-ish value. This
 * is the go-to helper for `logger.error({ err: sanitizeError(err) }, ...)`
 * at forge/git/web/bootstrap boundaries where tokens may leak through
 * upstream library error messages.
 */
export function sanitizeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: sanitizeErrorMessage(err.message),
      stack: err.stack ? sanitizeErrorMessage(err.stack) : undefined,
    }
  }
  if (typeof err === 'string') {
    return { message: sanitizeErrorMessage(err) }
  }
  try {
    return { message: sanitizeErrorMessage(JSON.stringify(err)) }
  } catch {
    return { message: 'unknown error' }
  }
}
