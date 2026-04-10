import type { RouteHandler } from './context.js'
import { writeJson, readJsonBody } from '../server.js'

/**
 * Phase 2c: Web Push configuration + subscription endpoints.
 *
 * The frontend flow:
 *  1. GET /api/push/config → `{enabled, vapidPublicKey}`. When
 *     enabled is false the UI hides the "Enable notifications"
 *     button; when true it initiates the browser's
 *     `PushManager.subscribe({userVisibleOnly:true, applicationServerKey})`
 *     flow using the returned public key.
 *  2. POST /api/push/subscribe body={endpoint, keys:{p256dh, auth}}
 *     → server upserts the subscription into `push_subscriptions`.
 *     Requires mutation auth (cookie or header) since it's a
 *     state-changing write.
 *
 * VAPID public key discovery walks the configured notification
 * channels looking for the first `webpush` channel and reads the
 * public-key env var. If no webpush channel is configured the
 * endpoint reports `enabled: false`.
 */
export const handlePushRoutes: RouteHandler = async (
  req,
  res,
  method,
  pathname,
  _searchParams,
  ctx,
) => {
  if (method === 'GET' && pathname === '/api/push/config') {
    const webpushChannel = ctx.deps.config.notifications.channels.find(
      (ch): ch is Extract<typeof ch, { type: 'webpush' }> => ch.type === 'webpush',
    )
    if (!webpushChannel) {
      writeJson(res, 200, { enabled: false, vapidPublicKey: null })
      return true
    }
    const vapidPublicKey = process.env[webpushChannel.vapidPublicKeyEnv] ?? null
    writeJson(res, 200, {
      enabled: vapidPublicKey !== null,
      vapidPublicKey,
    })
    return true
  }

  if (method === 'POST' && pathname === '/api/push/subscribe') {
    const body = (await readJsonBody(req).catch(() => null)) as {
      endpoint?: unknown
      keys?: { p256dh?: unknown; auth?: unknown }
    } | null
    if (
      !body ||
      typeof body.endpoint !== 'string' ||
      !body.keys ||
      typeof body.keys.p256dh !== 'string' ||
      typeof body.keys.auth !== 'string'
    ) {
      writeJson(res, 400, { error: 'Request body must be {endpoint, keys:{p256dh, auth}}' })
      return true
    }

    try {
      ctx.deps.db
        .prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
           VALUES (?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             p256dh = excluded.p256dh,
             auth = excluded.auth`,
        )
        .run(body.endpoint, body.keys.p256dh, body.keys.auth)
      writeJson(res, 204, null)
    } catch (err) {
      writeJson(res, 500, {
        error: `Failed to persist subscription: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/push/unsubscribe') {
    const body = (await readJsonBody(req).catch(() => null)) as {
      endpoint?: unknown
    } | null
    if (!body || typeof body.endpoint !== 'string') {
      writeJson(res, 400, { error: 'Request body must be {endpoint}' })
      return true
    }
    ctx.deps.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(body.endpoint)
    writeJson(res, 204, null)
    return true
  }

  return false
}
