import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { ButtonWeb } from '../../../src/components/button/button.web.js'
import {
  currentSubscription,
  fetchPushConfig,
  getPushPermission,
  subscribeToPush,
  unsubscribeFromPush,
  type PushConfig,
  type PushPermissionState,
} from '../lib/web-push.js'

/**
 * Phase 2c: Self-contained Push notification controls dropped into
 * the settings page. Handles:
 *  - Feature detection (service worker + Notification API)
 *  - Server config (is the webpush channel enabled + VAPID key)
 *  - Current browser subscription state
 *  - Permission request + PushManager.subscribe / unsubscribe
 *  - Persisting the subscription on the server
 *
 * Keeps all state local so it can be dropped into any page without
 * extending the parent component's prop contract.
 */
export function PushNotificationSettings(): ReactElement {
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [permission, setPermission] = useState<PushPermissionState>('default')
  const [subscribed, setSubscribed] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [cfg, sub] = await Promise.all([
        fetchPushConfig(),
        currentSubscription(),
      ])
      setConfig(cfg)
      setPermission(getPushPermission())
      setSubscribed(sub !== null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleEnable = useCallback(async () => {
    if (!config?.vapidPublicKey) {
      setError('Server has no VAPID public key configured')
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await subscribeToPush(config.vapidPublicKey)
      setSubscribed(true)
      setPermission(getPushPermission())
      setStatus('Push notifications enabled. The browser will receive blocked-run and PR-ready alerts.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [config?.vapidPublicKey])

  const handleDisable = useCallback(async () => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await unsubscribeFromPush()
      setSubscribed(false)
      setStatus('Push notifications disabled.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  // Case 1: browser doesn't support push at all.
  if (permission === 'unsupported') {
    return (
      <div className="mt-6 rounded-box border border-base-300/70 bg-base-100/60 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/80">
          Push notifications
        </h3>
        <p className="mt-2 text-xs text-base-content/70">
          This browser doesn&apos;t support web push. Try a recent Chrome, Firefox, Edge, or
          Safari&nbsp;16.4+.
        </p>
      </div>
    )
  }

  // Case 2: server-side webpush channel is not configured.
  if (config && !config.enabled) {
    return (
      <div className="mt-6 rounded-box border border-base-300/70 bg-base-100/60 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/80">
          Push notifications
        </h3>
        <p className="mt-2 text-xs text-base-content/70">
          Server has no <code className="font-mono">webpush</code> notification channel configured.
          Add one to <code className="font-mono">notifications.channels</code> in config and set
          the VAPID env vars, then restart night-orch. Generate keys with{' '}
          <code className="font-mono">npx web-push generate-vapid-keys</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-6 rounded-box border border-base-300/70 bg-base-100/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/80">
            Push notifications
          </h3>
          <p className="mt-1 text-xs text-base-content/65">
            {subscribed
              ? 'This browser is subscribed. You will receive blocked-run, PR-ready, and retry-exhausted alerts even when the tab is closed.'
              : 'Subscribe this browser to receive background alerts for blocked runs and ready PRs.'}
          </p>
        </div>
        <div className="flex gap-2">
          {subscribed ? (
            <ButtonWeb
              type="button"
              disabled={busy}
              onClick={() => {
                void handleDisable()
              }}
              tone="ghost"
              size="sm"
            >
              {busy ? 'Disabling…' : 'Disable'}
            </ButtonWeb>
          ) : (
            <ButtonWeb
              type="button"
              disabled={busy || permission === 'denied'}
              onClick={() => {
                void handleEnable()
              }}
              tone="primary"
              size="sm"
              title={permission === 'denied' ? 'Notifications are blocked for this site in browser settings' : undefined}
            >
              {busy ? 'Subscribing…' : 'Enable notifications'}
            </ButtonWeb>
          )}
        </div>
      </div>

      {permission === 'denied' && (
        <p className="mt-2 text-xs text-rose-400">
          Notifications are blocked for this site in browser settings. Re-enable them in the site
          permissions, then click Enable above.
        </p>
      )}

      {error && (
        <p className="mt-2 text-xs text-rose-400" role="alert">
          {error}
        </p>
      )}

      {status && (
        <p className="mt-2 text-xs text-emerald-400" role="status">
          {status}
        </p>
      )}
    </div>
  )
}
