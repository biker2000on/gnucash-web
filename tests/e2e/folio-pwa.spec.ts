import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';

type ManifestIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
};

type ManifestScreenshot = {
  src: string;
  sizes: string;
  type: string;
  form_factor: 'narrow' | 'wide';
  label: string;
};

type FolioManifest = {
  name: string;
  short_name: string;
  icons: ManifestIcon[];
  screenshots: ManifestScreenshot[];
};

const expectedIcons: ManifestIcon[] = [
  {
    src: '/icons/folio-stack-192.png',
    sizes: '192x192',
    type: 'image/png',
    purpose: 'any',
  },
  {
    src: '/icons/folio-stack-512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'any',
  },
  {
    src: '/icons/folio-stack-maskable-512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'maskable',
  },
  {
    src: '/favicon.svg',
    sizes: 'any',
    type: 'image/svg+xml',
    purpose: 'any',
  },
  {
    src: '/favicon.ico',
    sizes: '32x32',
    type: 'image/x-icon',
    purpose: 'any',
  },
];

const expectedScreenshots: ManifestScreenshot[] = [
  {
    src: '/screenshots/folio-mobile.png',
    sizes: '1080x1920',
    type: 'image/png',
    form_factor: 'narrow',
    label: 'Folio for GnuCash on mobile',
  },
  {
    src: '/screenshots/folio-desktop.png',
    sizes: '1920x1080',
    type: 'image/png',
    form_factor: 'wide',
    label: 'Folio for GnuCash on desktop',
  },
];

async function getManifest(request: APIRequestContext): Promise<FolioManifest> {
  const response = await request.get('/manifest.webmanifest');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/manifest+json');

  return response.json() as Promise<FolioManifest>;
}

async function waitForActiveServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;

    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
      });
    }
  });
}

test.describe('Folio PWA install surface', () => {
  test('exposes the Folio title and accessible Stack lockup', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Folio for GnuCash/);

    const brand = page.locator('[aria-label="Folio for GnuCash"]').first();
    await expect(brand).toBeVisible();
    await expect(brand).toHaveAttribute('data-testid', 'folio-stack-mark');
    await expect(brand).toHaveAttribute('width', '32');
    await expect(brand).toHaveAttribute('height', '32');
  });

  test('publishes the Folio manifest icons and labelled screenshots', async ({ request }) => {
    const manifest = await getManifest(request);

    expect(manifest.name).toBe('Folio for GnuCash');
    expect(manifest.short_name).toBe('Folio');
    expect(manifest.icons).toEqual(expectedIcons);
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({
        purpose: 'maskable',
        src: '/icons/folio-stack-maskable-512.png',
      }),
    );
    expect(manifest.screenshots).toEqual(expectedScreenshots);
  });

  test('serves every install asset with its declared image type and dimensions', async ({
    request,
  }) => {
    const manifest = await getManifest(request);

    for (const asset of [...manifest.icons, ...manifest.screenshots]) {
      const response = await request.get(asset.src);

      expect(response.status(), asset.src).toBe(200);
      expect(response.headers()['content-type'], asset.src).toContain(asset.type);

      if (asset.type === 'image/png') {
        const [width, height] = asset.sizes.split('x').map(Number);
        const metadata = await sharp(await response.body()).metadata();

        expect(
          { width: metadata.width, height: metadata.height },
          asset.src,
        ).toEqual({ width, height });
      }
    }
  });

  test('serves the cached Folio shell for an offline navigation', async ({
    context,
    page,
  }) => {
    test.skip(
      process.env.RUN_PWA_OFFLINE_E2E !== '1',
      'Live service-worker activation is reserved for post-deploy PWA QA.',
    );

    await page.goto('/');
    await waitForActiveServiceWorker(page);

    // Reload once under service-worker control so the current shell and its
    // referenced static assets pass through the cache strategy.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('[aria-label="Folio for GnuCash"]').first()).toBeVisible();

    await context.setOffline(true);
    try {
      await page.goto('/offline-shell-check', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveTitle(/Folio for GnuCash/);
      await expect(page.locator('[aria-label="Folio for GnuCash"]').first()).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
