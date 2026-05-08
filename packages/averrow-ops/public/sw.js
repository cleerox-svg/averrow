/* Averrow service worker — PWA shell + runtime caching + Web Push.
 *
 * Scope: /v2/  (set by registration; matches the SPA's vite `base`).
 * Old SPA at / and /legacy is unaffected — its pages are not in scope.
 *
 * Three caching strategies:
 *   1. Navigation requests (/v2/...)   → stale-while-revalidate against the shell cache
 *   2. /api/... GETs                   → network-first, cache fallback (offline 503)
 *   3. /v2/assets/... (Vite hashed)    → cache-first immutable
 *   4. Anything else same-origin       → stale-while-revalidate (runtime cache)
 *
 * Cross-origin (Google Fonts, etc.) is not intercepted — browser handles it.
 * Non-GET methods are not intercepted — the network sees them directly.
 *
 * Web Push (added in PR 3b):
 *   - `push` event: decodes the dispatcher's JSON payload and shows an OS
 *     notification with severity-aware icon + tag-based dedup.
 *   - `notificationclick`: focuses an existing /v2/ tab if open, otherwise
 *     opens a new one at the deep-link URL from the payload. Best-effort
 *     marks the in-app row read by POSTing /api/notifications/:id/read
 *     with the cookie-based session — no auth header needed because the
 *     SW inherits the user's first-party cookies.
 *
 * Bump VERSION on any change here so old caches are evicted on activate.
 */

const VERSION = '2026-04-30.1';
const SHELL_CACHE   = `averrow-shell-${VERSION}`;
const API_CACHE     = `averrow-api-${VERSION}`;
const RUNTIME_CACHE = `averrow-runtime-${VERSION}`;

// Minimal precache: the SPA shell, manifest, and root favicon. Everything
// else fills in opportunistically through SWR + cache-first as the user
// navigates.
const SHELL_PRECACHE = [
  '/v2/',
  '/v2/index.html',
  '/v2/manifest.json',
  '/v2/favicon.svg',
  '/v2/icon-192.svg',
  '/v2/icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Use { cache: 'reload' } so the install fetches from network even if
      // the browser HTTP cache has a stale copy.
      Promise.all(
        SHELL_PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const stale = keys.filter(
        (k) =>
          (k.startsWith('averrow-shell-') ||
            k.startsWith('averrow-api-') ||
            k.startsWith('averrow-runtime-')) &&
          !k.endsWith(VERSION)
      );
      await Promise.all(stale.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA navigations: stale-while-revalidate against the shell.
  if (req.mode === 'navigate') {
    event.respondWith(navigationHandler(req));
    return;
  }

  // API: network-first, cache fallback.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // Vite-hashed bundles are immutable — cache-first is safe.
  if (url.pathname.startsWith('/v2/assets/')) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Everything else (CSS not in /assets, icons, /favicon.svg, etc.)
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ─── Strategies ─────────────────────────────────────────────────────────

async function navigationHandler(req) {
  // Try network for the latest shell, but always fall back to cached /v2/
  // shell so the app boots offline. The SPA does its own data refetching
  // once it's running.
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    cache.put('/v2/', fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match('/v2/')) || (await cache.match('/v2/index.html'));
    if (cached) return cached;
    return new Response('Offline. Reload when you have a connection.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ success: false, error: 'offline', message: 'No cached response available.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh && fresh.status === 200) {
    cache.put(req, fresh.clone()).catch(() => {});
  }
  return fresh;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((fresh) => {
      if (fresh && fresh.status === 200) {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    })
    .catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}

// ─── Web Push ───────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  // Payload shape comes from src/lib/push.ts on the worker:
  //   { title, body, url?, tag?, notificationId?, severity?, type? }
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Averrow', body: 'New notification' };
  }

  const title = data.title || 'Averrow';
  const options = {
    body: data.body || '',
    icon: '/v2/icon-192.svg',
    badge: '/v2/icon-192.svg',
    tag: data.tag || `averrow-${data.type || 'generic'}`,
    renotify: true,
    // Stash the click target + in-app id on the notification itself so the
    // notificationclick handler can read it back without another fetch.
    data: {
      url: data.url || '/v2/',
      notificationId: data.notificationId || null,
      severity: data.severity || 'info',
      type: data.type || null,
    },
    // High severity gets a vibration cue on Android; iOS ignores this.
    vibrate: data.severity === 'critical' ? [200, 100, 200, 100, 200] : [120, 80, 120],
    requireInteraction: data.severity === 'critical',
    // Inline action buttons (W3C Web Push). Chrome + Firefox honor;
    // iOS Safari (PWA) ignores `actions` and shows a single tap zone.
    // The server-side payload may opt out by setting `actions: []`.
    // The `notificationclick` handler below routes by event.action.
    actions: Array.isArray(data.actions) ? data.actions : [
      { action: 'snooze', title: 'Snooze 1h' },
      { action: 'done',   title: 'Done' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// React Router runs at basename="/v2", but notification.link is
// stored as a basename-relative path (e.g. "/agents") so the in-app
// bell click via navigate() works. The SW navigates the bare URL
// though — `/agents` on averrow.com hits the LEGACY SPA, not v2.
// Prepend /v2/ when the path is missing it (operator screenshot
// 2026-04-30: tapping a platform alert opened the old UI).
function v2Path(path) {
  if (!path) return '/v2/';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('/v2/') || path === '/v2') return path;
  if (path.startsWith('/')) return '/v2' + path;
  return '/v2/' + path;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawPath = (event.notification.data && event.notification.data.url) || '/v2/';
  const targetPath = v2Path(rawPath);
  const notificationId = event.notification.data && event.notification.data.notificationId;
  const targetUrl = new URL(targetPath, self.location.origin).href;
  const action = event.action; // '' for default tap, 'snooze' / 'done' for action buttons

  event.waitUntil((async () => {
    // Action buttons take a side-channel route — no window navigation.
    // Defaults: snooze 1h, done = mark-done. The fetch is best-effort
    // and falls through silently on session loss.
    if (notificationId && (action === 'snooze' || action === 'done')) {
      try {
        if (action === 'snooze') {
          const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/snooze`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ until }),
          });
        } else {
          await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/done`, {
            method: 'POST',
            credentials: 'include',
          });
        }
      } catch { /* swallow */ }
      return; // do not open a window for action button clicks
    }

    // Default tap (no action selected): mark read and navigate.
    if (notificationId) {
      fetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {});
    }

    // If a /v2/ tab is already open, focus it and navigate; otherwise open new.
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin && url.pathname.startsWith('/v2/')) {
          if ('focus' in client) await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl);
          return;
        }
      } catch {
        // ignore mis-formed client URLs
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
