# Folio Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the user-facing PWA to Folio for GnuCash, ship its responsive identity and versioned PWA assets, and safely promote it through the existing main-to-TrueNAS release path.

**Architecture:** `src/lib/product.ts` is the server-safe authority for all product display and metadata strings. A deterministic SVG source plus a size-explicit React brand component generates and consumes flat Folio marks; Next metadata and `manifest.ts` reference only versioned public artifacts. The service worker owns only its `folio-pwa-v2`/retired app caches, precaches the branded offline shell, and never evicts unrelated origin caches.

**Tech Stack:** Next.js 16 App Router metadata routes, React 19, TypeScript, Vitest/Testing Library, Sharp, Playwright, GitHub Actions, Docker/Dockhand, Docker context `truenas-box`.

## Global Constraints

- Product display values are exactly `Folio`, `for GnuCash`, `Folio for GnuCash`, `Folio`, and `A self-hosted, GnuCash-compatible personal finance platform.` from one `product` export.
- Use Stack only at `size >= 32`; use Micro Book only at `size === 16 || size === 24`; never choose a mark from viewport width.
- Icon fields are opaque `#0c1322`; Stack tiles are `#176f78` and `#2dd4bf`; the negative-space `F` is `#0c1322`; use solid geometry and no gradients.
- Keep `gnucash` technical identifiers, database/schema references, persisted keys, package identifiers, fixture data, API identifiers, GnuCash desktop/file-format compatibility copy, and legal/trademark copy unchanged.
- The only manifest authority is `src/app/manifest.ts`, served at `/manifest.webmanifest`; do not retain `public/manifest.json`.
- `CACHE_NAME` is `folio-pwa-v2`; activation may delete only non-current names matching `gnucash-web-` or `folio-pwa-`.
- Do not print, copy, or commit `.env.dockhand` values or other credentials. Preserve the pre-existing modification to `src/lib/__tests__/financial-statement-reports.test.ts`; never stage it.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/lib/product.ts` | Immutable, server-safe identity values and `ProductIdentity` interface. |
| `src/components/brand/BrandMark.tsx` | Explicit-size decorative Stack/Micro SVG geometry. |
| `src/components/brand/BrandLockup.tsx` | Accessible mark plus Folio/descriptor lockup for prominent and compact contexts. |
| `src/app/manifest.ts` | Sole Next manifest route importing `product` and versioned asset URLs. |
| `scripts/generate-folio-icons.ts` | Deterministically renders source SVG into PNG artifacts using Sharp and packs generated PNG buffers into an ICO container. |
| `public/icons/folio-*`, `public/favicon.*`, `public/screenshots/folio-*` | Immutable generated icon, favicon, and replacement screenshot artifacts. |
| `public/sw.js` | Versioned app-owned cache lifecycle, precache list, navigation shell fallback. |
| `src/**/__tests__/...` | Identity, manifest, mark selection, asset dimensions, and service-worker behavior tests. |

### Task 1: Shared identity and Next manifest route

**Files:**
- Create: `src/lib/product.ts`
- Create: `src/app/manifest.ts`
- Create: `src/lib/__tests__/product.test.ts`
- Create: `src/app/__tests__/manifest.test.ts`
- Modify: `src/app/layout.tsx`
- Delete: `public/manifest.json`

**Interfaces:**
- Produces: `export interface ProductIdentity { name: 'Folio'; descriptor: 'for GnuCash'; brand: 'Folio for GnuCash'; shortName: 'Folio'; description: 'A self-hosted, GnuCash-compatible personal finance platform.' }` and `export const product: ProductIdentity`.
- Produces: `export default function manifest(): MetadataRoute.Manifest` with `name`, `short_name`, and `description` taken directly from `product`.

- [ ] **Step 1: Write the failing identity and manifest tests**

```ts
import manifest from '@/app/manifest';
import { product } from '@/lib/product';

