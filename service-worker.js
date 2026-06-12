// FoodDaily Service Worker v2.3
const VERSION = '2026-06-12-13';
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
  if (!e.data) return;

  if (e.data.type === 'SHOW_NOTIFICATION') {
    e.waitUntil(
      self.registration.showNotification(e.data.title, {
        body: e.data.body,
        icon: '/icon-192.png',
        badge: '/icon-96.png',
        tag: e.data.tag || 'fd-meal',
        vibrate: [200, 100, 200],
        requireInteraction: false
      })
    );
  }

  // Step-timer: schedule a notification after `delay` ms (works while screen is locked)
  if (e.data.type === 'SCHEDULE_TIMER') {
    if (self._timerTo) clearTimeout(self._timerTo);
    self._timerTo = setTimeout(() => {
      self.registration.showNotification('⏱️ FoodDaily — Timer', {
        body: 'Ο χρόνος τελείωσε! Δες το επόμενο βήμα.',
        icon: '/icon-192.png',
        badge: '/icon-96.png',
        tag: 'fd-timer',
        vibrate: [300, 150, 300, 150, 300],
        requireInteraction: true
      });
    }, e.data.delay);
  }

  if (e.data.type === 'CANCEL_TIMER') {
    if (self._timerTo) { clearTimeout(self._timerTo); self._timerTo = null; }
  }

  // Daily meal suggestion notification — scheduled via setTimeout so it fires even with app closed.
  // The page sends this on every app-open; the SW reschedules automatically every 24h.
  if (e.data.type === 'SCHEDULE_DAILY_NOTIF') {
    if (self._dailyNotifTo) clearTimeout(self._dailyNotifTo);
    const fireAndReschedule = () => {
      self.registration.showNotification('🍽️ FoodDaily', {
        body: 'Τι μαγειρεύουμε σήμερα; Δες τις προτάσεις σου!',
        icon: '/icon-192.png',
        badge: '/icon-96.png',
        tag: 'fd-meal-daily',
        vibrate: [200, 100, 200],
        requireInteraction: false
      });
      self._dailyNotifTo = setTimeout(fireAndReschedule, 24 * 60 * 60 * 1000);
    };
    self._dailyNotifTo = setTimeout(fireAndReschedule, e.data.delay);
  }

  if (e.data.type === 'CANCEL_DAILY_NOTIF') {
    if (self._dailyNotifTo) { clearTimeout(self._dailyNotifTo); self._dailyNotifTo = null; }
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

// Periodic Background Sync
// Handles both daily meal suggestion and evening prep reminders
self.addEventListener('periodicsync', e => {
  if (e.tag === 'fd-daily-notif') {
    e.waitUntil((async () => {
      try {
        const cache = await caches.open('fd-prefs');
        const nowH = new Date().getHours();
        const today = new Date().toDateString();

        // ── Evening prep reminder (18:00–22:00) ──────────────────
        if (nowH >= 18 && nowH < 22) {
          const prepResp = await cache.match('/fd-tomorrow-prep');
          if (prepResp) {
            const prepData = await prepResp.json();
            if (prepData.prepMsg) {
              const lastPrepResp = await cache.match('/fd-prep-last');
              const lastPrep = lastPrepResp ? await lastPrepResp.text() : '';
              if (lastPrep !== today) {
                await self.registration.showNotification(
                  `🍽️ Αύριο: ${prepData.mealName}`,
                  {
                    body: prepData.prepMsg,
                    icon: '/icon-192.png',
                    badge: '/icon-96.png',
                    tag: 'fd-prep',
                    vibrate: [200, 100, 200, 100, 200]
                  }
                );
                await cache.put('/fd-prep-last',
                  new Response(today, { headers: { 'Content-Type': 'text/plain' } })
                );
                return; // Only one notification per sync cycle
              }
            }
          }
        }

        // ── Daily meal suggestion — respect user's scheduled time ────
        if (nowH >= 23 || nowH < 6) return;

        const resp = await cache.match('/fd-notif-prefs');
        if (!resp) return;
        const prefs = await resp.json();
        if (prefs.on !== 'true') return;

        // Don't fire before the user's chosen time
        const now = new Date();
        const [schedH, schedM] = (prefs.time || '09:00').split(':').map(Number);
        const nowMins  = nowH * 60 + now.getMinutes();
        const schedMins = schedH * 60 + schedM;
        if (nowMins < schedMins) return;

        const lastResp = await cache.match('/fd-notif-last');
        if (lastResp && (await lastResp.text()) === today) return;

        // Only mark as sent if notification actually shows — prevents blocking future attempts
        try {
          await self.registration.showNotification('🍽️ FoodDaily', {
            body: 'Τι μαγειρεύουμε σήμερα; Δες τις προτάσεις σου!',
            icon: '/icon-192.png',
            badge: '/icon-96.png',
            tag: 'fd-meal-daily',
            vibrate: [200, 100, 200]
          });
          await cache.put('/fd-notif-last',
            new Response(today, { headers: { 'Content-Type': 'text/plain' } })
          );
        } catch(notifErr) { /* leave notif-last unset so next sync retries */ }
      } catch (err) {}
    })());
  }
});
