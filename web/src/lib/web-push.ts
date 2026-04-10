/**
 * Phase 2c — Web Push helpers.
 *
 * The server exposes:
 *   GET  /api/push/config       → { enabled, vapidPublicKey }
 *   POST /api/push/subscribe    → persists a PushSubscription
 *   POST /api/push/unsubscribe  → removes a PushSubscription by endpoint
 *
 * This module wraps the browser Push API so the React components
 * only need to call `subscribeToPush()` / `unsubscribeFromPush()`.
 *
 * The operator clicks "Enable notifications" → we check for
 * service worker + Notification API support, request permission,
 * subscribe via PushManager, and POST the resulting endpoint to
 * the server. From that point on the server-side `WebPushChannel`
 * delivers on the configured events.
 */

export interface PushConfig {
  enabled: boolean
  vapidPublicKey: string | null
}

export type PushPermissionState = 'default' | 'granted' | 'denied' | 'unsupported'

const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'

export async function fetchPushConfig(): Promise<PushConfig> {
  const response = await fetch('/api/push/config')
  if (!response.ok) {
    throw new Error(`Failed to read push config (${response.status})`)
  }
  return await response.json() as PushConfig
}

export function getPushPermission(): PushPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
    return 'unsupported'
  }
  return Notification.permission as PushPermissionState
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null
  const registration = await navigator.serviceWorker.ready
  return await registration.pushManager.getSubscription()
}

export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('Push notifications are not supported by this browser')
  }
  if (!('Notification' in window)) {
    throw new Error('Notification API is not available')
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was denied')
  }

  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    await postSubscription(existing)
    return existing
  }

  // Copy into a fresh ArrayBuffer-backed view so TypeScript's
  // PushSubscriptionOptions accepts it (the runtime Uint8Array
  // default backing is ArrayBufferLike which isn't assignable to
  // BufferSource in some lib.dom variants).
  const keyBytes = urlBase64ToUint8Array(vapidPublicKey)
  const applicationServerKey = new Uint8Array(keyBytes).buffer
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  })
  await postSubscription(subscription)
  return subscription
}

export async function unsubscribeFromPush(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return

  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [MUTATION_INTENT_HEADER]: MUTATION_INTENT_VALUE,
    },
    credentials: 'same-origin',
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {
    // best-effort — unsubscribing locally below still proceeds
  })

  await subscription.unsubscribe()
}

async function postSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!p256dh || !auth) {
    throw new Error('Subscription did not include required keys')
  }
  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [MUTATION_INTENT_HEADER]: MUTATION_INTENT_VALUE,
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      keys: { p256dh, auth },
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Server rejected subscription (${response.status})${detail ? `: ${detail}` : ''}`)
  }
}

/**
 * Convert a VAPID public key from base64url-encoded string to the
 * Uint8Array shape the Push API expects as `applicationServerKey`.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i)
  }
  return output
}