it('keeps the complete identity in one immutable product export', () => {
  expect(product).toEqual({ name: 'Folio', descriptor: 'for GnuCash', brand: 'Folio for GnuCash', shortName: 'Folio', description: 'A self-hosted, GnuCash-compatible personal finance platform.' });
});

it('derives manifest identity fields from product', () => {
  const value = manifest();
  expect([value.name, value.short_name, value.description]).toEqual([product.brand, product.shortName, product.description]);
  expect(value.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: '/icons/folio-stack-192.png', purpose: 'any' }),
    expect.objectContaining({ src: '/icons/folio-stack-maskable-512.png', purpose: 'maskable' }),
  ]));
});
```

- [ ] **Step 2: Run the tests to verify the red state**

Run: `npx vitest run src/lib/__tests__/product.test.ts src/app/__tests__/manifest.test.ts`

Expected: FAIL because `@/lib/product` and `@/app/manifest` do not exist.

- [ ] **Step 3: Implement the immutable identity and manifest**

```ts
// src/lib/product.ts
export interface ProductIdentity { name: 'Folio'; descriptor: 'for GnuCash'; brand: 'Folio for GnuCash'; shortName: 'Folio'; description: 'A self-hosted, GnuCash-compatible personal finance platform.' }
export const product: ProductIdentity = { name: 'Folio', descriptor: 'for GnuCash', brand: 'Folio for GnuCash', shortName: 'Folio', description: 'A self-hosted, GnuCash-compatible personal finance platform.' };
```

Make `manifest.ts` import `MetadataRoute` and `product`, return `id`, `scope`, `start_url`, `display: 'standalone'`, `background_color/theme_color: '#0c1322'`, finance category, all three Folio PNG icon entries, `/favicon.svg`, `/favicon.ico`, and Folio-labelled desktop/mobile screenshots. Change root `metadata.manifest` to `/manifest.webmanifest`, title/description/Apple title to `product` values, use `#0c1322` viewport theme color, and use `/icons/folio-apple-touch-icon-180.png`. Delete the static JSON manifest.

- [ ] **Step 4: Run the focused tests and build metadata route**

Run: `npx vitest run src/lib/__tests__/product.test.ts src/app/__tests__/manifest.test.ts && npm run build`

Expected: both tests PASS; build emits the manifest route without static-manifest conflicts.

- [ ] **Step 5: Commit the isolated manifest foundation**

```bash
git add src/lib/product.ts src/app/manifest.ts src/lib/__tests__/product.test.ts src/app/__tests__/manifest.test.ts src/app/layout.tsx public/manifest.json
git commit -m "feat(brand): add Folio identity and manifest route"
```

### Task 2: Responsive marks and deterministic raster exports

**Files:**
- Create: `src/components/brand/BrandMark.tsx`
- Create: `src/components/brand/BrandLockup.tsx`
- Create: `src/components/brand/__tests__/BrandMark.test.tsx`
- Create: `scripts/generate-folio-icons.ts`
- Create: `src/lib/__tests__/folio-assets.test.ts`
- Create: `public/icons/folio-stack-192.png`
- Create: `public/icons/folio-stack-512.png`
- Create: `public/icons/folio-stack-maskable-512.png`
- Create: `public/icons/folio-apple-touch-icon-180.png`
- Create: `public/favicon.svg`
- Create: `public/favicon.ico`
- Delete: `src/app/icon.svg`, `public/icons/icon.svg`, `public/icons/icon-192x192.png`, `public/icons/icon-512x512.png`

**Interfaces:**
- Consumes: `product` from `@/lib/product`.
- Produces: `export type BrandMarkSize = 16 | 24 | 32 | 40 | 48 | 64 | 128 | 192 | 512; export function BrandMark({ size, label }: { size: BrandMarkSize; label?: string }): JSX.Element`.
- Produces: `export function BrandLockup({ size, compact }: { size: BrandMarkSize; compact?: boolean }): JSX.Element`.

- [ ] **Step 1: Write the failing mark and asset tests**

