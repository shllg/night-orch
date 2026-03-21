import type { NotificationChannel, NotificationPayload } from '../types.js'
import { logger } from '../../utils/logger.js'

export class WebhookChannel implements NotificationChannel {
  readonly type = 'webhook'

  constructor(
    private url: string,
    private timeoutMs: number = 10_000,
  ) {}

  async send(payload: NotificationPayload): Promise<boolean> {
    const attempt = async (): Promise<Response> => {
      return fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    }

    try {
      let response = await attempt()

      // Retry once on 5xx
      if (response.status >= 500) {
        logger.warn({ status: response.status, url: this.url }, 'Webhook 5xx — retrying once')
        response = await attempt()
      }

      if (!response.ok) {
        logger.warn({ status: response.status, url: this.url }, 'Webhook notification failed')
        return false
      }

      return true
    } catch (err) {
      logger.warn({ url: this.url, err }, 'Webhook notification error')
      return false
    }
  }

  async validate(): Promise<{ valid: boolean; error: string | null }> {
    if (!this.url) {
      return { valid: false, error: 'Webhook URL is empty' }
    }
    try {
      new URL(this.url)
      return { valid: true, error: null }
    } catch {
      return { valid: false, error: `Invalid URL: ${this.url}` }
    }
  }
}
