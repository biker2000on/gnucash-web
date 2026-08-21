const CACHE_NAME = 'folio-pwa-v4';
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
// Upper bound on any foreground fetch the worker owns. A `respondWith()` that
// never settles is a request that never completes: Chrome keeps the tab
// spinner turning and the page never finishes loading. Losing this race is
// treated exactly like a network failure.
const FETCH_DEADLINE_MS = 15000;

const isRetiredAppCache = (name) =>
  /^(gnucash-web-|folio-pwa-)/.test(name) && name !== CACHE_NAME;

// fetch() with a hard deadline. Rejects when the network stalls past the
// deadline so the caller can fall back deterministically.
function fetchWithDeadline(request, deadlineMs = FETCH_DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('sw: network deadline exceeded'));
    }, deadlineMs);

    fetch(request).then(
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Every fallback must resolve `respondWith()` with a real Response. Resolving
// with `undefined` (what a bare `caches.match()` miss produces) makes the
// request fail anyway, but opaquely — `Response.error()` is explicit.
async function cachedOrError(request) {
  const cached = await caches.match(request);
  return cached || Response.error();
}

// Respond first, cache later. Awaiting `cache.put()` on the response path
// blocks the page on storage IO; `waitUntil` keeps the worker alive for the
// write without holding the response hostage.
function cacheInBackground(event, key, response) {
  const copy = response.clone();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.put(key, copy))
      .catch(() => undefined)
  );
}

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
      fetchWithDeadline(event.request)
        .then((response) => {
          if (
            response.ok &&
            url.origin === self.location.origin &&
            url.pathname === '/'
          ) {
            cacheInBackground(event, '/', response);
          }
          return response;
        })
        .catch(() => cachedOrError('/'))
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
          const networkFetch = fetchWithDeadline(event.request).then((response) => {
            if (response.ok) {
              cacheInBackground(event, event.request, response);
            }
            return response;
          });

          if (cached) {
            event.waitUntil(networkFetch.catch(() => undefined));
            return cached;
          }

          return networkFetch.catch(() => cachedOrError(event.request));
        })
      )
    );
    return;
  }

  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetchWithDeadline(event.request)
        .then((response) => {
          if (response.ok) {
            cacheInBackground(event, event.request, response);
          }
          return response;
        })
        .catch(() => cachedOrError(event.request))
    );
    return;
  }

  // Catch-all for remaining same-origin GETs: network only, offline fallback
  // limited to entries cached before v4. Deliberately NO cache.put here —
  // caching arbitrary documents/payloads is how a previous deploy's responses
  // outlived it and poisoned client-side navigation.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetchWithDeadline(event.request).catch(() => cachedOrError(event.request))
    );
  }
});
