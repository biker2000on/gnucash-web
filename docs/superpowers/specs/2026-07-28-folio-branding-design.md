# Folio branding design

## Decision

The product name is **Folio**. In prominent brand contexts, render it as **Folio** with the transitional descriptor **for GnuCash** adjacent to it (for example, `Folio` / `for GnuCash`). The descriptor establishes compatibility without making GnuCash the product name. Keep `GnuCash` wherever it denotes the desktop product, file format, schema, import/export compatibility, integrations, or legal/trademark language.

The visual system remains industrial and utilitarian: solid fields, square-to-slightly-rounded geometry, navy and teal only, and no gradients.

## Brand assets

All app-icon artwork is built from solid, flat geometry on `#0c1322` and must remain legible without a wordmark.

| Asset family | Use | Artwork | Required sizes / behavior |
| --- | --- | --- | --- |
| Stack mark | App header, marketing masthead, large install surfaces | Full-bleed `#0c1322` field; rear tile `#176f78`; front tile `#2dd4bf`; navy negative-space `F` | Use at 32px and above. It is the primary product mark. |
| Micro book mark | Compact navigation and 16px/24px browser or system surfaces | `#0c1322` field; one `#2dd4bf` book; navy negative-space `F` | Use at 24px and 16px. Do not scale the Stack mark down for these uses. |
| Any-purpose PWA icon | Normal launcher and browser presentation | Stack mark on its complete `#0c1322` square field | Export 192px and 512px PNGs with `purpose: "any"`; no OS-applied crop is assumed. |
| Maskable PWA icon | Android adaptive/maskable launcher treatment | Stack mark with its field and all meaningful geometry inside the central safe zone | Export distinct 512px PNG with `purpose: "maskable"`. Reserve the outer 20% on every edge as background-only bleed; keep the mark inside the central 60%. |
| Apple touch icon | iOS home-screen icon | Stack mark on the full `#0c1322` field | Provide a dedicated 180px PNG. Keep meaningful geometry inset enough that iOS rounding does not clip it. |
| Favicon | Browser tab and URL-bar contexts | Size-selected mark | Provide SVG plus ICO fallbacks, or an equivalent Next.js metadata icon route that emits both. The 16px raster variant uses the micro mark and the 32px raster variant uses the Stack mark. |

The background is part of every icon asset; no transparent-background icon is used. Icon geometry and colors are stored as reusable source artwork, then exported deterministically to the named raster sizes. The new assets receive `folio-` filenames so their URLs cannot collide with cached GnuCash Web assets.

## Architecture and component changes

Create one server-safe product-identity module (for example, `src/lib/product.ts`) as the sole source for display and metadata values:

```ts
export const product = {
  name: 'Folio',
  descriptor: 'for GnuCash',
  brand: 'Folio for GnuCash',
  shortName: 'Folio',
  description: 'A self-hosted, GnuCash-compatible personal finance platform.',
};
```

Add a small brand component with a required `size` prop (or an explicit `variant` prop validated against that size); it must never infer mark selection from viewport width. The component selects Stack only when the rendered icon size is at least 32px, and selects the micro single-book mark exactly at 24px and 16px. Its accessible text is supplied independently of the decorative SVG. Header and marketing variants show `Folio` plus `for GnuCash`; compact variants may expose the descriptor in an accessible label or adjacent text where space permits. Do not duplicate literal product-name strings across pages, layouts, email templates, install prompts, or metadata.

Update these user-facing locations to consume the shared identity:

- Root/main layouts, sidebar/header, dashboard welcome text, and shared-report labels.
- Marketing layout, landing page, feature pages, page titles, Open Graph/Twitter metadata, and repository-facing documentation.
- Login/authentication, install prompt, PWA manifest, install instructions, screenshots, documentation layouts/pages, and all browser metadata.
- User-visible notification/email, export, and authenticator issuer labels that name the application.

Do not rename database tables, Prisma models, package identifiers, persisted localStorage keys, API identifiers, GnuCash schema references, historical test fixtures, or compatibility-oriented copy merely because they include `gnucash`. Those are technical or semantic compatibility identifiers and must remain stable unless a separate migration explicitly authorizes them.

## Manifest, metadata, and screenshots

Replace the static `public/manifest.json` with Next's `src/app/manifest.ts`. This route imports the product-identity module and emits `/manifest.webmanifest`; it is the only authoritative source for manifest naming and description. It declares `name: product.brand`, `short_name: product.shortName`, the identity description, separate `any` and `maskable` icon entries with immutable Folio filenames, and `#0c1322` theme/background colors. The Apple touch icon is emitted through Next metadata. Screenshot labels call the application Folio and retain `for GnuCash` where a prominent product label is shown; the replacement screenshots show the new brand rather than the old wordmark. A manifest-route test asserts its text fields are the imported identity values so static brand-string drift cannot recur.

Root metadata, per-route titles, docs metadata, marketing metadata, and social images use Folio naming. Copy about importing `.gnucash`/XML files, the PostgreSQL GnuCash schema, GnuCash desktop, exact GnuCash numerics, and the non-affiliation/trademark notice remains explicit.

