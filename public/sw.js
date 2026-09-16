// Service worker: lets the app be installed to the home screen, and keeps a copy
// of the shell so it still opens with no signal (the outbox flushes once the
// network is back). Network-first for everything, so capture never runs stale
// app code while online; the cache is only ever the fallback.
const CACHE = 'second-brain-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Never intercept uploads/mutations: Safari drops request bodies re-dispatched
  // from a service worker, truncating multipart uploads server-side.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // API responses are never cached: a cached note list would read as current.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw err;
    }
  })());
});
