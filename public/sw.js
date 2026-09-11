// Minimal service worker: lets the app be installed to the home screen.
// Network-first for everything — capture must never serve stale app code.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  // Never intercept uploads/mutations: Safari drops request bodies re-dispatched
  // from a service worker, truncating multipart uploads server-side.
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