```tsx
render(<BrandMark size={16} label="Folio" />);
expect(screen.getByTestId('folio-micro-mark')).toBeInTheDocument();
render(<BrandMark size={32} label="Folio" />);
expect(screen.getByTestId('folio-stack-mark')).toBeInTheDocument();
expect(screen.getByLabelText('Folio for GnuCash')).toBeInTheDocument();
```

```ts
for (const [file, width, height] of [['public/icons/folio-stack-192.png', 192, 192], ['public/icons/folio-stack-512.png', 512, 512], ['public/icons/folio-stack-maskable-512.png', 512, 512], ['public/icons/folio-apple-touch-icon-180.png', 180, 180]] as const) {
  expect(await sharp(file).metadata()).toMatchObject({ width, height, hasAlpha: false });
}
```

- [ ] **Step 2: Run the focused tests to verify the red state**

Run: `npx vitest run src/components/brand/__tests__/BrandMark.test.tsx src/lib/__tests__/folio-assets.test.ts`

Expected: FAIL because mark components and `folio-*` assets do not exist.

- [ ] **Step 3: Implement geometry, explicit selection, and exports**

```tsx
const variant = size >= 32 ? 'stack' : 'micro';
if (size !== 16 && size !== 24 && size < 32) throw new Error(`Unsupported Folio mark size: ${size}`);
```

Render flat, opaque SVG geometry with `aria-hidden` when `label` is absent and `role="img" aria-label={label}` when provided. `BrandLockup` supplies `product.brand` as the accessible label and renders visible `product.name` plus `product.descriptor` unless `compact` is true. In `generate-folio-icons.ts`, define the source SVG once and render PNGs with `sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false })`. Generate a 16px Micro PNG and a 32px Stack PNG, then write `public/favicon.ico` without a new dependency: allocate `6 + (16 * 2) + microPng.length + stackPng.length` bytes; write ICONDIR `reserved=0`, `type=1`, `count=2`; write two 16-byte ICONDIRENTRY records with widths/heights 16 and 32, `planes=1`, `bitCount=32`, byte lengths, and offsets `38` and `38 + microPng.length`; append the original PNG buffers in that order. Test that the ICO header count is 2, both entry dimensions/offsets are correct, and each embedded payload begins with the PNG signature. Enforce the maskable 512px mark bounding box within x/y `102..410` (the central 60%). Produce opaque backgrounds only.

- [ ] **Step 4: Generate assets and prove selection is viewport-independent**

Run: `npx tsx scripts/generate-folio-icons.ts && npx vitest run src/components/brand/__tests__/BrandMark.test.tsx src/lib/__tests__/folio-assets.test.ts`

Expected: exports have exactly 192×192, 512×512, 512×512, and 180×180 dimensions with no alpha; tests PASS for 16/24 Micro and 32/64 Stack even after changing `window.innerWidth`.

- [ ] **Step 5: Commit visual assets and their deterministic source**

```bash
git add src/components/brand scripts/generate-folio-icons.ts src/lib/__tests__/folio-assets.test.ts public/icons/folio-*.png public/favicon.svg public/favicon.ico src/app/icon.svg public/icons/icon.svg public/icons/icon-192x192.png public/icons/icon-512x512.png
git commit -m "feat(brand): add responsive Folio marks and icons"
```

### Task 3: Migrate primary UI, page metadata, and marketing copy

**Files:**
- Modify: `src/components/Layout.tsx`
- Modify: `src/components/LoginForm.tsx`
- Modify: `src/app/(main)/dashboard/page.tsx`
- Modify: `src/components/CreateBookWizard.tsx`
- Modify: `src/contexts/PWAInstallContext.tsx`
- Modify: `src/app/(marketing)/layout.tsx`
- Modify: `src/app/(marketing)/page.tsx`
- Modify: `src/app/(marketing)/features/page.tsx`
- Modify: `src/app/(marketing)/features/[slug]/page.tsx`
- Modify: `src/app/share/[token]/page.tsx`
- Modify: `src/app/share/invoice/[token]/page.tsx`
- Create: `src/components/brand/__tests__/BrandLockup.test.tsx`

