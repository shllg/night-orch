import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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
export const CSRF_COOKIE_NAME = 'norch_csrf'
export const SECURE_SESSION_COOKIE_NAME = '__Host-night-orch-session'
export const SECURE_CSRF_COOKIE_NAME = '__Host-night-orch-csrf'
export const CSRF_HEADER_NAME = 'x-csrf-token'

/** Session cookie TTL: 8 hours. */
const SESSION_TTL_SECONDS = 8 * 60 * 60

/** Version byte on the payload so we can rotate the cookie format
 * without having to read the old signature. */
const SESSION_VERSION = 1

interface SessionPayload {
  version: number
  expiresAt: number
}

/** Build the Set-Cookie header value for a fresh session. */
export function buildSessionCookie(secret: Buffer, options: { secure?: boolean } = {}): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const payload: SessionPayload = { version: SESSION_VERSION, expiresAt }
  const token = encodePayload(payload, secret)
  const name = options.secure ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
  return [
    `${name}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

export function createCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

export function buildCsrfCookie(token: string, options: { secure?: boolean } = {}): string {
  const name = options.secure ? SECURE_CSRF_COOKIE_NAME : CSRF_COOKIE_NAME
  return [
    `${name}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

/** Build the Set-Cookie header value that clears the session cookie. */
export function buildClearSessionCookie(options: { secure?: boolean } = {}): string {
  const name = options.secure ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

export function buildClearCsrfCookie(options: { secure?: boolean } = {}): string {
  const name = options.secure ? SECURE_CSRF_COOKIE_NAME : CSRF_COOKIE_NAME
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

export function buildClearAuthCookies(): string[] {
  return [
    buildClearSessionCookie(),
    buildClearCsrfCookie(),
    buildClearSessionCookie({ secure: true }),
    buildClearCsrfCookie({ secure: true }),
  ]
}

/** Parse the `Cookie` header and extract the session cookie value, or null. */
export function extractSessionCookie(req: IncomingMessage): string | null {
  return extractCookie(req, SECURE_SESSION_COOKIE_NAME) ?? extractCookie(req, SESSION_COOKIE_NAME)
}

export function requireCsrfToken(req: IncomingMessage): boolean {
  const cookieToken = extractCookie(req, SECURE_CSRF_COOKIE_NAME) ?? extractCookie(req, CSRF_COOKIE_NAME)
  const headerToken = getSingleHeaderValue(req.headers[CSRF_HEADER_NAME])
  if (!cookieToken || !headerToken) return false

  const cookieBuffer = Buffer.from(cookieToken)
  const headerBuffer = Buffer.from(headerToken)
  if (cookieBuffer.length !== headerBuffer.length) return false
  return timingSafeEqual(cookieBuffer, headerBuffer)
}

function extractCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  const cookies = raw.split(';')
  for (const entry of cookies) {
    const trimmed = entry.trim()
    if (!trimmed.startsWith(`${name}=`)) continue
    const value = trimmed.slice(name.length + 1)
    return value.length > 0 ? value : null
  }
  return null
}

function getSingleHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
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
