import type { NotificationChannel, NotificationEvent, NotificationPayload } from '../types.js'
import { logger } from '../../utils/logger.js'
import {
  HostPolicyError,
  parseAndValidateWebhookUrl,
  redactUrl,
  resolveAndValidatePublicHost,
} from './webhook-common.js'

interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

interface DiscordEmbed {
  title: string
  url?: string
  description?: string
  color: number
  timestamp: string
  fields: DiscordEmbedField[]
}

interface DiscordWebhookBody {
  embeds: DiscordEmbed[]
  allowed_mentions: {
    parse: string[]
    users: string[]
    roles: string[]
    replied_user: boolean
  }
}

const EVENT_META: Record<NotificationEvent, { label: string; color: number; actionRequired: boolean }> = {
  run_started: { label: 'Run started', color: 0x3498db, actionRequired: false },
  blocked: { label: 'Run blocked', color: 0xe74c3c, actionRequired: true },
  pr_ready: { label: 'PR ready', color: 0x2ecc71, actionRequired: true },
  pr_updated: { label: 'PR updated', color: 0x1abc9c, actionRequired: true },
  error: { label: 'Run error', color: 0xe67e22, actionRequired: true },
  retry_exhausted: { label: 'Retries exhausted', color: 0xc0392b, actionRequired: true },
}

const DISCORD_MAX_TITLE = 256
const DISCORD_MAX_DESCRIPTION = 4096
const DISCORD_MAX_FIELD_VALUE = 1024
const DISCORD_MAX_FIELDS = 25

export class DiscordChannel implements NotificationChannel {
  readonly type = 'discord'

  constructor(
    private url: string,
    private timeoutMs: number = 10_000,
  ) {}

  async send(payload: NotificationPayload): Promise<boolean> {
    const normalized = parseAndValidateWebhookUrl(this.url)
    if (!normalized.ok) {
      logger.warn({ reason: normalized.reason }, 'Discord webhook URL rejected')
      return false
    }

    const requestBody = buildDiscordWebhookBody(payload)
    const attempt = async (): Promise<Response> => {
      const hostPolicy = await resolveAndValidatePublicHost(normalized.hostname)
      if (!hostPolicy.ok) {
        throw new HostPolicyError(hostPolicy.reason)
      }

      return fetch(normalized.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify(requestBody),
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
          logger.warn({ status: response.status, url: redactedUrl }, 'Discord webhook 5xx — retrying once')
          continue
        }
        logger.warn({ status: response.status, url: redactedUrl }, 'Discord notification failed')
        return false
      } catch (err) {
        if (err instanceof HostPolicyError) {
          logger.warn({ url: redactedUrl, err }, 'Discord webhook host policy check failed')
          return false
        }
        lastError = err
        if (i === 0) {
          logger.warn({ url: redactedUrl, err }, 'Discord webhook request error — retrying once')
          continue
        }
      }
    }

    logger.warn({ url: redactedUrl, err: lastError }, 'Discord notification error')
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

function buildDiscordWebhookBody(payload: NotificationPayload): DiscordWebhookBody {
  const meta = EVENT_META[payload.event]
  const issueLabel = sanitizeDiscordText(`#${payload.issueNumber} ${payload.issueTitle}`)
  const issueValue = payload.issueUrl
    ? `${truncate(issueLabel, 900)}\n${payload.issueUrl}`
    : truncate(issueLabel, DISCORD_MAX_FIELD_VALUE)
  const summary = sanitizeDiscordText(payload.summary).trim()
  const fields: DiscordEmbedField[] = [
    {
      name: 'Repository',
      value: truncate(sanitizeDiscordText(payload.repo), DISCORD_MAX_FIELD_VALUE),
      inline: true,
    },
    {
      name: 'Event',
      value: meta.label,
      inline: true,
    },
    {
      name: 'Iteration',
      value: String(payload.iterationCount),
      inline: true,
    },
    {
      name: 'Issue',
      value: truncate(issueValue, DISCORD_MAX_FIELD_VALUE),
    },
  ]

  if (payload.prUrl) {
    const prLabel = payload.prNumber ? `PR #${payload.prNumber}` : 'Open PR'
    fields.push({
      name: 'Pull Request',
      value: truncate(`${prLabel}\n${payload.prUrl}`, DISCORD_MAX_FIELD_VALUE),
      inline: true,
    })
  }

  if (payload.blockingReason) {
    fields.push({
      name: 'Blocking Reason',
      value: truncate(sanitizeDiscordText(payload.blockingReason), DISCORD_MAX_FIELD_VALUE),
    })
  }

  if (payload.reviewSummary) {
    fields.push({
      name: 'Review',
      value: truncate(sanitizeDiscordText(payload.reviewSummary), DISCORD_MAX_FIELD_VALUE),
    })
  }

  fields.push({
    name: 'State',
    value: truncate(sanitizeDiscordText(payload.state), DISCORD_MAX_FIELD_VALUE),
    inline: true,
  })

  const titlePrefix = meta.actionRequired ? 'Action Required' : 'night-orch'
  const embedUrl = payload.prUrl ?? payload.issueUrl ?? undefined

  return {
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    },
    embeds: [{
      title: truncate(`${titlePrefix}: ${meta.label}`, DISCORD_MAX_TITLE),
      ...(embedUrl ? { url: embedUrl } : {}),
      ...(summary ? { description: truncate(summary, DISCORD_MAX_DESCRIPTION) } : {}),
      color: meta.color,
      timestamp: payload.timestamp,
      fields: fields.slice(0, DISCORD_MAX_FIELDS),
    }],
  }
}

function sanitizeDiscordText(value: string): string {
  const stripped = stripControlChars(value)
    .replace(/\s+/g, ' ')
    .trim()
  const escapedMentions = stripped.replace(/@/g, '@\u200B')
  return escapedMentions
    .replace(/\\/g, '\\\\')
    .replace(/([`*_~|>#[\]()])/g, '\\$1')
}

function stripControlChars(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if ((code >= 0 && code <= 31) || code === 127) {
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}