**Interfaces:**
- Consumes: `BrandLockup({ size, compact })`, `BrandMark({ size, label })`, and `product` from Tasks 1–2.
- Produces: all primary UI product labels from shared identity imports, retaining `GnuCash` only for compatibility meaning.

- [ ] **Step 1: Write the failing lockup and primary-surface assertions**

```tsx
render(<BrandLockup size={32} />);
expect(screen.getByText('Folio')).toBeInTheDocument();
expect(screen.getByText('for GnuCash')).toBeInTheDocument();
expect(screen.getByLabelText('Folio for GnuCash')).toBeInTheDocument();
```

Add source-level assertions that `Layout.tsx`, `LoginForm.tsx`, and marketing layout import `product` or `BrandLockup` and contain no literal `GnuCash Web`.

- [ ] **Step 2: Run the focused test to verify the red state**

Run: `npx vitest run src/components/brand/__tests__/BrandLockup.test.tsx`

Expected: FAIL until the lockup and migrated consumers exist.

- [ ] **Step 3: Replace primary visual and metadata consumers**

Replace header/sidebar/mobile-header/login/marketing wordmarks with the responsive components: use 24px Micro for compact navigation, 32px Stack for header/masthead/login, and import `product` for welcome, install, titles, descriptions, share metadata, Open Graph, and Twitter values. Preserve all prose that names GnuCash desktop, `.gnucash`, XML, or compatibility. Keep existing Tailwind design tokens, solid navy/teal fields, and no gradients.

- [ ] **Step 4: Prove primary labels and metadata are coherent**

Run: `npx vitest run src/components/brand/__tests__/BrandLockup.test.tsx && npm run lint`

Expected: tests PASS; lint reports no new errors.

- [ ] **Step 5: Commit the primary consumer migration**

```bash
git add src/components/Layout.tsx src/components/LoginForm.tsx 'src/app/(main)/dashboard/page.tsx' src/components/CreateBookWizard.tsx src/contexts/PWAInstallContext.tsx 'src/app/(marketing)' src/app/share src/components/brand/__tests__/BrandLockup.test.tsx
git commit -m "feat(brand): apply Folio identity to primary UI"
```

### Task 4: Migrate secondary copy while preserving semantic GnuCash boundaries

**Files:**
- Modify: `src/app/docs/layout.tsx`
- Modify: `src/app/docs/page.tsx`
- Modify: `src/app/docs/{admin,concepts,features,getting-started,guides}/**/*.tsx`
- Modify: `src/app/(main)/profile/page.tsx`
- Modify: `src/app/(main)/tools/emergency/page.tsx`
- Modify: `src/app/(main)/settings/api-docs/page.tsx`
- Modify: `src/components/settings/TwoFactorSection.tsx`
- Modify: `src/lib/email.ts`
- Modify: `src/lib/report-scheduler.ts`
- Modify: `src/lib/totp.ts`
- Modify: `src/lib/tax/txf-file.ts`
- Modify: `src/lib/ical.ts`
- Modify: `src/lib/swagger.ts`
- Modify: `README.md`
- Create: `src/lib/__tests__/product-copy-boundaries.test.ts`

**Interfaces:**
- Consumes: `product.brand`, `product.description`, `product.name` from `@/lib/product`.
- Produces: notification/email subjects, export labels, TOTP issuer, API/docs metadata, and repository-facing display copy derived from `product`; stable filenames, package IDs, slots, cache/localStorage keys, schemas, and GnuCash domain references remain untouched.

- [ ] **Step 1: Write failing boundary tests**

```ts
expect(buildTotpUri('alice', 'secret')).toContain('issuer=Folio%20for%20GnuCash');
expect(renderNotificationEmail({ title: 'Ready', type: 'report' }).subject).toBe('[Folio for GnuCash] Ready');
expect(readFileSync('src/lib/ical.ts', 'utf8')).toContain('PRODID:-//Folio for GnuCash//Calendar Feed//EN');
expect(readFileSync('src/lib/business/stripe-webhook.ts', 'utf8')).toContain('gnucash-web/payment-event');
```

