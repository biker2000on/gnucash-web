# Polyagent cross-model review — vault preview freeze / forever-spinning loads

**Run:** `20260821-preview-freeze-rev1` · **Pinned commit:** `0afb4535` (deployed)
**Reviewers:** Claude Opus (client render/overlay forensics) and Codex gpt-5.6-sol (network/service-worker lifecycle) — both completed with source-clean worktrees. Grok 4.6 failed again without producing a report (fourth consecutive review-mode failure; its build-integrity lens was covered by the lead: the deployed image's chunk verifiably contains the native `import("/pdf.min.mjs")`, prod serves both vendored files with `application/javascript`, and the app emits no Content-Security-Policy header).

## Reported symptoms
1. Pages intermittently freeze with the tab spinner never stopping.
2. Vault Preview click: no visible dialog, page scrollable, nothing clickable.

## Root-cause chain (deduplicated, verified against the pinned commit)

| # | Finding | Evidence | Produces |
|---|---|---|---|
| 1 | **Preview's HEAD probe is a full-file GET with no deadline.** The download route exports only GET; Next serves HEAD by running GET, so each probe authenticates and reads the ENTIRE object from MinIO/S3 — and the real fetch then reads it again. No `AbortSignal`, no timeout; `S3Storage.get()` awaits stream EOF with no SDK timeouts. | `DocumentPreviewModal.tsx:56-84`, `download/route.ts:19-39`, `entity-documents.service.ts:555-569`, `s3-storage.ts:30-35` | A stalled storage read pins the modal in "probing" forever |
| 2 | **The modal in that state is a dim fullscreen backdrop with a tiny "Loading preview…"** — readable as "no modal" — and the backdrop swallows every click. | `Modal.tsx:123-140` | "Nothing clickable" |
| 3 | **The modal's scroll lock is a no-op**: it sets `overflow:hidden` on `body`, but the app scrolls `<main>` inside a `h-screen` shell. | `Modal.tsx:69-77` vs `Layout.tsx:776,1009` | "Still scrollable" while blocked |
| 4 | **`loadPdfJs()` memoizes a promise that can stay pending forever** (reset only on rejection), and a pending native module import is a document script load — exactly what keeps Chrome's tab spinner spinning. One stall poisons every later preview until a full reload. | `pdfjs-client.ts:44-68` | "Spinner never stops" + stickiness |
| 5 | **The vault fires one unbounded thumbnail fetch per card** — N concurrent full storage reads on page load, on a ZFS pool documented to suffer IO storms. This is what makes the storage stalls of #1 likely in the first place. | `DocumentVaultBrowser.tsx:189-223` | Concentrates failures on the vault |
| 6 | **Service worker v3 foreground chains are unbounded and cache-write-coupled**: navigations `await cache.put()` before returning the response; static misses likewise; catch-alls have no deadline; `caches.match()` fallbacks can fulfil `respondWith` with `undefined`. | `sw.js:69-138` | Forever-pending navigations under flaky network |
| 7 | **v2→v3 worker handoff is racy**: install-time `skipWaiting` can activate before the page records `registration.waiting`, so `controllerchange` skips its reload and a v2-era runtime keeps running under a v3 controller. | `sw.js:15-21,30-42`, `PWAInstallContext.tsx:199-239` | Stale-runtime tabs that keep old bugs alive after deploys |
| 8 | (Defused) HTTP/1.1 six-connection starvation from the three permanent SSE streams — prod negotiates **h2** at the domain, so this only bites direct `http://truenas:3004` access; still worth collapsing the unconditional jobs-stream connect. | `Layout.tsx:1027-1029`, `JobProgressContext.tsx:352-357` | — |

Rejected (verified non-causes): stale RSC serving (v3 bypasses correctly), `.mjs` MIME/middleware/standalone delivery, CSP on the byte route blocking `arrayBuffer()`, pdf.js eval probes (feature-detected and caught).

## Field diagnostic
If Escape (or the close button) dismisses the frozen state → findings 1–3 (probe hang under the backdrop). If Escape does nothing → the page never hydrated (stale runtime, finding 7, or direct-port HTTP/1.1 starvation, finding 8).

## Fix plan (applied in the follow-up commits)
1. Delete the HEAD probe; render preview optimistically from the caller's MIME/filename and let the real GET surface errors. Add a true headers-only HEAD handler to the download route.
2. Deadline + `AbortController` on the preview byte fetch; timeout-race in `loadPdfJs` that rejects (resetting the memo) with a visible error.
3. Lock the real scroller during modals.
4. Cap thumbnail concurrency and gate fetches on visibility.
5. Service worker: respond-first/cache-later via `waitUntil`, deadline-raced foreground fetches, `Response.error()` fallbacks, and a deterministic controller-change reload.
6. SDK timeouts on S3 storage reads.
