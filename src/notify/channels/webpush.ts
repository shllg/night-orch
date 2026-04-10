import type Database from 'better-sqlite3'
import type { NotificationChannel, NotificationPayload } from '../types.js'
import { logger } from '../../utils/logger.js'

/**
 * Phase 2c: Web Push notification channel.
 *
 * Reads all persisted PushSubscription rows from the
 * `push_subscriptions` table (migration 027) and fans out the
 * notification via the `web-push` library's HTTPS delivery. Each
 * subscription's VAPID signature is scoped to the operator's
 * public/private key pair, read from env via the config-declared
 * env var names.
 *
 * Subscriptions that return `410 Gone` or `404 Not Found` (the
 * standard "gone" codes per the Web Push spec) are deleted on the
 * spot so the table stays clean as browsers rotate or uninstall
 * permissions. Other failures are logged with the last error on
 * the row but the subscription is kept — transient server issues
 * shouldn't evict an otherwise-valid endpoint.
 */
interface PushSubscriptionRow {
  id: number
  endpoint: string
  p256dh: string
  auth: string
}

interface WebPushModule {
  setVapidDetails: (
    subject: string,
    publicKey: string,
    privateKey: string,
  ) => void
  sendNotification: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload?: string | Buffer | null,
    options?: { TTL?: number },
  ) => Promise<unknown>
}

export class WebPushChannel implements NotificationChannel {
  readonly type = 'webpush'
  private webpush: WebPushModule | null = null
  private configured = false

  constructor(
    private readonly db: Database.Database,
    private readonly vapidPublicKey: string,
    private readonly vapidPrivateKey: string,
    private readonly vapidSubject: string,
  ) {}

  async send(payload: NotificationPayload): Promise<boolean> {
    const webpush = await this.ensureWebPush()
    if (!webpush) return false

    const rows = this.db
      .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions')
      .all() as PushSubscriptionRow[]

    if (rows.length === 0) {
      logger.debug({ event: payload.event }, 'Web push skipped — no subscriptions')
      return true
    }

    const body = buildWebPushBody(payload)
    let successes = 0
    let failures = 0

    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: row.endpoint,
              keys: { p256dh: row.p256dh, auth: row.auth },
            },
            body,
            { TTL: 3600 },
          )
          successes++
          this.db
            .prepare(`UPDATE push_subscriptions SET last_sent_at = datetime('now'), last_error = NULL WHERE id = ?`)
            .run(row.id)
        } catch (err) {
          failures++
          const status = extractStatusCode(err)
          if (status === 404 || status === 410) {
            // Subscription is gone — prune it.
            this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id)
            logger.info(
              { endpoint: redactEndpoint(row.endpoint), status },
              'Pruned expired push subscription',
            )
            return
          }
          const message = err instanceof Error ? err.message : String(err)
          this.db
            .prepare(`UPDATE push_subscriptions SET last_error = ? WHERE id = ?`)
            .run(message.slice(0, 500), row.id)
          logger.warn(
            { endpoint: redactEndpoint(row.endpoint), err: message },
            'Web push delivery failed',
          )
        }
      }),
    )

    logger.info(
      { event: payload.event, successes, failures, total: rows.length },
      'Web push dispatched',
    )
    return successes > 0
  }

  async validate(): Promise<{ valid: boolean; error: string | null }> {
    if (!this.vapidPublicKey || !this.vapidPrivateKey || !this.vapidSubject) {
      return { valid: false, error: 'VAPID keys or subject missing from environment' }
    }
    // Attempt to load web-push to verify the dependency is installed
    // and the keys are accepted by `setVapidDetails`.
    const loaded = await this.ensureWebPush()
    if (!loaded) {
      return { valid: false, error: 'web-push module is not installed' }
    }
    try {
      loaded.setVapidDetails(this.vapidSubject, this.vapidPublicKey, this.vapidPrivateKey)
    } catch (err) {
      return { valid: false, error: `VAPID config rejected: ${err instanceof Error ? err.message : String(err)}` }
    }
    return { valid: true, error: null }
  }

  private async ensureWebPush(): Promise<WebPushModule | null> {
    if (this.webpush && this.configured) return this.webpush
    try {
      const mod = (await import('web-push')) as unknown as {
        default?: WebPushModule
      } & WebPushModule
      this.webpush = mod.default ?? mod
      this.webpush.setVapidDetails(this.vapidSubject, this.vapidPublicKey, this.vapidPrivateKey)
      this.configured = true
      return this.webpush
    } catch (err) {
      logger.error({ err }, 'Failed to load or configure web-push module')
      return null
    }
  }
}

/**
 * Build the encrypted payload body delivered to the service worker.
 * Matches the `PushNotificationPayload` shape consumed by
 * `web/public/sw.js`.
 */
function buildWebPushBody(payload: NotificationPayload): string {
  const body: Record<string, unknown> = {
    event: payload.event,
    title: describeEventTitle(payload),
    body: describeEventBody(payload),
    repo: payload.repo,
    issueNumber: payload.issueNumber,
    issueTitle: payload.issueTitle,
    timestamp: payload.timestamp,
  }
  if (payload.prUrl) body['prUrl'] = payload.prUrl
  return JSON.stringify(body)
}

function describeEventTitle(payload: NotificationPayload): string {
  const repoShort = payload.repo.split('/').pop() ?? payload.repo
  switch (payload.event) {
    case 'run_started':
      return `night-orch started ${repoShort}#${payload.issueNumber}`
    case 'blocked':
      return `night-orch blocked ${repoShort}#${payload.issueNumber}`
    case 'pr_ready':
      return `PR ready: ${repoShort}#${payload.issueNumber}`
    case 'pr_updated':
      return `PR updated: ${repoShort}#${payload.issueNumber}`
    case 'error':
      return `night-orch error ${repoShort}#${payload.issueNumber}`
    case 'retry_exhausted':
      return `Retries exhausted: ${repoShort}#${payload.issueNumber}`
    default:
      return `night-orch ${String(payload.event)}`
  }
}

function describeEventBody(payload: NotificationPayload): string {
  if (payload.summary) return payload.summary
  if (payload.blockingReason) return payload.blockingReason
  return payload.issueTitle || 'Open the dashboard for details.'
}

function extractStatusCode(err: unknown): number | null {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const code = (err as { statusCode: unknown }).statusCode
    if (typeof code === 'number') return code
  }
  return null
}

function redactEndpoint(endpoint: string): string {
  // Keep the origin for debugging, drop the unique token.
  try {
    const url = new URL(endpoint)
    return `${url.origin}/…`
  } catch {
    return '[invalid-endpoint]'
  }
}