- [ ] **Step 2: Run targeted tests to verify red state**

Run: `npx vitest run src/lib/__tests__/product-copy-boundaries.test.ts`

Expected: FAIL because email/TOTP/calendar/export copy still names GnuCash Web.

- [ ] **Step 3: Centralize visible secondary copy without changing identifiers**

Import `product` into user-visible notification email, report schedule email, TOTP provisioning, TXF software label, iCalendar display name/PRODID, Swagger title/description, docs metadata, profile/install descriptions, emergency export text, API-docs title, and README branding. Keep calendar UIDs, `.ics` download name, `gnucash-web` database slots, `gnucash_web` table names, persistent storage names, API schema identifiers, and compatibility/trademark mentions exactly unchanged.

- [ ] **Step 4: Run boundary regression tests**

Run: `npx vitest run src/lib/__tests__/product-copy-boundaries.test.ts src/lib/__tests__/totp.test.ts && rg -n -i "GnuCash Web" src README.md --glob '!**/__tests__/**' --glob '!**/*.test.*'`

Expected: tests PASS; remaining hits are reviewed semantic compatibility or stable technical identifiers, not prominent product labels.

- [ ] **Step 5: Commit the secondary migration**

```bash
git add src/app/docs 'src/app/(main)/profile/page.tsx' 'src/app/(main)/tools/emergency/page.tsx' 'src/app/(main)/settings/api-docs/page.tsx' src/components/settings/TwoFactorSection.tsx src/lib/email.ts src/lib/report-scheduler.ts src/lib/totp.ts src/lib/tax/txf-file.ts src/lib/ical.ts src/lib/swagger.ts src/lib/__tests__/product-copy-boundaries.test.ts README.md
git commit -m "feat(brand): migrate Folio notifications and docs"
```

### Task 5: Version service-worker cache and offline shell

**Files:**
- Modify: `public/sw.js`
- Create: `src/lib/__tests__/service-worker-cache.test.ts`

**Interfaces:**
- Produces: `const CACHE_NAME = 'folio-pwa-v2'`, exact `PRECACHE_URLS`, and `isRetiredAppCache(name: string): boolean` in `public/sw.js`.
- Consumes: `/manifest.webmanifest`, `/favicon.svg`, `/favicon.ico`, and all four named Folio icon routes from Tasks 1–2.

- [ ] **Step 1: Write failing service-worker behavior tests**

```ts
expect(source).toContain("const CACHE_NAME = 'folio-pwa-v2'");
expect(precacheUrls).toEqual(['/', '/manifest.webmanifest', '/favicon.svg', '/favicon.ico', '/icons/folio-stack-192.png', '/icons/folio-stack-512.png', '/icons/folio-stack-maskable-512.png', '/icons/folio-apple-touch-icon-180.png']);
expect(isRetiredAppCache('third-party-cache')).toBe(false);
expect(isRetiredAppCache('gnucash-web-v1')).toBe(true);
expect(isRetiredAppCache('folio-pwa-v1')).toBe(true);
```

Mock `caches`, successful and rejected navigation fetches, then assert activation preserves `third-party-cache`, deletes `gnucash-web-v1`, retains `folio-pwa-v2`, caches only an `ok` navigation response at `/`, and serves that `/` response when the upgraded worker is offline.

- [ ] **Step 2: Run the focused test to verify red state**

Run: `npx vitest run src/lib/__tests__/service-worker-cache.test.ts`

Expected: FAIL because the worker uses `gnucash-web-v1`, broad deletion, `/manifest.json`, and no install precache/shell cache.

- [ ] **Step 3: Implement safe cache lifecycle and navigation fallback**

```js
const CACHE_NAME = 'folio-pwa-v2';
const PRECACHE_URLS = ['/', '/manifest.webmanifest', '/favicon.svg', '/favicon.ico', '/icons/folio-stack-192.png', '/icons/folio-stack-512.png', '/icons/folio-stack-maskable-512.png', '/icons/folio-apple-touch-icon-180.png'];
const isRetiredAppCache = (name) => /^(gnucash-web-|folio-pwa-)/.test(name) && name !== CACHE_NAME;
```

