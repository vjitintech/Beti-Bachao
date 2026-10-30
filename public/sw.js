// Offline shell: the SOS screen, call buttons and SMS fallback must open even
// with no network. API calls are never cached. VERSION is stamped by scripts/version.mjs.
const VERSION = 'mvuj58r6';
const CACHE = 'bb-shell-' + VERSION;
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png']).catch(() => {}))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // Network-first and bypass the HTTP cache so updates show immediately; cached copy keeps SOS usable offline.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request, { ignoreSearch: false }).then((r) => r || caches.match('index.html'))));
});
