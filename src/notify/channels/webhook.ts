import type { NotificationChannel, NotificationPayload } from '../types.js'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { logger } from '../../utils/logger.js'

class HostPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostPolicyError'
  }
}

export class WebhookChannel implements NotificationChannel {
  readonly type = 'webhook'

  constructor(
    private url: string,
    private timeoutMs: number = 10_000,
  ) {}

  async send(payload: NotificationPayload): Promise<boolean> {
    const normalized = parseAndValidateWebhookUrl(this.url)
    if (!normalized.ok) {
      logger.warn({ reason: normalized.reason }, 'Webhook URL rejected')
      return false
    }

    const attempt = async (): Promise<Response> => {
      const hostPolicy = await resolveAndValidatePublicHost(normalized.hostname)
      if (!hostPolicy.ok) {
        throw new HostPolicyError(hostPolicy.reason)
      }

      return fetch(normalized.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    }

    const redactedUrl = redactUrl(normalized.url)
    let lastError: unknown = null
    for (let i = 0; i < 2; i++) {
      try {
        const response = await attempt()
        if (response.ok) {
          return true
        }
        if (response.status >= 500 && i === 0) {
          logger.warn({ status: response.status, url: redactedUrl }, 'Webhook 5xx — retrying once')
          continue
        }
        logger.warn({ status: response.status, url: redactedUrl }, 'Webhook notification failed')
        return false
      } catch (err) {
        if (err instanceof HostPolicyError) {
          logger.warn({ url: redactedUrl, err }, 'Webhook host policy check failed')
          return false
        }
        lastError = err
        if (i === 0) {
          logger.warn({ url: redactedUrl, err }, 'Webhook request error — retrying once')
          continue
        }
      }
    }
    logger.warn({ url: redactedUrl, err: lastError }, 'Webhook notification error')
    return false
  }

  async validate(): Promise<{ valid: boolean; error: string | null }> {
    const parsed = parseAndValidateWebhookUrl(this.url)
    if (!parsed.ok) {
      return { valid: false, error: parsed.reason }
    }

    const hostPolicy = await resolveAndValidatePublicHost(parsed.hostname)
    if (!hostPolicy.ok) {
      return { valid: false, error: hostPolicy.reason }
    }
    return { valid: true, error: null }
  }
}

function parseAndValidateWebhookUrl(raw: string): { ok: true; url: string; hostname: string } | { ok: false; reason: string } {
  if (!raw) {
    return { ok: false, reason: 'Webhook URL is empty' }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: `Invalid URL: ${raw}` }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Webhook URL must use https' }
  }

  if (isPrivateAddress(parsed.hostname) || isPrivateHostname(parsed.hostname)) {
    return { ok: false, reason: 'Webhook URL must not target private or local networks' }
  }

  return { ok: true, url: parsed.toString(), hostname: parsed.hostname }
}

async function resolveAndValidatePublicHost(
  hostname: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const resolved = await lookup(hostname, { all: true })
    for (const entry of resolved) {
      if (isPrivateAddress(entry.address)) {
        return { ok: false, reason: `Webhook host resolves to private address: ${entry.address}` }
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: `Invalid or unresolvable webhook hostname: ${hostname}` }
  }
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
}

function isPrivateAddress(host: string): boolean {
  const ipVersion = isIP(host)
  if (ipVersion === 0) return false
  if (ipVersion === 6) {
    return isPrivateIpv6(host)
  }

  return isPrivateIpv4(host)
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true
  const a = parts[0]!
  const b = parts[1]!
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 0) return true // "this" network
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a >= 224) return true // multicast + reserved
  return false
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')

  // Loopback and unspecified
  if (normalized === '::1' || normalized === '::') return true

  // Unique local addresses (fc00::/7) — either fc or fd prefix.
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  // Link-local (fe80::/10)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')) return true

  // IPv4-mapped IPv6: ::ffff:a.b.c.d — if the mapped v4 is private, reject.
  const mapped = normalized.match(/^::ffff:([0-9.]+)$/)
  if (mapped && mapped[1]) {
    return isPrivateIpv4(mapped[1])
  }

  // IPv4-compatible IPv6 (deprecated, reject conservatively).
  const compat = normalized.match(/^::([0-9.]+)$/)
  if (compat && compat[1]) {
    return isPrivateIpv4(compat[1])
  }

  // Multicast (ff00::/8)
  if (normalized.startsWith('ff')) return true

  return false
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin
  } catch {
    return '[invalid-url]'
  }
}
