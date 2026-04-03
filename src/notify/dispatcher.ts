import type { Config } from '../config/schema.js'
import type { NotificationChannel, NotificationPayload, NotificationEvent, NotificationReport } from './types.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'

const EVENT_CONFIG_MAP: Record<NotificationEvent, keyof Config['notifications']['events']> = {
  run_started: 'onRunStarted',
  blocked: 'onBlocked',
  pr_ready: 'onPrReady',
  pr_updated: 'onPrReady',
  error: 'onError',
  retry_exhausted: 'onRetryExhausted',
}

export class NotificationDispatcher {
  constructor(
    private channels: NotificationChannel[],
    private eventConfig: Config['notifications']['events'],
  ) {}

  async dispatch(payload: NotificationPayload): Promise<NotificationReport> {
    const configKey = EVENT_CONFIG_MAP[payload.event]
    if (configKey && !this.eventConfig[configKey]) {
      logger.debug({ event: payload.event }, 'Event not enabled — skipping notification')
      return { sent: [], totalSent: 0, totalFailed: 0 }
    }

    return this.sendToAll(payload)
  }

  async sendTest(): Promise<NotificationReport> {
    const testPayload: NotificationPayload = {
      event: 'pr_ready',
      repo: 'test/test-repo',
      issueNumber: 0,
      issueTitle: 'Test Notification',
      state: 'test',
      prUrl: null,
      prNumber: null,
      summary: 'This is a test notification from night-orch.',
      blockingReason: null,
      reviewSummary: null,
      iterationCount: 0,
      timestamp: nowUtcIso(),
    }

    return this.sendToAll(testPayload)
  }

  private async sendToAll(payload: NotificationPayload): Promise<NotificationReport> {
    const results = await Promise.allSettled(
      this.channels.map(async (ch) => {
        const success = await ch.send(payload)
        return { channel: ch.type, success, error: success ? null : 'Channel returned false' }
      }),
    )

    const sent: NotificationReport['sent'] = results.map((r, i) => {
      if (r.status === 'fulfilled') {
        return r.value
      }
      return {
        channel: this.channels[i]?.type ?? 'unknown',
        success: false,
        error: (r.reason as Error).message ?? String(r.reason),
      }
    })

    const totalSent = sent.filter((s) => s.success).length
    const totalFailed = sent.filter((s) => !s.success).length

    if (totalFailed > 0) {
      logger.warn({ totalFailed, event: payload.event }, 'Some notification channels failed')
    }

    return { sent, totalSent, totalFailed }
  }
}
