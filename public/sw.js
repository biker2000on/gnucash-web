const CACHE_NAME = 'folio-pwa-v3';
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/icons/folio-stack-192.png',
  '/icons/folio-stack-512.png',
  '/icons/folio-stack-maskable-512.png',
  '/icons/folio-apple-touch-icon-180.png',
];
const isRetiredAppCache = (name) =>
  /^(gnucash-web-|folio-pwa-)/.test(name) && name !== CACHE_NAME;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(isRetiredAppCache)
            .map((name) => caches.delete(name))
        )
      ),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip API routes and auth endpoints
  if (url.pathname.startsWith('/api/')) return;

  // NEVER intercept React Server Component navigation payloads. They are
  // build-specific: serving one cached from a previous deploy hands the new
  // client a payload it cannot parse, and a long-lived PWA tab then freezes
  // on client-side navigation after every deploy (observed 2026-08-20 on the
  // accounts page). Same for Next internals outside /_next/static/.
  const headers = event.request.headers;
  if (
    url.searchParams.has('_rsc') ||
    (headers && headers.get('RSC') === '1') ||
    (headers && headers.get('next-router-prefetch') !== null) ||
    (headers && headers.get('next-router-state-tree') !== null) ||
    (url.pathname.startsWith('/_next/') && !url.pathname.startsWith('/_next/static/'))
  ) {
    return;
  }

  // Network-first for navigation requests
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (
            response.ok &&
            url.origin === self.location.origin &&
            url.pathname === '/'
          ) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/', response.clone());
          }
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Stale-while-revalidate for static assets
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.match(/\.(png|jpg|jpeg|svg|ico|woff2?)$/)
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const networkFetch = fetch(event.request).then(async (response) => {
            if (response.ok) {
              await cache.put(event.request, response.clone());
            }
            return response;
          });

          if (cached) {
            event.waitUntil(networkFetch);
            return cached;
          }

          return networkFetch;
        })
      )
    );
    return;
  }

  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Catch-all for remaining same-origin GETs: network only, offline fallback
  // limited to entries cached before v3. Deliberately NO cache.put here —
  // caching arbitrary documents/payloads is how a previous deploy's responses
  // outlived it and poisoned client-side navigation.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
});
