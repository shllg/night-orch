import type Database from 'better-sqlite3'

/**
 * Phase 2c: Web Push subscriptions.
 *
 * Each browser that grants notification permission posts its
 * PushSubscription object (endpoint + p256dh + auth) to
 * `POST /api/push/subscribe`, which persists it here. The
 * `WebPushChannel` reads all rows at send-time and fans out the
 * notification via the `web-push` library.
 *
 * The table stores the same three fields the Push API hands the
 * service worker: `endpoint` is the unique HTTPS URL the browser
 * uses to deliver pushes, and `p256dh`/`auth` are the encryption
 * keys needed to sign payload encryption per RFC 8291.
 *
 * `endpoint` is UNIQUE because re-subscribing from the same browser
 * returns the same endpoint and we want the upsert to replace the
 * keys rather than accumulate duplicates.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_sent_at TEXT,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created
      ON push_subscriptions(created_at);
  `)
}
