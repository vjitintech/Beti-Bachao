// Offline shell: the SOS screen, call buttons and SMS fallback must open even
// with no network. API calls are never cached. VERSION is stamped by scripts/version.mjs.
const VERSION = 'mvukvmhy';
const CACHE = 'bb-shell-' + VERSION;
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png']).catch(() => {}))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // Network-first and bypass the HTTP cache so updates show immediately; cached copy keeps SOS usable offline.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request, { ignoreSearch: false }).then((r) => r || caches.match('index.html'))));
});

// ---- Push notifications: SOS alerts reach volunteers even when the app is closed.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Beti Bachao', body: e.data && e.data.text() }; }
  const urgent = !!d.urgent;
  e.waitUntil(self.registration.showNotification(d.title || 'Beti Bachao', {
    body: d.body || '', tag: d.tag || 'beti-bachao', renotify: true, requireInteraction: urgent,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    vibrate: urgent ? [500, 200, 500, 200, 900] : [200], data: { url: d.url || '#/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL('./' + (e.notification.data?.url || '#/'), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