## Rollout, caching, and recovery

Brand assets, manifest references, and service-worker cache identifiers are versioned together. Replace `gnucash-web-v1` with an app-owned, versioned `CACHE_NAME` such as `folio-pwa-v2`. During activation, delete a cache only when `name !== CACHE_NAME` **and** its name matches an app-owned retired exact name/prefix (`gnucash-web-` or `folio-pwa-`); never delete every non-current origin cache. This condition explicitly preserves the active `folio-pwa-v2` cache. Precache these exact versioned routes: `/`, `/manifest.webmanifest`, `/favicon.svg`, `/favicon.ico`, `/icons/folio-stack-192.png`, `/icons/folio-stack-512.png`, `/icons/folio-stack-maskable-512.png`, and `/icons/folio-apple-touch-icon-180.png`. Cache a successful navigation-shell response for `/`; if a navigation request fails offline, serve that cached shell. Do not cache failed network responses as the shell.

Release validation includes a clean-install and upgrade path:

1. From a clean browser profile, load the manifest, install the PWA, and confirm the launcher icon, install name, window title, and screenshots use Folio.
2. From a profile with the old application installed, deploy the new service worker, reload until activation, and confirm stale old icons/manifest data are not served. If the platform retains the old launcher asset, unregister the service worker, clear this site's storage, reload, and reinstall; document that OS launcher caches may require removing and reinstalling the app.
3. Test offline launch after activation, then restore connectivity and verify that application data requests still recover normally. The test must seed an unrelated origin cache and prove activation retains it, then prove an upgraded install launches its cached navigation shell offline. A branding asset failure must not block the shell from loading: browser/Next icon fallbacks remain valid.

If manifest or icon URLs fail, retain a valid favicon and application title through Next metadata, report the failure through normal deployment logs, and halt remote promotion until the failed static asset is corrected. Do not expose secrets in assets, manifests, build logs, or deployment commands.

## Testing and acceptance criteria

Automated checks cover the shared identity values; the manifest route's identity-derived name, short name, and description; icon file availability, dimensions, and purposes; metadata output; and the service-worker cache-name upgrade/cleanup behavior. Component tests render 16px and 24px and assert the micro mark, render 32px and a larger size and assert the Stack mark, and assert selection is unchanged across viewport sizes. Service-worker tests assert its exact precache URL list, unrelated-cache survival, successful-navigation shell caching, and offline launch after an upgrade. Run lint, type/build validation, and the affected unit tests locally. Use browser inspection to verify manifest parsing, icon selection at 16/24/32px, accessible brand labeling, install behavior, and no stale brand strings in the targeted user-facing surfaces.

The work is accepted when:

- Every prominent product label says Folio with `for GnuCash`; compatibility/legal/domain references still accurately name GnuCash.
- The Stack mark is used at 32px and above; the micro book mark is used at 24px and 16px; all colors and fields exactly follow this specification with no gradients.
- The manifest distinguishes any and maskable icons, the maskable asset honors the 20% background-only edge safe zone, and a dedicated 180px Apple icon and favicon path are present.
- Page/route metadata, marketing, docs, login, install UI, screenshots, and PWA labels identify Folio consistently through centralized values.
- A previously installed application updates without serving an obsolete manifest or service-worker cache, preserves unrelated origin caches, and launches offline from a successfully cached navigation shell; a clean reinstall displays the correct launcher assets.

## Deployment sequence

Do all build, lint, targeted test, manifest, and install/upgrade verification locally before contacting the production host. Before pushing the approved commit to `main`, record the one shared production image's current immutable SHA/digest. The main-branch CI builds and publishes that shared image under `latest` and the immutable commit SHA, then triggers Dockhand deployment for project `gnucash-web-prod`. Because `docker-compose.prod.yml` uses mutable `latest` with pull-always behavior, wait for the build workflow to complete before assessing the deployment.

Use Docker context `truenas-box` (endpoint `ssh://justin@192.168.4.132`) only for Docker API operations; do not create or modify context aliases. Use SSH for remote filesystem and Compose operations in `/mnt/docker/volumes/dockhand/stacks/Truenas/gnucash-web-prod`, using `docker-compose.prod.yml` and the existing `.env.dockhand` file without printing or copying its values. No credentials are committed or printed. After Dockhand deploys, inspect both application and worker containers and verify they run the same expected immutable image digest and that its OCI revision exactly equals the pushed `main` commit, not merely `latest`. Then confirm HTTP availability, manifest and icon response status/content types, root and marketing metadata, fresh install, existing-install upgrade, and service-worker activation.

If any post-deploy brand or cache check fails, roll back both application and worker service references together through Dockhand to the one recorded prior immutable image SHA/digest (never a mutable tag), accounting for auto-update by pausing/disabling that project's auto-update or otherwise ensuring it cannot replace the pins with `latest`. Redeploy the pinned revision, verify both running containers use that same recorded prior digest/revision, and repeat the health, manifest, and offline-launch checks before investigating locally and attempting another promotion.
