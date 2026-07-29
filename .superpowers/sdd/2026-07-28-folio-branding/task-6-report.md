# Task 6 report: Folio browser and PWA QA

## Prior blocker and resolution

The inherited browser test initially received HTML for `/manifest.webmanifest` because
the authentication middleware redirected that route to `/login`. The middleware matcher
now excludes exactly `manifest.webmanifest`; protected application pages and APIs retain
their existing matcher behavior.

The initial production-server test could not start because this worktree lacked a
complete `.next` build. A scoped production build then stalled in Windows standalone
file tracing (`EINVAL` while copying a traced chunk). Browser QA was therefore run with
the configured direct Next development server, bounded by Playwright's 120-second
web-server timeout.

## Files

- `src/middleware.ts` — makes the generated manifest public.
- `playwright.config.ts` — starts the direct local server at `127.0.0.1:3000`.
- `tests/e2e/folio-pwa.spec.ts` — deterministic title, accessible lockup, manifest,
  asset type/status, and raster-dimension assertions.
- `public/screenshots/folio-mobile.png` — public Folio landing page, 1080x1920 PNG.
- `public/screenshots/folio-desktop.png` — public Folio landing page, 1920x1080 PNG.
- `src/app/manifest.ts` was reviewed and already wired to the exact screenshot routes,
  dimensions, PNG type, narrow/wide form factors, Folio labels, any icons, and maskable
  Stack icon.

## Commands and results

- `npx playwright test tests/e2e/folio-pwa.spec.ts --project=chromium`
  - 3 passed, 1 intentionally skipped (offline service-worker test).
- `npx playwright test tests/e2e/folio-capture.tmp.spec.ts --project=chromium`
  - 1 passed; generated both replacement screenshots. The temporary capture spec was
    removed afterwards.
- Sharp metadata inspection
  - `folio-mobile.png`: 1080x1920 PNG.
  - `folio-desktop.png`: 1920x1080 PNG.
- `npm run build`
  - Timed out in Next standalone file tracing on Windows (`EINVAL`), not retried.
- Scoped `npx eslint ...`
  - Stalled without output and timed out, not retried.

## Limitations

Live clean-install, activation/upgrade, and offline navigation evidence is deliberately
deferred to Task 8 post-deploy QA. The Playwright offline test is skipped unless
`RUN_PWA_OFFLINE_E2E=1`; Task 5 service-worker unit coverage remains the local evidence.

## Self-review

The browser suite verifies the public manifest parses as JSON, Folio title and labelled
32px Stack lockup are visible, all declared icons/screenshots return HTTP 200 with their
declared content types, the any and maskable entries are present, and PNG dimensions
match manifest declarations. The manifest exception is route-specific and does not
broaden authentication for protected app routes.

Commit: `7b06803` (`test(pwa): verify Folio manifest and install assets`).
