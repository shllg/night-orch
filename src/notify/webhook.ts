import type { NotificationChannel, Notification } from './types.js'
import { logger } from '../utils/logger.js'

export class WebhookNotifier implements NotificationChannel {
  constructor(private url: string) {}

  async send(notification: Notification): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        logger.warn(
          { status: response.status, url: this.url },
          'Webhook notification failed',
        )
      }
    } catch (err) {
      logger.warn({ url: this.url, err }, 'Webhook notification error')
    }
  }
}
