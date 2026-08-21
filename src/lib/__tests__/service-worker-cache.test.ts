import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'public/sw.js'),
  'utf8'
);

const EXPECTED_PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/icons/folio-stack-192.png',
  '/icons/folio-stack-512.png',
  '/icons/folio-stack-maskable-512.png',
  '/icons/folio-apple-touch-icon-180.png',
];

type WorkerEvent = {
  request?: {
    method: string;
    mode: string;
    url: string;
    headers?: Headers;
  };
  data?: unknown;
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (promise: Promise<Response> | Response) => void;
};

type WorkerListener = (event: WorkerEvent) => void;

function cacheKey(request: RequestInfo | URL): string {
  return typeof request === 'string' || request instanceof URL
    ? request.toString()
    : request.url;
}

function createWorkerHarness(initialCacheNames: string[] = []) {
  const listeners = new Map<string, WorkerListener>();
  const stores = new Map<string, Map<string, Response>>();
  const addAllCalls: string[][] = [];
  const deletedCacheNames: string[] = [];

  for (const name of initialCacheNames) {
    stores.set(name, new Map());
  }

  const cacheStorage = {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }

      return {
        async addAll(urls: string[]) {
          addAllCalls.push([...urls]);
          for (const url of urls) {
            store.set(url, new Response(`precache:${url}`, { status: 200 }));
          }
        },
        async match(request: RequestInfo | URL) {
          return store.get(cacheKey(request))?.clone();
        },
        async put(request: RequestInfo | URL, response: Response) {
          store.set(cacheKey(request), response.clone());
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      deletedCacheNames.push(name);
      return stores.delete(name);
    },
    async match(request: RequestInfo | URL) {
      const key = cacheKey(request);
      for (const store of stores.values()) {
        const response = store.get(key);
        if (response) return response.clone();
      }
      return undefined;
    },
  };

  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);
  const fetchMock = vi.fn<typeof fetch>();
  const self = {
    addEventListener(type: string, listener: WorkerListener) {
      listeners.set(type, listener);
    },
    skipWaiting,
    clients: { claim },
    location: { origin: 'https://folio.test' },
  };

  const context = {
    URL,
    Request,
    Response,
    caches: cacheStorage,
    fetch: fetchMock,
    self,
  };

  runInNewContext(
    `${source}
globalThis.__workerExports = {
  CACHE_NAME,
  PRECACHE_URLS: typeof PRECACHE_URLS === 'undefined' ? undefined : PRECACHE_URLS,
  isRetiredAppCache: typeof isRetiredAppCache === 'undefined'
    ? () => false
    : isRetiredAppCache,
};`,
    context
  );

  function dispatch(type: string, init: Partial<WorkerEvent> = {}) {
    const waitUntilPromises: Promise<unknown>[] = [];
    let responsePromise: Promise<Response> | undefined;
    const event: WorkerEvent = {
      ...init,
      waitUntil(promise) {
        waitUntilPromises.push(Promise.resolve(promise));
      },
      respondWith(response) {
        responsePromise = Promise.resolve(response);
      },
    };

    listeners.get(type)?.(event);

    return {
      waitUntil: () => Promise.all(waitUntilPromises),
      response: () => responsePromise,
    };
  }

  return {
    addAllCalls,
    cacheStorage,
    claim,
    deletedCacheNames,
    dispatch,
    fetchMock,
    skipWaiting,
    stores,
    workerExports: (context as typeof context & {
      __workerExports: {
        CACHE_NAME: string;
        PRECACHE_URLS: string[] | undefined;
        isRetiredAppCache: (name: string) => boolean;
      };
    }).__workerExports,
  };
}

function navigationRequest(path = '/accounts') {
  return {
    method: 'GET',
    mode: 'navigate',
    url: `https://folio.test${path}`,
  };
}

