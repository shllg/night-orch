import type { Config } from '../config/schema.js'
import type { NotificationChannel, Notification, NotificationEvent } from './types.js'
import { ConsoleNotifier } from './console.js'
import { WebhookNotifier } from './webhook.js'
import { logger } from '../utils/logger.js'

export class NotificationDispatcher {
  private channels: NotificationChannel[]
  private enabledEvents: Set<NotificationEvent>

  constructor(config: Config['notifications']) {
    this.channels = config.channels.map((ch) => {
      switch (ch.type) {
        case 'console':
          return new ConsoleNotifier()
        case 'webhook': {
          const url = process.env[ch.urlEnv]
          if (!url) {
            logger.warn({ urlEnv: ch.urlEnv }, 'Webhook URL env var not set — skipping channel')
            return null
          }
          return new WebhookNotifier(url)
        }
        default:
          return null
      }
    }).filter((ch): ch is NotificationChannel => ch !== null)

    this.enabledEvents = new Set<NotificationEvent>()
    const events = config.events
    if (events.onRunStarted) this.enabledEvents.add('onRunStarted')
    if (events.onBlocked) this.enabledEvents.add('onBlocked')
    if (events.onPrReady) this.enabledEvents.add('onPrReady')
    if (events.onError) this.enabledEvents.add('onError')
    if (events.onRetryExhausted) this.enabledEvents.add('onRetryExhausted')
  }

  async notify(notification: Notification): Promise<void> {
    if (!this.enabledEvents.has(notification.event)) return

    // Best-effort, parallel dispatch
    await Promise.allSettled(
      this.channels.map((ch) => ch.send(notification)),
    )
  }
}
