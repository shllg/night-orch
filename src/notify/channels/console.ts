import type { NotificationChannel, NotificationPayload } from '../types.js'
import { logger } from '../../utils/logger.js'

export class ConsoleChannel implements NotificationChannel {
  readonly type = 'console'

  async send(payload: NotificationPayload): Promise<boolean> {
    logger.info(
      {
        event: payload.event,
        repo: payload.repo,
        issue: payload.issueNumber,
        pr: payload.prNumber,
      },
      `[${payload.event}] ${payload.issueTitle}: ${payload.summary}`,
    )
    return true
  }

  async validate(): Promise<{ valid: boolean; error: string | null }> {
    return { valid: true, error: null }
  }
}