On install, open `CACHE_NAME`, `addAll(PRECACHE_URLS)`, and `skipWaiting`. On activate, `clients.claim()` and delete only `isRetiredAppCache(name)`. For navigation, fetch first; only if `response.ok`, clone it into `CACHE_NAME` at `/`; on failure, return `caches.match('/')`. Do not cache failed/non-OK shell responses; retain existing API bypass and static-asset behavior updated for Folio routes.

- [ ] **Step 4: Run the cache upgrade/offline tests**

Run: `npx vitest run src/lib/__tests__/service-worker-cache.test.ts`

Expected: PASS, including unrelated cache survival and upgraded offline navigation shell launch.

- [ ] **Step 5: Commit the service-worker migration**

```bash
git add public/sw.js src/lib/__tests__/service-worker-cache.test.ts
git commit -m "fix(pwa): version Folio cache and offline shell"
```

### Task 6: Replace screenshots and complete local browser/PWA QA

**Files:**
- Create: `public/screenshots/folio-mobile.png`
- Create: `public/screenshots/folio-desktop.png`
- Modify: `src/app/manifest.ts`
- Create: `tests/e2e/folio-pwa.spec.ts`

**Interfaces:**
- Consumes: `manifest()` and all Folio assets/caches from Tasks 1–5.
- Produces: manifest screenshot entries labelled `Folio for GnuCash on mobile` and `Folio for GnuCash on desktop` and browser-level evidence for metadata, manifest, accessibility, mark sizing, and offline shell.

- [ ] **Step 1: Write the failing Playwright assertions**

```ts
await expect(page).toHaveTitle(/Folio for GnuCash/);
await expect(page.locator('[aria-label="Folio for GnuCash"]')).toBeVisible();
const manifest = await page.evaluate(() => fetch('/manifest.webmanifest').then((r) => r.json()));
expect(manifest.short_name).toBe('Folio');
expect(manifest.icons).toContainEqual(expect.objectContaining({ purpose: 'maskable', src: '/icons/folio-stack-maskable-512.png' }));
```

- [ ] **Step 2: Run the test to verify red state**

Run: `npx playwright test tests/e2e/folio-pwa.spec.ts`

Expected: FAIL until the test configuration and screenshots target the new route/assets.

- [ ] **Step 3: Capture and wire replacement screenshots**

Use the authenticated local browser state to capture 1080×1920 and 1920×1080 images whose visible header/lockup is Folio for GnuCash; write them under `public/screenshots/`. Update manifest entries to those routes, exact dimensions, PNG type, narrow/wide form factors, and the required Folio labels. Add Playwright configuration if absent so it starts `npm run dev` and uses `http://127.0.0.1:3000`.

- [ ] **Step 4: Run browser QA including clean/install-upgrade evidence**

Run: `npx playwright test tests/e2e/folio-pwa.spec.ts`

Expected: PASS; browser inspection confirms manifest parses, 16/24 use Micro, 32+ use Stack, label is accessible, all manifest/icon responses are 200 with correct image/content types, and offline navigation serves the cached shell after service-worker activation.

- [ ] **Step 5: Commit screenshots and browser coverage**

```bash
git add public/screenshots/folio-mobile.png public/screenshots/folio-desktop.png src/app/manifest.ts tests/e2e/folio-pwa.spec.ts playwright.config.ts
git commit -m "test(pwa): verify Folio manifest and install assets"
```

### Task 7: Full local verification and clean staging

**Files:**
- Modify: `src/lib/product.ts`, `src/app/manifest.ts`, `src/app/layout.tsx`, `src/components/brand/BrandMark.tsx`, `src/components/brand/BrandLockup.tsx`, `scripts/generate-folio-icons.ts`, `public/sw.js`, `tests/e2e/folio-pwa.spec.ts`, or their tests only when the release gate identifies a defect in that exact file

