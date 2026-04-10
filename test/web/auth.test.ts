import { describe, it, expect } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import {
  SESSION_COOKIE_NAME,
  buildClearSessionCookie,
  buildSessionCookie,
  extractSessionCookie,
  verifySessionCookie,
} from '../../src/web/auth.js'
import type { IncomingMessage } from 'node:http'

function makeReq(cookieHeader?: string): IncomingMessage {
  return {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  } as unknown as IncomingMessage
}

describe('web/auth — session cookie helpers', () => {
  describe('buildSessionCookie', () => {
    it('emits a well-formed Set-Cookie value with HttpOnly and SameSite=Lax', () => {
      const secret = randomBytes(32)
      const header = buildSessionCookie(secret)
      expect(header).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`))
      expect(header).toContain('Path=/')
      expect(header).toContain('Max-Age=')
      expect(header).toContain('HttpOnly')
      expect(header).toContain('SameSite=Lax')
    })

    it('includes a signed payload that roundtrips through verify', () => {
      const secret = randomBytes(32)
      const header = buildSessionCookie(secret)
      const token = header.split(';')[0]!.split('=')[1]
      const payload = verifySessionCookie(token, secret)
      expect(payload).not.toBeNull()
      expect(payload?.version).toBe(1)
      expect(payload?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    })
  })

  describe('verifySessionCookie', () => {
    it('rejects a null or empty token', () => {
      const secret = randomBytes(32)
      expect(verifySessionCookie(null, secret)).toBeNull()
      expect(verifySessionCookie(undefined, secret)).toBeNull()
      expect(verifySessionCookie('', secret)).toBeNull()
    })

    it('rejects a token without the body.signature separator', () => {
      const secret = randomBytes(32)
      expect(verifySessionCookie('notvalid', secret)).toBeNull()
    })

    it('rejects a token signed with a different secret', () => {
      const secretA = randomBytes(32)
      const secretB = randomBytes(32)
      const header = buildSessionCookie(secretA)
      const token = header.split(';')[0]!.split('=')[1]
      expect(verifySessionCookie(token, secretA)).not.toBeNull()
      expect(verifySessionCookie(token, secretB)).toBeNull()
    })

    it('rejects a tampered token', () => {
      const secret = randomBytes(32)
      const header = buildSessionCookie(secret)
      const token = header.split(';')[0]!.split('=')[1] ?? ''
      // Flip the first character of the body — anything that gets
      // the base64url decode past the first byte will change the
      // HMAC and fail the signature check.
      const flipped = token.startsWith('A') ? 'B' + token.slice(1) : 'A' + token.slice(1)
      expect(verifySessionCookie(flipped, secret)).toBeNull()
    })

    it('rejects an expired token', () => {
      // Hand-craft a valid signature over an expired payload so we
      // exercise the expiry check specifically (not just the
      // signature path).
      const secret = randomBytes(32)
      const expiredPayload = {
        version: 1,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }
      const body = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url')
      const sig = createHmac('sha256', secret).update(body).digest().toString('base64url')
      const token = `${body}.${sig}`
      expect(verifySessionCookie(token, secret)).toBeNull()
    })

    it('rejects a token with an unknown version', () => {
      const secret = randomBytes(32)
      const futurePayload = {
        version: 999,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }
      const body = Buffer.from(JSON.stringify(futurePayload)).toString('base64url')
      const sig = createHmac('sha256', secret).update(body).digest().toString('base64url')
      const token = `${body}.${sig}`
      expect(verifySessionCookie(token, secret)).toBeNull()
    })
  })

  describe('extractSessionCookie', () => {
    it('returns null when no cookie header is present', () => {
      expect(extractSessionCookie(makeReq())).toBeNull()
    })

    it('returns the cookie value when set alongside other cookies', () => {
      const req = makeReq(`other=value; ${SESSION_COOKIE_NAME}=abc.def; another=foo`)
      expect(extractSessionCookie(req)).toBe('abc.def')
    })

    it('returns null when the session cookie is empty', () => {
      const req = makeReq(`${SESSION_COOKIE_NAME}=`)
      expect(extractSessionCookie(req)).toBeNull()
    })

    it('end-to-end: build and extract and verify', () => {
      const secret = randomBytes(32)
      const setCookie = buildSessionCookie(secret)
      const cookieValue = setCookie.split(';')[0] ?? ''
      const req = makeReq(cookieValue)
      const extracted = extractSessionCookie(req)
      const payload = verifySessionCookie(extracted, secret)
      expect(payload).not.toBeNull()
    })
  })

  describe('buildClearSessionCookie', () => {
    it('returns a Max-Age=0 Set-Cookie header', () => {
      const header = buildClearSessionCookie()
      expect(header).toContain(`${SESSION_COOKIE_NAME}=`)
      expect(header).toContain('Max-Age=0')
    })
  })
})
