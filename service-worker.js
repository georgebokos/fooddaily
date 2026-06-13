// FoodDaily Service Worker v3.0
const VERSION = '2026-06-13-09';
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

// ── TIMER HELPERS (module-level so TIMER_PING can also call them) ──────────
// Running notification uses a SEPARATE tag so the done notification is always NEW
// (same tag = Android treats done as an update → no sound)
const _swShowRunning = () => {
  if (!self._timerEnd) return;
  const end = new Date(self._timerEnd);
  const hh = String(end.getHours()).padStart(2, '0');
  const mm = String(end.getMinutes()).padStart(2, '0');
  return self.registration.showNotification('⏱️ Timer FoodDaily', {
    body: `Τελειώνει στις ${hh}:${mm}`,
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    tag: 'fd-timer-run',
    silent: true,
    requireInteraction: true
  });
};

const _swFireDone = () => {
  if (self._timerPoll) { clearInterval(self._timerPoll); self._timerPoll = null; }
  if (self._timerTo)   { clearTimeout(self._timerTo);    self._timerTo   = null; }
  // Show done FIRST (running notification still keeping SW alive), THEN close running.
  // If we close running first, the SW loses its keepalive and may die before done is shown.
  self.registration.showNotification('⏱️ FoodDaily — Timer', {
    body: 'Ο χρόνος τελείωσε! Δες το επόμενο βήμα.',
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    tag: 'fd-timer',
    vibrate: [300, 150, 300, 150, 300],
    requireInteraction: true
  }).then(() =>
    self.registration.getNotifications({ tag: 'fd-timer-run' })
      .then(ns => ns.forEach(n => n.close()))
  );
};

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

  // Step-timer: persistent notification + 2-second poll + keepalive pings from page
  if (e.data.type === 'SCHEDULE_TIMER') {
    if (self._timerTo) { clearTimeout(self._timerTo); self._timerTo = null; }
    if (self._timerPoll) { clearInterval(self._timerPoll); self._timerPoll = null; }
    self._timerEnd = Date.now() + e.data.delay;
    self._timerMealId = e.data.mealId || '';
    self._timerStepIdx = e.data.stepIdx || 0;
    self._timerNotifDismissed = false;

    // Immediate notification — prevents Android from killing the SW
    e.waitUntil(_swShowRunning());

    // Poll every 5 s: only check expiry (display shows absolute time, no updates needed)
    self._timerPoll = setInterval(() => {
      if (self._timerEnd - Date.now() <= 0) _swFireDone();
    }, 5000);

    // Primary trigger at exact time
    self._timerTo = setTimeout(_swFireDone, e.data.delay);
  }

  if (e.data.type === 'CANCEL_TIMER') {
    if (self._timerTo) { clearTimeout(self._timerTo); self._timerTo = null; }
    if (self._timerPoll) { clearInterval(self._timerPoll); self._timerPoll = null; }
    self._timerEnd = null;
    self._timerNotifDismissed = false;
    ['fd-timer-run','fd-timer'].forEach(tag =>
      self.registration.getNotifications({ tag }).then(ns => ns.forEach(n => n.close()))
    );
  }

  // App minimised — re-show notification (unless user dismissed it)
  if (e.data.type === 'TIMER_APP_HIDDEN') {
    if (self._timerEnd && !self._timerNotifDismissed) {
      if (self._timerEnd - Date.now() > 0) _swShowRunning();
      else _swFireDone();
    }
  }

  // Keepalive ping from page every ~20 s — wakes SW, checks if timer already expired
  if (e.data.type === 'TIMER_PING') {
    if (self._timerEnd && Date.now() >= self._timerEnd) _swFireDone();
  }

  // Page requests any pending navigation (e.g. opened via timer notification tap)
  if (e.data.type === 'GET_PENDING_NAV') {
    if (self._pendingTimerNav && e.source) {
      e.source.postMessage(self._pendingTimerNav);
      self._pendingTimerNav = null;
    }
  }

  // Daily meal suggestion notification — scheduled via setTimeout so it fires even with app closed.
  // The page sends this on every app-open; the SW reschedules automatically every 24h.
  if (e.data.type === 'SCHEDULE_DAILY_NOTIF') {
    if (self._dailyNotifTo) clearTimeout(self._dailyNotifTo);
    const fireAndReschedule = async () => {
      // Guard: skip if already fired today (page reschedules on every open)
      const cache = await caches.open('fd-prefs');
      const today = new Date().toDateString();
      const lastResp = await cache.match('/fd-notif-last');
      if (lastResp && (await lastResp.text()) === today) {
        // Already sent today — schedule for same time tomorrow
        self._dailyNotifTo = setTimeout(fireAndReschedule, 24 * 60 * 60 * 1000);
        return;
      }
      try {
        await self.registration.showNotification('🍽️ FoodDaily', {
          body: 'Τι μαγειρεύουμε σήμερα; Δες τις προτάσεις σου!',
          icon: '/icon-192.png',
          badge: '/icon-96.png',
          tag: 'fd-meal-daily',
          vibrate: [200, 100, 200],
          requireInteraction: false
        });
        await cache.put('/fd-notif-last',
          new Response(today, { headers: { 'Content-Type': 'text/plain' } })
        );
      } catch(err) { /* leave fd-notif-last unset so next open retries */ }
      self._dailyNotifTo = setTimeout(fireAndReschedule, 24 * 60 * 60 * 1000);
    };
    self._dailyNotifTo = setTimeout(fireAndReschedule, e.data.delay);
  }

  if (e.data.type === 'CANCEL_DAILY_NOTIF') {
    if (self._dailyNotifTo) { clearTimeout(self._dailyNotifTo); self._dailyNotifTo = null; }
  }
});

// Notification dismissed by swipe — if timer still running, mark so we don't re-show
self.addEventListener('notificationclose', e => {
  // User swiped away the running notification — stop re-showing it
  if (e.notification.tag === 'fd-timer-run' && self._timerEnd && Date.now() < self._timerEnd) {
    self._timerNotifDismissed = true;
  }
});

// Notification click: open or focus the app; for timer taps navigate to the recipe step
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const isTimer = e.notification.tag === 'fd-timer' || e.notification.tag === 'fd-timer-run';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      const existing = cls.find(c => c.url.includes(self.location.origin));
      if (isTimer && self._timerMealId) {
        const msg = { type: 'OPEN_TIMER_STEP', mealId: self._timerMealId, stepIdx: self._timerStepIdx || 0 };
        if (existing) { existing.postMessage(msg); return existing.focus(); }
        // App was closed — store nav, open app; page will request it via GET_PENDING_NAV
        self._pendingTimerNav = msg;
        return clients.openWindow('/');
      }
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