**Interfaces:**
- Verifies: the committed Folio identity, static assets, metadata route, and worker behavior as a release candidate.

- [ ] **Step 1: Inspect intended and unrelated worktree changes**

Run: `git status --short && git diff -- src/lib/__tests__/financial-statement-reports.test.ts`

Expected: the financial-statement test is still a pre-existing unrelated modification; no command stages or reverts it.

- [ ] **Step 2: Run the complete local release gate**

Run: `npm run lint && npm run test:run && npm run build && npm run docs:check && npx playwright test tests/e2e/folio-pwa.spec.ts`

Expected: every command exits 0; production build exposes `/manifest.webmanifest` and generated Folio static assets.

- [ ] **Step 3: Scan for stale product labels and prohibited cache deletion**

Run: `rg -n -i "GnuCash Web" src README.md --glob '!**/__tests__/**' --glob '!**/*.test.*'; rg -n "caches\.delete|manifest\.json|gnucash-web-v1" public/sw.js src/app`

Expected: every remaining `GnuCash Web` is an intentionally retained domain/legal/compatibility statement verified against the spec; worker output contains no `/manifest.json`, broad cache deletion, or active `gnucash-web-v1` reference.

- [ ] **Step 4: Commit a release-gate correction only when one exists**

Run: `git diff --name-only -- src/lib/product.ts src/app/manifest.ts src/app/layout.tsx src/components/brand/BrandMark.tsx src/components/brand/BrandLockup.tsx scripts/generate-folio-icons.ts public/sw.js tests/e2e/folio-pwa.spec.ts src/lib/__tests__/product.test.ts src/app/__tests__/manifest.test.ts src/components/brand/__tests__/BrandMark.test.tsx src/components/brand/__tests__/BrandLockup.test.tsx src/lib/__tests__/folio-assets.test.ts src/lib/__tests__/product-copy-boundaries.test.ts src/lib/__tests__/service-worker-cache.test.ts`

Expected: if this prints no paths, make no commit. If it prints paths, run `$owned = git diff --name-only -- src/lib/product.ts src/app/manifest.ts src/app/layout.tsx src/components/brand/BrandMark.tsx src/components/brand/BrandLockup.tsx scripts/generate-folio-icons.ts public/sw.js tests/e2e/folio-pwa.spec.ts src/lib/__tests__/product.test.ts src/app/__tests__/manifest.test.ts src/components/brand/__tests__/BrandMark.test.tsx src/components/brand/__tests__/BrandLockup.test.tsx src/lib/__tests__/folio-assets.test.ts src/lib/__tests__/product-copy-boundaries.test.ts src/lib/__tests__/service-worker-cache.test.ts; git add -- $owned; git commit -m "fix(brand): address Folio release verification"`; never stage `src/lib/__tests__/financial-statement-reports.test.ts`.

### Task 8: Push main, verify CI/Dockhand, deploy through TrueNAS, and retain rollback evidence

**Files:**
- Modify: no repository files unless a locally reproduced failed deployment check requires a new approved fix.

**Interfaces:**
- Consumes: current `main` commit SHA, GHCR image `ghcr.io/biker2000on/gnucash-web`, Docker context `truenas-box`, and remote stack `/mnt/docker/volumes/dockhand/stacks/Truenas/gnucash-web-prod/docker-compose.prod.yml`.
- Produces: recorded prior immutable app/worker digest, confirmed deployed digest and OCI revision equal to pushed `main`, or a verified dual-service rollback to the recorded digest.

- [ ] **Step 1: Record the exact pre-promotion image for both services**

Run: `ssh justin@192.168.4.132 "cd /mnt/docker/volumes/dockhand/stacks/Truenas/gnucash-web-prod && docker compose --env-file .env.dockhand -f docker-compose.prod.yml ps && docker compose --env-file .env.dockhand -f docker-compose.prod.yml images"`

