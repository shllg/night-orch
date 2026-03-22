import type { NotificationChannel, NotificationPayload } from '../types.js'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { logger } from '../../utils/logger.js'

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
      return fetch(normalized.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

    try {
      const resolved = await lookup(parsed.hostname, { all: true })
      for (const entry of resolved) {
        if (isPrivateAddress(entry.address)) {
          return { valid: false, error: `Webhook host resolves to private address: ${entry.address}` }
        }
      }
      return { valid: true, error: null }
    } catch {
      return { valid: false, error: `Invalid or unresolvable webhook URL: ${redactUrl(parsed.url)}` }
    }
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
    const normalized = host.toLowerCase()
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')
  }

  const parts = host.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true
  const a = parts[0]!
  const b = parts[1]!
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
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
