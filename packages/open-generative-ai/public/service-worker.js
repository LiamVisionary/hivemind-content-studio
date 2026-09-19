// App-shell service worker — deliberately minimal, adapted from Mix-Studio
// (BlackMixture/Mix-Studio, GPL-3.0). Caches ONLY the offline fallback page and
// icons; every navigation goes network-first. App code, API responses, and
// (sealed) media are never cached, so there is no stale-asset or leaked-media
// class of bug — the E2E owner-vault flow is untouched.
const CACHE_NAME = 'hivemind-studio-shell-v1';
const SHELL_ASSETS = ['/offline.html', '/app-icon-192.png', '/app-icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('hivemind-studio-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  event.respondWith(
    fetch(request).catch(() => caches.match('/offline.html')),
  );
});