describe('Folio service-worker cache lifecycle', () => {
  it('installs the exact Folio offline shell into the versioned cache', async () => {
    const worker = createWorkerHarness();

    expect(source).toContain("const CACHE_NAME = 'folio-pwa-v3'");
    expect(worker.workerExports.PRECACHE_URLS).toEqual(EXPECTED_PRECACHE_URLS);

    const install = worker.dispatch('install');
    await install.waitUntil();

    expect(worker.addAllCalls).toEqual([EXPECTED_PRECACHE_URLS]);
    expect(worker.stores.has('folio-pwa-v3')).toBe(true);
    expect(worker.skipWaiting).toHaveBeenCalledOnce();
  });

  it('deletes only retired application caches during activation', async () => {
    const worker = createWorkerHarness([
      'third-party-cache',
      'gnucash-web-v1',
      'folio-pwa-v1',
      'folio-pwa-v3',
    ]);
    const { isRetiredAppCache } = worker.workerExports;

    expect(isRetiredAppCache('third-party-cache')).toBe(false);
    expect(isRetiredAppCache('gnucash-web-v1')).toBe(true);
    expect(isRetiredAppCache('folio-pwa-v1')).toBe(true);
    expect(isRetiredAppCache('folio-pwa-v3')).toBe(false);

    const activate = worker.dispatch('activate');
    await activate.waitUntil();

    expect(worker.deletedCacheNames).toEqual([
      'gnucash-web-v1',
      'folio-pwa-v1',
    ]);
    expect(await worker.cacheStorage.keys()).toEqual([
      'third-party-cache',
      'folio-pwa-v3',
    ]);
    expect(worker.claim).toHaveBeenCalledOnce();
  });

  it('updates the root shell only from a successful public root navigation', async () => {
    const worker = createWorkerHarness(['folio-pwa-v3']);
    worker.fetchMock.mockResolvedValue(
      new Response('fresh Folio shell', { status: 200 })
    );

    const navigation = worker.dispatch('fetch', {
      request: navigationRequest('/'),
    });
    const response = await navigation.response();

    expect(await response?.text()).toBe('fresh Folio shell');
    const cache = await worker.cacheStorage.open('folio-pwa-v3');
    expect(await (await cache.match('/'))?.text()).toBe('fresh Folio shell');

    await cache.put('/', new Response('known-good shell', { status: 200 }));
    worker.fetchMock.mockResolvedValue(
      new Response('server unavailable', { status: 503 })
    );

    const failedNavigation = worker.dispatch('fetch', {
      request: navigationRequest('/reports'),
    });
    expect((await failedNavigation.response())?.status).toBe(503);
    expect(await (await cache.match('/'))?.text()).toBe('known-good shell');
  });

  it.each(['/accounts', '/share/public-token'])(
    'never replaces the root shell with a successful %s navigation',
    async (path) => {
      const worker = createWorkerHarness(['folio-pwa-v3']);
      const cache = await worker.cacheStorage.open('folio-pwa-v3');
      await cache.put('/', new Response('known-good shell', { status: 200 }));
      worker.fetchMock.mockResolvedValue(
        new Response(`page response for ${path}`, { status: 200 })
      );

      const navigation = worker.dispatch('fetch', {
        request: navigationRequest(path),
      });
      expect(await (await navigation.response())?.text()).toBe(
        `page response for ${path}`
      );
      expect(await (await cache.match('/'))?.text()).toBe('known-good shell');
    }
  );

  it('serves the upgraded root shell when navigation fetch rejects offline', async () => {
    const worker = createWorkerHarness([
      'third-party-cache',
      'gnucash-web-v1',
      'folio-pwa-v3',
    ]);
    const currentCache = await worker.cacheStorage.open('folio-pwa-v3');
    await currentCache.put(
      '/',
      new Response('upgraded Folio shell', { status: 200 })
    );

    const activate = worker.dispatch('activate');
    await activate.waitUntil();
    worker.fetchMock.mockRejectedValue(new TypeError('offline'));

    const navigation = worker.dispatch('fetch', {
      request: navigationRequest('/ledger'),
    });
    const response = await navigation.response();

    expect(await response?.text()).toBe('upgraded Folio shell');
    expect(await worker.cacheStorage.keys()).toContain('third-party-cache');
  });

  it('bypasses API requests and retains safe static-asset caching', async () => {
    const worker = createWorkerHarness(['folio-pwa-v3']);

    const api = worker.dispatch('fetch', {
      request: {
        method: 'GET',
        mode: 'cors',
        url: 'https://folio.test/api/accounts',
      },
    });
    expect(api.response()).toBeUndefined();
    expect(worker.fetchMock).not.toHaveBeenCalled();

    worker.fetchMock.mockResolvedValue(
      new Response('icon bytes', { status: 200 })
    );
    const iconRequest = {
      method: 'GET',
      mode: 'cors',
      url: 'https://folio.test/icons/folio-stack-192.png',
    };
    const staticAsset = worker.dispatch('fetch', { request: iconRequest });
    expect(await (await staticAsset.response())?.text()).toBe('icon bytes');

    const cache = await worker.cacheStorage.open('folio-pwa-v3');
    expect(await (await cache.match(iconRequest.url))?.text()).toBe('icon bytes');
  });

  it('never intercepts RSC navigation payloads (v3 — stale payloads froze tabs after deploys)', async () => {
    const worker = createWorkerHarness(['folio-pwa-v3']);

    const rsc = worker.dispatch('fetch', {
      request: {
        method: 'GET',
        mode: 'cors',
        url: 'https://folio.test/accounts?_rsc=abc123',
      },
    });
    expect(rsc.response()).toBeUndefined();
    expect(worker.fetchMock).not.toHaveBeenCalled();

    const headerTagged = worker.dispatch('fetch', {
      request: {
        method: 'GET',
        mode: 'cors',
        url: 'https://folio.test/accounts',
        headers: new Headers({ RSC: '1' }),
      },
    });
    expect(headerTagged.response()).toBeUndefined();

    const nextInternal = worker.dispatch('fetch', {
      request: {
        method: 'GET',
        mode: 'cors',
        url: 'https://folio.test/_next/data/build-id/accounts.json',
      },
    });
    expect(nextInternal.response()).toBeUndefined();
  });

  it('does not cache catch-all same-origin responses (v3 — a previous deploy must not outlive itself)', async () => {
    const worker = createWorkerHarness(['folio-pwa-v3']);
    worker.fetchMock.mockResolvedValue(new Response('page bytes', { status: 200 }));

    const request = {
      method: 'GET',
      mode: 'cors',
      url: 'https://folio.test/reports/balance-sheet',
    };
    const result = worker.dispatch('fetch', { request });
    expect(await (await result.response())?.text()).toBe('page bytes');

    const cache = await worker.cacheStorage.open('folio-pwa-v3');
    expect(await cache.match(request.url)).toBeUndefined();
  });
});
