// FoodDaily Service Worker v2.1
const VERSION = '2026-06-12-01';
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
        keys.filter(k => k !== CACHE && !k.startsWith('fd-')).map(k => caches.delete(k))
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

// Message from page: show a notification (most reliable on Android TWA)
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    e.waitUntil(
      self.registration.showNotification(e.data.title, {
        body: e.data.body,
        icon: '/icon-192.png',
        badge: '/icon-96.png',
        tag: 'fd-meal',
        vibrate: [200, 100, 200],
        requireInteraction: false
      })
    );
  }
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

// Periodic Background Sync: check stored prefs then fire at the right time window
self.addEventListener('periodicsync', e => {
  if (e.tag === 'fd-daily-notif') {
    e.waitUntil((async () => {
      try {
        // Read notification prefs stored by the page
        const cache = await caches.open('fd-prefs');
        const resp = await cache.match('/fd-notif-prefs');
        if (!resp) return;
        const prefs = await resp.json();
        if (prefs.on !== 'true') return;

        // Check if we already sent one today (stored as ISO date string in cache)
        const lastCache = await caches.open('fd-prefs');
        const lastResp = await lastCache.match('/fd-notif-last');
        const today = new Date().toDateString();
        if (lastResp) {
          const lastDate = await lastResp.text();
          if (lastDate === today) return;
        }

        // Only fire after the scheduled time; not before 6 AM or after 10 PM
        const [h, m] = (prefs.time || '09:00').split(':').map(Number);
        const now = new Date();
        const nowH = now.getHours();
        if (nowH < 6 || nowH >= 22) return; // Quiet hours
        const sched = new Date();
        sched.setHours(h, m, 0, 0);
        if (now < sched) return; // Scheduled time hasn't arrived yet

        await self.registration.showNotification('🍽️ FoodDaily', {
          body: 'Τι μαγειρεύουμε σήμερα; Δες τις προτάσεις σου!',
          icon: '/icon-192.png',
          badge: '/icon-96.png',
          tag: 'fd-meal-daily',
          vibrate: [200, 100, 200]
        });

        // Mark as sent today
        await lastCache.put('/fd-notif-last',
          new Response(today, { headers: { 'Content-Type': 'text/plain' } })
        );
      } catch (err) {}
    })());
  }
});
