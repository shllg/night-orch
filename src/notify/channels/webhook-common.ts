import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class HostPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostPolicyError'
  }
}

export function parseAndValidateWebhookUrl(
  raw: string,
): { ok: true; url: string; hostname: string } | { ok: false; reason: string } {
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

export async function resolveAndValidatePublicHost(
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

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin
  } catch {
    return '[invalid-url]'
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
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')

  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')) return true

  const mapped = normalized.match(/^::ffff:([0-9.]+)$/)
  if (mapped && mapped[1]) {
    return isPrivateIpv4(mapped[1])
  }

  const compat = normalized.match(/^::([0-9.]+)$/)
  if (compat && compat[1]) {
    return isPrivateIpv4(compat[1])
  }

  if (normalized.startsWith('ff')) return true

  return false
}
