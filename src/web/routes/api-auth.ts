import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import type { RouteHandler } from './context.js'
import { writeJson, readJsonBody } from '../server.js'
import {
  SESSION_COOKIE_NAME,
  buildClearAuthCookies,
  buildCsrfCookie,
  buildSessionCookie,
  createCsrfToken,
  extractSessionCookie,
  verifySessionCookie,
} from '../auth.js'

const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'

/**
 * Phase 2a routes:
 *  - `POST /api/auth/session` body `{token}` — bootstrap a signed
 *    session cookie from the operator token. Returns 204 on
 *    success with a Set-Cookie header.
 *  - `POST /api/auth/logout` — clears the session cookie. 204.
 *  - `GET /api/auth/session` — reports whether the current request
 *    carries a valid session cookie. Used by the frontend on
 *    startup to decide whether to show the token entry dialog.
 *
 * The bootstrap endpoint lives outside the mutation-guard prefix
 * (`/api/operations/…`, `/api/agent/…`) because it IS the login
 * flow — requiring an existing session cookie to call it would be
 * a chicken-and-egg. It still enforces the intent header and JSON
 * content type to block trivial form-submission CSRF.
 */
export const handleAuthRoutes: RouteHandler = async (
  req,
  res,
  method,
  pathname,
  _searchParams,
  ctx,
) => {
  if (method === 'GET' && pathname === '/api/auth/session') {
    const cookie = extractSessionCookie(req)
    const payload = verifySessionCookie(cookie, ctx.security.sessionSecret)
    writeJson(res, 200, {
      authenticated: payload !== null,
      operatorAuthMode: ctx.security.operatorAuthMode,
    })
    return true
  }

  if (method === 'POST' && pathname === '/api/auth/session') {
    if (!enforceBootstrapGuards(req, res)) return true

    const body = await readJsonBody(req).catch(() => null)
    if (!body || typeof body.token !== 'string' || body.token.length === 0) {
      writeJson(res, 400, { error: 'Request body must be {token: string}' })
      return true
    }

    if (!isMatchingToken(body.token, ctx.security.webMutationToken)) {
      writeJson(res, 401, { error: 'Invalid token' })
      return true
    }

    const secureCookie = isSecureCookieRequest(req, ctx.security.trustedProxy)
    const csrfToken = createCsrfToken()
    res.setHeader('Set-Cookie', [
      buildSessionCookie(ctx.security.sessionSecret, { secure: secureCookie }),
      buildCsrfCookie(csrfToken, { secure: secureCookie }),
    ])
    writeJson(res, 204, null)
    return true
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    if (!enforceBootstrapGuards(req, res)) return true

    res.setHeader('Set-Cookie', buildClearAuthCookies())
    writeJson(res, 204, null)
    return true
  }

  return false
}

function enforceBootstrapGuards(req: IncomingMessage, res: ServerResponse): boolean {
  const intent = getSingleHeaderValue(req.headers[MUTATION_INTENT_HEADER])
  if (intent !== MUTATION_INTENT_VALUE) {
    writeJson(res, 403, { error: `Missing required header: ${MUTATION_INTENT_HEADER}` })
    return false
  }
  const contentType = getSingleHeaderValue(req.headers['content-type'])
  if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
    writeJson(res, 415, { error: 'Content-Type must be application/json' })
    return false
  }
  return true
}

function getSingleHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

function isSecureCookieRequest(req: IncomingMessage, trustedProxy: boolean): boolean {
  if (trustedProxy) {
    const forwardedProto = getSingleHeaderValue(req.headers['x-forwarded-proto'])
    if (forwardedProto?.toLowerCase() === 'https') return true
  }

  return (req.socket as { encrypted?: boolean }).encrypted === true
}

/**
 * Constant-time comparison of the bootstrap token against the
 * operator token. Uses SHA-256 digests so the comparison length is
 * fixed regardless of operator token length (which `timingSafeEqual`
 * requires).
 */
function isMatchingToken(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

// Re-exported so tests can assert the cookie name without hard-coding
// the string and catch any silent rename.
export { SESSION_COOKIE_NAME }
