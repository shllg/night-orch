import type { NotificationChannel, Notification } from './types.js'
import { logger } from '../utils/logger.js'

export class ConsoleNotifier implements NotificationChannel {
  async send(notification: Notification): Promise<void> {
    logger.info(
      {
        event: notification.event,
        repo: notification.repo,
        issue: notification.issueNumber,
      },
      `[${notification.event}] ${notification.title}: ${notification.message}`,
    )
  }
}
