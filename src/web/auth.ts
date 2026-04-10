import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Phase 2a: stateless signed session cookies for the web UI.
 *
 * Before Phase 2 the only way to authenticate a mutation from a
 * non-loopback browser was to set `x-night-orch-web-token` on every
 * request. That forced the frontend to stash the token in a
 * JavaScript variable (readable by any XSS), and mobile browsers
 * had no UX for pasting the token — making the web UI effectively
 * desktop-only for remote use.
 *
 * This module adds a minimal HMAC-signed session cookie so browsers
 * can bootstrap once with the operator token and then present an
 * HttpOnly cookie on subsequent mutations. There is NO server-side
 * session table — the cookie encodes its own expiry and is verified
 * by HMAC against a secret that lives for the server's lifetime
 * (regenerated on each restart, which is a deliberate trade-off:
 * the operator has to log in again after a daemon restart in
 * exchange for not needing a migration).
 *
 * The header-token path is preserved unchanged so CLI tools and
 * integrations that already speak `x-night-orch-web-token` keep
 * working.
 */

export const SESSION_COOKIE_NAME = 'norch_session'

/** Session cookie TTL: 7 days. Short enough that a stolen cookie
 * stops working quickly, long enough that mobile users don't have
 * to re-auth daily. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/** Version byte on the payload so we can rotate the cookie format
 * without having to read the old signature. */
const SESSION_VERSION = 1

interface SessionPayload {
  version: number
  expiresAt: number
}

/** Build the Set-Cookie header value for a fresh session. */
export function buildSessionCookie(secret: Buffer): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const payload: SessionPayload = { version: SESSION_VERSION, expiresAt }
  const token = encodePayload(payload, secret)
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    // SameSite=Lax lets the cookie ride along on top-level navigations
    // (useful for GitHub OAuth redirects in Phase 3) while blocking
    // cross-site subrequests. Secure is omitted on HTTP because Chrome
    // refuses to accept Secure cookies on insecure origins; callers
    // that need it over HTTPS should set it via a reverse proxy or
    // future TLS support.
    'SameSite=Lax',
  ].join('; ')
}

/** Build the Set-Cookie header value that clears the session cookie. */
export function buildClearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ')
}

/** Parse the `Cookie` header and extract the session cookie value, or null. */
export function extractSessionCookie(req: IncomingMessage): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  const cookies = raw.split(';')
  for (const entry of cookies) {
    const trimmed = entry.trim()
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue
    const value = trimmed.slice(SESSION_COOKIE_NAME.length + 1)
    return value.length > 0 ? value : null
  }
  return null
}

/**
 * Verify a session-cookie value against the HMAC secret. Returns the
 * decoded payload on success, or null on any failure (unknown
 * version, bad signature, expired, malformed).
 */
export function verifySessionCookie(
  token: string | null | undefined,
  secret: Buffer,
): SessionPayload | null {
  if (!token) return null

  const dotIndex = token.indexOf('.')
  if (dotIndex < 0) return null
  const body = token.slice(0, dotIndex)
  const providedSig = token.slice(dotIndex + 1)
  if (body.length === 0 || providedSig.length === 0) return null

  let payload: SessionPayload
  try {
    const decoded = Buffer.from(body, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { version?: unknown }).version !== 'number' ||
      typeof (parsed as { expiresAt?: unknown }).expiresAt !== 'number'
    ) {
      return null
    }
    payload = parsed as SessionPayload
  } catch {
    return null
  }

  if (payload.version !== SESSION_VERSION) return null

  const expectedSig = signBody(body, secret)
  const providedBuf = decodeBase64Url(providedSig)
  if (providedBuf === null) return null
  if (providedBuf.length !== expectedSig.length) return null
  if (!timingSafeEqual(providedBuf, expectedSig)) return null

  const now = Math.floor(Date.now() / 1000)
  if (payload.expiresAt <= now) return null

  return payload
}

function encodePayload(payload: SessionPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = signBody(body, secret).toString('base64url')
  return `${body}.${sig}`
}

function signBody(body: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function decodeBase64Url(value: string): Buffer | null {
  try {
    return Buffer.from(value, 'base64url')
  } catch {
    return null
  }
}
