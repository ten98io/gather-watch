/* global self, caches, clients, fetch, URL, Response */

/*
 * Gather service worker — deliberately small:
 *  1. App-shell cache: navigations are network-first, falling back to the
 *     cached shell when offline.
 *  2. Push stub: shows notifications; click focuses/opens the room.
 * API and websocket traffic is never intercepted.
 */
const SHELL_CACHE = 'gather-shell-v1';
const SHELL_URLS = ['/', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // API/media: straight through
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/').then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }
  if (/\.(?:svg|png|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((res) => {
            const copy = res.clone();
            event.waitUntil(
              caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)),
            );
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'Gather', body: 'Something moved in a room.', url: '/home', tag: '' };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      // Malformed payload — show the default notification.
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag === '' ? undefined : data.tag,
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/home';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
