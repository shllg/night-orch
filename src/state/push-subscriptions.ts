import type Database from 'better-sqlite3'

export interface PushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
}

export function upsertPushSubscription(
  db: Database.Database,
  input: PushSubscriptionInput,
): void {
  db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth`,
    )
    .run(input.endpoint, input.p256dh, input.auth)
}

export function deletePushSubscription(
  db: Database.Database,
  endpoint: string,
): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
}
