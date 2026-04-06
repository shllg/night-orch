import type { NotificationChannel, NotificationPayload } from '../types.js'
import { logger } from '../../utils/logger.js'
import {
  HostPolicyError,
  parseAndValidateWebhookUrl,
  redactUrl,
  resolveAndValidatePublicHost,
} from './webhook-common.js'

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
