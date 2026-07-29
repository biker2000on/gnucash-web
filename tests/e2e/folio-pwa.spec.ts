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

function readIcoDimensions(buffer: Buffer): Array<{ width: number; height: number }> {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);

  const imageCount = buffer.readUInt16LE(4);
  return Array.from({ length: imageCount }, (_, index) => {
    const offset = 6 + index * 16;
    return {
      width: buffer.readUInt8(offset) || 256,
      height: buffer.readUInt8(offset + 1) || 256,
    };
  });
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

  test('keeps the mobile marketing header within the viewport', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
    const page = await context.newPage();

    await page.goto('/');
    await expect(page.locator('[data-testid="marketing-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="marketing-open-books"]')).toBeVisible();

    const layout = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const controls = ['[aria-label="Folio for GnuCash"]', '[data-testid="marketing-open-books"]']
        .map((selector) => document.querySelector(selector)?.getBoundingClientRect())
        .filter((rect): rect is DOMRect => rect !== undefined && rect !== null)
        .map(({ left, right }) => ({ left, right }));

      return { controls, scrollWidth: document.documentElement.scrollWidth, viewportWidth };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.controls).toHaveLength(2);
    for (const control of layout.controls) {
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(layout.viewportWidth);
    }

    await context.close();
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

      if (asset.type === 'image/x-icon') {
        expect(readIcoDimensions(Buffer.from(await response.body()))).toEqual(
          expect.arrayContaining([
            { width: 16, height: 16 },
            { width: 32, height: 32 },
          ]),
        );
        expect(asset.sizes).toBe('32x32');
      }
    }
  });

  test('only exposes the exact manifest route outside authentication', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest', { maxRedirects: 0 });
    expect(manifest.status()).toBe(200);

    const protectedPrefix = await request.get('/manifest.webmanifest-private', {
      maxRedirects: 0,
    });
    expect(protectedPrefix.status()).toBe(307);
    expect(protectedPrefix.headers().location).toContain('/login?redirect=%2Fmanifest.webmanifest-private');
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
