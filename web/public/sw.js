const CACHE_NAME = 'night-orch-web-v1'
const CORE_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    )),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET') {
    return
  }

  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html')),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached
      }

      return fetch(request).then((response) => {
        if (!response.ok || response.type !== 'basic') {
          return response
        }

        const cloned = response.clone()
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned))
        return response
      })
    }),
  )
})

// Phase 2c — Web Push notifications.
// The `WebPushChannel` on the server encrypts a JSON payload matching:
//   { event, title, body, repo, issueNumber, issueTitle, timestamp, prUrl? }
// We show it as a system notification and, on click, focus an
// existing tab (or open a new one) pointing at the dashboard root
// so the operator can act on the alert without the service worker
// needing any routing logic of its own.
self.addEventListener('push', (event) => {
  let payload = {}
  if (event.data) {
    try {
      payload = event.data.json()
    } catch {
      payload = { title: 'night-orch update', body: event.data.text() }
    }
  }
  const title = payload.title || 'night-orch'
  const options = {
    body: payload.body || 'Open the dashboard for details.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: payload.event || 'night-orch',
    renotify: true,
    data: {
      url: payload.prUrl || '/',
      event: payload.event || null,
      repo: payload.repo || null,
      issueNumber: payload.issueNumber || null,
      timestamp: payload.timestamp || null,
    },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus().then((focused) => {
            if ('navigate' in focused && targetUrl.startsWith('/')) {
              return focused.navigate(targetUrl)
            }
            return focused
          })
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
      return undefined
    }),
  )
})
