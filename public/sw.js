// Offline shell: the SOS screen, call button and SMS fallback must open even
// with no network. API calls are never cached.
const CACHE = 'bb-shell-v4';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/api.js', 'js/i18n.js', 'js/safety.js', 'js/ui.js',
  'core/engine.js', 'core/config.js', 'core/geo.js', 'core/seed.js',
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // Network-first so updates ship quickly; cache fallback keeps SOS usable offline.
  e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