Expected: capture the running app and worker image IDs/digests before push without printing `.env.dockhand`; if they differ, stop promotion and investigate because the required rollback point must be one shared immutable image. Docker context `truenas-box` is reserved for Docker API commands such as `docker --context truenas-box ps` and `docker --context truenas-box image inspect`, never remote compose-file paths.

- [ ] **Step 2: Push the already-verified main history**

Run: `git status --short; git log -1 --format=%H; git push origin main`

Expected: only the unrelated financial-statement test remains unstaged locally; push succeeds and the recorded SHA is the deployment revision candidate.

- [ ] **Step 3: Wait for main CI image publication and Dockhand trigger**

Run: `$run = gh run list --branch main --workflow deploy.yml --limit 1 --json databaseId,status,conclusion,headSha,url | ConvertFrom-Json | Select-Object -First 1; $run; gh run watch $run.databaseId --exit-status`

Expected: workflow file `deploy.yml` (`Build and Push Docker Image`) succeeds for the pushed SHA, publishing both `latest` and `$(git rev-parse --short HEAD)` because `type=sha,prefix=` has an empty prefix; do not assess Dockhand before this succeeds.

- [ ] **Step 4: Inspect the remote deployment without reading secrets**

Run: `ssh justin@192.168.4.132 "cd /mnt/docker/volumes/dockhand/stacks/Truenas/gnucash-web-prod && docker compose --env-file .env.dockhand -f docker-compose.prod.yml ps && docker compose --env-file .env.dockhand -f docker-compose.prod.yml images"`

Expected: app and worker are healthy and use the same new immutable digest. Do not print `.env.dockhand`; use it only as Compose input.

- [ ] **Step 5: Verify digest/revision, HTTP assets, and upgrade/offline behavior**

Run: `$imageTag = "ghcr.io/biker2000on/gnucash-web:$(git rev-parse --short HEAD)"; docker --context truenas-box image inspect $imageTag --format '{{index .RepoDigests 0}} {{index .Config.Labels "org.opencontainers.image.revision"}}'`

Expected: the deployed app and worker digest matches this immutable RepoDigest and OCI revision equals the pushed full main SHA. Then inspect `https://cash.adventureintandem.com/`, `/manifest.webmanifest`, `/favicon.svg`, `/favicon.ico`, and each `/icons/folio-*.png` for 200/status content types; use a clean profile for install name/icon/screenshot/window title and an existing-install profile for activation, stale-manifest eviction, offline shell launch, reconnect/recovery, and accessible Folio labels.

- [ ] **Step 6: Roll back both services only if a post-deploy assertion fails**

Run: `ssh justin@192.168.4.132 "cd /mnt/docker/volumes/dockhand/stacks/Truenas/gnucash-web-prod && docker compose --env-file .env.dockhand -f docker-compose.prod.yml pull && docker compose --env-file .env.dockhand -f docker-compose.prod.yml up -d --no-deps app worker"`

Expected: before this command, edit service image references through Dockhand to the recorded prior immutable digest and pause that project’s auto-update so `latest` cannot replace the pins. After redeploy, app and worker both match the recorded prior digest/revision and HTTP, manifest, icon, and offline shell checks pass. Only then investigate the failed assertion locally and make a new promotion.

## Plan self-review

- Spec coverage: Tasks 1–2 implement centralized identity, responsive marks, deterministic any/maskable/Apple/favicon assets; Tasks 3–4 migrate every requested user-facing category while keeping GnuCash semantic boundaries; Task 5 covers exact precache, safe cleanup, upgrades, and offline shell; Task 6 covers screenshots/install/browser inspection; Tasks 7–8 cover local gates, main CI, TrueNAS/Dockhand digest verification, and immutable dual-service rollback.
- Placeholder scan: no deferred implementation marker or unspecified test behavior remains; the only conditional is an explicitly optional verification-correction commit.
- Type consistency: all consumers use `product`, `BrandMark`, `BrandLockup`, `manifest`, `CACHE_NAME`, `PRECACHE_URLS`, and `isRetiredAppCache` exactly as declared in their producing tasks.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-28-folio-branding.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration.

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
