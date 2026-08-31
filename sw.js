// Polaris service worker.
//
// Scope: makes the app installable (Add to Home Screen / desktop install) and
// keeps the last-loaded app shell available if the network drops mid-session.
//
// It deliberately does NOT cache or intercept:
//   - Supabase calls (cross-origin, campaign/task data) — always live, so nobody
//     ever edits a stale campaign or gets a false "saved" while offline.
//   - /api/extract (the AI file-import proxy) — POST requests aren't cacheable
//     anyway, and this should always hit the network fresh.
// Everything else falls through to the network untouched. Only the shell
// (this page, the manifest, the icons) is cached, and only as an offline
// fallback — online, the network's copy always wins so a redeploy is picked
// up on the next load rather than being masked by a stale cache.

const CACHE_NAME = 'polaris-shell-v1';
const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {}) // don't block install if a shell asset is briefly unreachable
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests for the shell. Everything else
  // (Supabase, /api/extract, POST/PUT/DELETE, other origins) passes straight
  // through to the network as if no service worker were present.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isShellAsset =
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/icons/');
  if (!isShellAsset) return;

  // Network-first, cache as offline fallback — so the live app is always
  // served when there's a connection, and the last-known version opens when
  // there isn't.
  event.respondWith(
    fetch(req)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return resp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
  );
});
