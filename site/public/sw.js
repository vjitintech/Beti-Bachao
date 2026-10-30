// Retires the old in-browser demo: clears its caches and unregisters itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(new URL('../', self.registration.scope).href.replace(/\/public\/$/, '/'));
  })());
});
