/* global self, caches, clients, fetch, URL, Response */

/*
 * Gather service worker — deliberately small:
 *  1. App-shell cache: navigations are network-first, falling back to the
 *     cached shell when offline.
 *  2. Push: renders the payloads services/api chat/notify.ts actually sends,
 *     and puts the click on the right room.
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

/*
 * The server's payload, verbatim (services/api …/chat/notify.ts):
 *   mention      { kind, roomId, roomName, fromDisplayName, messageId, preview }
 *   invite       { kind, roomId, roomName, fromDisplayName }
 *   room-started { kind, roomId, roomName }
 * This file used to destructure { title, body, url, tag } — keys the server has
 * never sent — so every notification read "Gather / Something moved in a room."
 * and opened /home.
 *
 * Only things a person is owed OUT of the app get here at all: the server
 * pushes mentions, invites and room-starts, never ordinary chat. Ordinary chat
 * is the unread badge on the Chat tab, which interrupts nothing.
 */
function notificationFor(data) {
  const roomName = typeof data.roomName === 'string' && data.roomName !== '' ? data.roomName : 'Gather';
  const from = typeof data.fromDisplayName === 'string' && data.fromDisplayName !== ''
    ? data.fromDisplayName
    : 'Someone';
  const url = typeof data.roomId === 'string' && data.roomId !== '' ? `/room/${data.roomId}` : '/home';
  const preview = typeof data.preview === 'string' ? data.preview : '';

  if (data.kind === 'mention') {
    return {
      title: roomName,
      // One tag PER ROOM, so a burst of mentions in one room replaces itself
      // instead of stacking a column of alerts over whatever you are watching.
      tag: `mention:${String(data.roomId)}`,
      body: preview === '' ? `${from} mentioned you` : `${from}: ${preview}`,
      url,
    };
  }
  if (data.kind === 'invite') {
    return {
      title: `${from} invited you`,
      tag: `invite:${String(data.roomId)}`,
      body: `Join ${roomName}`,
      url,
    };
  }
  if (data.kind === 'room-started') {
    return {
      title: roomName,
      tag: `room-started:${String(data.roomId)}`,
      body: 'The room is live.',
      url,
    };
  }
  return { title: 'Gather', tag: '', body: 'Something moved in a room.', url };
}

/** True when a VISIBLE window is already sitting in this exact room. */
function roomIsOnScreen(url) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
    list.some((client) => {
      if (client.visibilityState !== 'visible') return false;
      try {
        return new URL(client.url).pathname === url;
      } catch {
        return false;
      }
    }),
  );
}

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      // Malformed payload — fall through to the generic notification.
    }
  }
  const note = notificationFor(data);
  event.waitUntil(
    roomIsOnScreen(note.url).then((onScreen) => {
      // Watch-together rule: never interrupt playback. If that room is open and
      // visible, the person is already there — the in-app badge is the whole
      // notification they need.
      if (onScreen) return undefined;
      return self.registration.showNotification(note.title, {
        body: note.body,
        icon: '/icon.svg',
        badge: '/icon.svg',
        tag: note.tag === '' ? undefined : note.tag,
        data: { url: note.url },
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/home';
  // Absolute, so navigate() and openWindow() resolve against the same base
  // whatever page the client happens to be on.
  const href = new URL(url, self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Focusing a window without navigating it — which is what this used to do
      // — drops the person on whatever page they already had open, which is
      // never the room the notification was about.
      const onTarget = list.find((client) => {
        try {
          return new URL(client.url).pathname === url;
        } catch {
          return false;
        }
      });
      if (onTarget) return onTarget.focus();
      const existing = list.find((client) => 'navigate' in client && 'focus' in client);
      if (existing) {
        return existing.navigate(href).then((client) => {
          const target = client || existing;
          return 'focus' in target ? target.focus() : target;
        });
      }
      return clients.openWindow(href);
    }),
  );
});
