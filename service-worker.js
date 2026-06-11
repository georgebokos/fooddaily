// FoodDaily Service Worker v2.0
const VERSION = '2026-06-11-05';
const CACHE = `fooddaily-${VERSION}`;
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install: cache core files immediately, don't wait for old SW to go away
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete all caches that don't match current version, then claim all clients
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

// Fetch: stale-while-revalidate for same-origin, network-only for external
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(resp => {
          if (resp && resp.status === 200) {
            cache.put(e.request, resp.clone());
          }
          return resp;
        }).catch(() => null);

        return cached || fetchPromise || caches.match('/index.html');
      })
    )
  );
});

// Notification click: open or focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      const existing = cls.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow('/');
    })
  );
});

// Periodic Background Sync: fire daily notification when app is closed
self.addEventListener('periodicsync', e => {
  if (e.tag === 'fd-daily-notif') {
    e.waitUntil(
      self.registration.showNotification('🍽️ FoodDaily', {
        body: 'Τι μαγειρεύουμε σήμερα; Δες τις προτάσεις σου!',
        icon: '/icon-192.png',
        badge: '/icon-96.png',
        tag: 'fd-meal',
        vibrate: [200, 100, 200],
        data: { url: '/' }
      })
    );
  }
});
