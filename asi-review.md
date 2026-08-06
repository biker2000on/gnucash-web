# ASI Review — GnuCash Web

**Date:** 2026-08-04 (local, UTC-4)
**ASI standard:** 0.5
**Review agent:** Claude Code (Claude Fable 5), orchestrating 7 parallel read-only review subagents
**Mode:** Full
**Reviewed commit:** 9c4c1488160c0feba3fb8c133357c476c707bb50 (main, clean worktree)
**Comparison base:** Not applicable
**Release recommendation:** Conditional

## Executive Summary

GnuCash Web is a self-hosted Next.js 16 / React 19 / TypeScript PWA over a live
GnuCash PostgreSQL schema, deployed continuously from `main` to a TrueNAS box.
The overall engineering health is **good and clearly hardened by prior audits**:
the auth foundation fails closed, ledger writes are transactional with row
locks and optimistic tokens, the money-fraction math (`toDecimal`) is correct
including non-power-of-ten denominators, the federal tax engine matches its
cited Rev. Procs., 4,507 unit tests pass, and the type check and lint are clean.

The review still found 8 High findings that warrant fixing before further
releases, clustered in four themes:

1. **Nothing gates prod.** CI runs no tests or lint before building and
   auto-deploying the image, rollback is undocumented against a `:latest` +
   `pull_policy: always` stack, and `db-init` executes destructive SQL
   (row deletes, native-index drops) on every boot with no migration tracking
   or backup gate.
2. **Two real financial-math defects.** Lot summaries ignore `carried_basis`,
   so in-kind-transferred lots show inflated gains and the tax-harvesting
   report misses genuine losses; and `findExchangeRate` can mutually recurse
   forever for a commodity with no USD/EUR price rows.
3. **Secrets and supply chain.** A real-looking app password is committed in
   three tracked Playwright specs (rotate it now), and the Docker build
   disables TLS verification and uses `npm install` instead of `npm ci`,
   making the deployed dependency tree neither pinned nor integrity-checked.
4. **One dangerous operational script.** `scripts/jh-401k-separate.mjs` writes
   to whatever database is pasted on the command line *by default* (dry-run is
   opt-in), inverting the convention every other repair script uses.

No Critical finding is open: the single Critical-severity advisory
(`node-tesseract-ocr` command injection) is mitigated in code by passing only
server-generated paths, and no reachable data-loss path was demonstrated.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 8 |
| Medium | 23 |
| Low | 27 |

## Scope and Confidence

- **Reviewed:** All application source (`src/`, 1,632 TS/TSX files, 419 API
  routes), `worker.ts`, `scripts/`, `utilities/`, `sql/`, `prisma/`,
  `Dockerfile`, `docker-entrypoint.sh`, both compose files,
  `.github/workflows/deploy.yml`, `package.json`/`package-lock.json`, test
  suites (`src/**/__tests__`, `tests/`), and `docs/` operational plans.
- **Excluded:** `node_modules/`, build artifacts, `.claude/worktrees/`
  leftovers, `data/` contents, `public/` assets.
- **Not reviewed:** The actual Dockhand stack definition on TrueNAS (not in
  repo — compose-level findings should be re-checked against it); prod runtime
  env values; `src/lib/tax/state.ts`, `fx-revaluation.ts`, income-statement /
  cash-flow report internals, Schedule F business modules (correctness pass ran
  out of scope); ~29 of 39 report routes for performance; per-route
  book-isolation was sampled, not exhaustive across all 419 routes.
- **Assumptions:** Single-household self-hosted deployment behind the owner's
  network; the prod DB holds the household's real books (data loss is severe);
  whether desktop GnuCash still opens the prod DB is **unresolved** — the task
  context says yes, `db-init.ts:2489` asserts no. This changes the severity of
  the native-index drops (ASI-7-002).
- **Overall confidence:** Medium-High. All Critical/High claims were verified
  by direct file reads at the reviewed commit; subagent Medium/Low citations
  were spot-checked. No runtime/DB execution was performed beyond the safe
  commands below.
- **Applicable optional modules:** Web and User Interface (partial — client
  vs. server authorization checked; accessibility not assessed, no stated
  target), Database and Data Pipeline, Infrastructure/Container/Cloud, AI and
  Model-Integrated Systems (AI query guardrails). Mobile/Desktop and API/SDK
  modules: not applicable.

## Verification Evidence

| Command or check | Result | Evidence / limitation |
|------------------|--------|-----------------------|
| `npx tsc --noEmit` | Passed | Exit 0, no diagnostics |
| `npx vitest run` | Passed | 327 files, 4,507 tests, 0 failures, ~46 s |
| `npm run lint` (ESLint 9) | Passed | 0 errors, 78 warnings (unused vars, 2 hook-deps; ~half duplicated from `.claude/worktrees` copies being linted) |
| `npm audit` (2026-08-04) | Failed (findings) | 28 vulnerabilities: 1 critical (`node-tesseract-ocr` GHSA-8j44-735h-w4w2, no fix), 15 high (incl. `next` 16.1.1 advisories, `sharp` <0.35, `axios`, `postcss`, `vite`, `ws`), 10 moderate, 2 low |
| `npm run build` | Not run | Long-running; type-check already covered by tsc, and the Docker build performs it |
| Playwright e2e | Not run | Suite is not runnable from a clean checkout (ASI-2-002); depends on a live dev server and personal data |
| Database checks (EXPLAIN, migrations) | Not run | Read-only review; no DB connection used |

## Findings

### High

#### ASI-3-001: Real application credentials committed in three tracked test files

- **Check:** Security
- **Confidence:** High
- **Location:** `tests/test-reports.spec.ts:4-5`, `tests/e2e/review-mode.spec.ts:4-5`, `tests/test-investment-charts.spec.ts:16-17`
- **Evidence:** Plaintext username `biker2000on` and a 32-char password are hardcoded and tracked in git (introduced at commit 480bec5 "wip"); the username matches the repo owner's identity, so this is presumably the live app login.
- **Impact:** Anyone with repo (or git-history) read access has the password to the household's financial system. Persists in history even after removal.
- **Recommendation:** Rotate the password immediately; switch specs to `process.env.E2E_USER`/`E2E_PASS`; scrub history if the repo is or ever becomes shared.
- **Regression verification:** `git grep -I '6ujn'` returns nothing; the old password is rejected at `/login`.
- **Status:** Mitigated 2026-08-05 — password rotated by the owner; the committed string is now inert. Residual: specs still hardcode the dead credential — env-var switch and dead-spec removal tracked under ASI-2-002 — **Owner:** Unassigned

#### ASI-3-002: Docker build disables TLS verification and does not enforce the lockfile

- **Check:** Security (supply chain)
- **Confidence:** High
- **Location:** `Dockerfile:8` (`npm config set strict-ssl false && npm install`), `Dockerfile:27-28`, `Dockerfile:47`, `Dockerfile:67` (`NODE_TLS_REJECT_UNAUTHORIZED=0` on prisma generate/migrate diff)
- **Evidence:** Both dependency installs run with certificate validation off and use `npm install` (semver `^` ranges resolved at build time) rather than `npm ci`, on GitHub-hosted runners that build the prod image. `COPY package.json package-lock.json* ./` — the glob means a missing lockfile would not fail the build. The lockfile itself is healthy (1,132/1,132 entries carry integrity hashes; the single off-registry entry, the pinned SheetJS CDN tarball of `xlsx@0.20.3`, has a matching sha512), but under `npm install` with TLS off none of that is authoritative.
- **Impact:** The deployed dependency tree can drift from what tests exercised, and any on-path attacker or compromised mirror can substitute packages that then run with access to the books DB and session secrets.
- **Recommendation:** Delete the four TLS-disabling lines (gate behind a build arg if a local proxy needs them); use `npm ci` / `npm ci --omit=dev --omit=peer`; make the lockfile COPY non-optional.
- **Regression verification:** CI image build succeeds with TLS on; build fails when package.json and lockfile disagree.
- **Status:** Open — **Owner:** Unassigned

#### ASI-2-001: No CI gate — every push to main auto-deploys to prod without running tests or lint

- **Check:** Verification and test quality (cross-ref: Deployment)
- **Confidence:** High
- **Location:** `.github/workflows/deploy.yml:28-31`
- **Evidence:** The only workflow's single job runs `npm ci && npm run docs:check`, then builds/pushes the image and fires the Dockhand redeploy webhook. `test:run` and `lint` scripts exist but no workflow invokes them; the only correctness gate is the type check inside `next build`.
- **Impact:** The 4,507-test suite (which does cover lot-scrub, tax, and recurrence boundaries well) provides zero deploy protection; a change that typechecks but breaks money math ships straight to the live books.
- **Recommendation:** Add a job running `npx vitest run` and `npm run lint`, and make `build-and-push` declare `needs:` on it.
- **Regression verification:** Push a commit with a deliberately failing test; the image build must never start.
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-001: `findExchangeRate` triangulation can recurse forever; USD-path guard never rejects nested triangulation

- **Check:** Correctness
- **Confidence:** High
- **Location:** `src/lib/currency.ts:204-242` (guard bug at `:213`)
- **Evidence:** For a commodity with no direct/inverse price vs USD or EUR: `findExchangeRate(A, USD)` skips USD triangulation (target is USD), tries EUR triangulation → calls `findExchangeRate(A, EUR)`, which tries USD triangulation → calls `findExchangeRate(A, USD)` — an unbounded mutual recursion issuing DB queries, with no depth counter or visited set. Additionally, line 213 checks `source !== 'triangulated'` but actual sources are `'triangulated:USD'`/`'triangulated:EUR'`, so the USD-path guard never rejects anything (the EUR path at `:233` correctly uses `startsWith`).
- **Impact:** Any currency/commodity present with zero price rows against both USD and EUR (e.g., newly added, pre-first-sync) hangs every net-worth/dashboard/convert call that touches it and can pile up DB load until restart.
- **Recommendation:** Fix line 213 to `!source?.startsWith('triangulated')` and pass a no-triangulate/depth flag into the nested calls so a triangulation leg can never itself triangulate.
- **Regression verification:** Unit test with all price lookups mocked to null: `findExchangeRate(A, USD)` must resolve `null` within a bounded call count.
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-002: Lot summaries ignore `carried_basis` — transferred lots show inflated gains; tax-harvesting misses their losses

- **Check:** Correctness
- **Confidence:** High
- **Location:** `src/lib/lots.ts:112-138` (`computeRealizedGain`), `:234-256` (`totalCost`/`unrealizedGain`); consumers: `src/app/api/reports/tax-harvesting/route.ts:75-100`, LotViewer, `src/lib/rebalancing.ts:476-483`, `src/lib/sell-planner.ts:635-675`
- **Evidence:** Transfer-destination lots contain a $0-value in-kind transfer-in split with the true basis in the `carried_basis` slot. The scrub engine (`lot-scrub.ts:1494-1517`) and the 8949 report (`reports/capital-gains.ts:222`) correctly add carried basis into the basis pool; `lots.ts` loads `carriedBasis` (`:285`) but never uses it in the math: closed-lot realized gain = proceeds (basis missing entirely), open-lot `totalCost` ≈ $0 so unrealized gain ≈ full market value.
- **Impact:** Shares bought at $10k, transferred in-kind, now worth $8k display as +$8,000 unrealized gain instead of −$2,000; the tax-harvesting report (filters `unrealizedGain >= 0`) never surfaces the harvestable loss; rebalancing tax-cost estimates and the sell planner inherit the same error, and these surfaces contradict the (correct) 8949.
- **Recommendation:** In `getAccountLots`, add `carriedBasis` to the basis pool (`totalCost = buyCost + carriedBasis`) and make `computeRealizedGain` subtract sold shares' pro-rata carried basis, mirroring `lotToRealizedSales`.
- **Regression verification:** Fixture: $0-value buy split, `carriedBasis: 800`, sell at $1,000 → realizedGain = 200; open-lot variant → unrealizedGain = marketValue − 800.
- **Status:** Open — **Owner:** Unassigned

#### ASI-7-001: No migration tracking, and destructive data mutations run automatically on every boot with no backup gate

- **Check:** Deployment, migration, rollback readiness
- **Confidence:** High
- **Location:** `src/lib/db-init.ts:2290-2360` (positional DDL list), `:2654-2668` (`DELETE FROM prices` dedupe), `:579-621` (`DELETE FROM gnucash_web_tool_config` every boot), `:2774-2777`, `:1076-1078`, `:2501-2523` (`DROP INDEX splits_account_guid_index`, `slots_guid_index` — native GnuCash indexes)
- **Evidence:** `initializeDatabase()` re-executes ~90 positional DDL/data statements on every app and worker start (under an advisory lock), with no `schema_migrations`-style applied-version record. Several statements delete or mutate rows; nothing takes a backup first (the nightly BullMQ backup job is unrelated to init timing). A code comment at `:2362-2372` documents a prior incident where a mid-list failure aborted the remainder. The comment at `:2489-2490` assumes desktop GnuCash never opens these books — contradicted by project context — while dropping GnuCash's native indexes.
- **Impact:** Deploying a new image mutates prod data before any human confirms; a bug in, e.g., the price-dedupe ranking deletes the wrong rows permanently with only a nightly logical backup as recovery; "which schema state is prod in" is unanswerable without inspecting the live DB.
- **Recommendation:** Add a `gnucash_web_schema_meta(step_name, applied_at)` table and skip applied one-shot backfills; before any `DELETE`/`DROP CONSTRAINT`, snapshot doomed rows to a `gnucash_web_migration_backup_*` table or gate behind `DB_INIT_ALLOW_DESTRUCTIVE=1`; resolve the desktop-GnuCash assumption explicitly.
- **Regression verification:** Boot twice against a prod copy; second boot logs zero data-mutating statements. Seed duplicate prices; the deleted rows appear in the backup table.
- **Status:** Open — **Owner:** Unassigned

#### ASI-7-002: Rollback is manual, undocumented, and defeated by `:latest` + `pull_policy: always`

- **Check:** Deployment, migration, rollback readiness
- **Confidence:** High
- **Location:** `.github/workflows/deploy.yml:48-50` (tags: `latest` + SHA), `docker-compose.prod.yml:25,68`
- **Evidence:** SHA tags exist, but the running stack references `:latest` with `pull_policy: always`, so any container restart after a "rollback" re-pulls the bad image unless the stack file is hand-edited; no runbook exists in the repo (the deploy design doc explicitly notes "No automated rollback"). Schema is forward-only: old images cannot recreate dropped native indexes or reverse data migrations (tags book-scope cloning, tool_config promotion).
- **Impact:** During an incident the operator must reverse-engineer the previous SHA and edit the Dockhand stack under pressure, while restarts keep re-pulling the broken image; if the bad version migrated data there is no down path.
- **Recommendation:** Write a 5-line rollback runbook (previous-SHA lookup + Dockhand pin); optionally push a `stable` tag only after a post-deploy health probe.
- **Regression verification:** Dry-run the runbook on the dev stack: pin previous SHA, restart, confirm the pinned version keeps serving.
- **Status:** Open — **Owner:** Unassigned

#### ASI-4-001: `scripts/jh-401k-separate.mjs` writes to the target DB by default; dry-run is opt-in; no transaction

- **Check:** Filesystem, network, and customer-environment safety
- **Confidence:** High
- **Location:** `scripts/jh-401k-separate.mjs:14-15` (`argv[2]` connection string, `--dry` opt-in), `:98`, `:114-128` (UPDATE accounts / DELETE FROM prices / INSERT loop, unwrapped)
- **Evidence:** This inverts the convention of every other repair script in the repo (`repair-transfer-lot-gains.mjs`, `cleanup-orphaned-slots.ts`, `sweep-lot-gains.ts` are all default-dry with `--apply`). The connection string is taken from argv (lands in shell history with password), no target-DB banner is printed, and the commodity re-point + price delete + insert sequence is not wrapped in a transaction — a Ctrl-C mid-run leaves the 401k account pointed at a commodity with no prices.
- **Impact:** Muscle memory from the other scripts ("run bare to preview") executes writes immediately against whatever DB was pasted — including prod (`truenas:5438`). Project memory records a prior prod data-repair incident from adjacent tooling.
- **Recommendation:** Flip to default-dry `--apply`, read `DATABASE_URL`, print host/database before acting, wrap mutations in `BEGIN/COMMIT`.
- **Regression verification:** Running bare against dev prints a plan and exits with zero writes.
- **Status:** Resolved 2026-08-05 — one-off script already served its purpose; retired from tracking (commit f4facea) — **Owner:** Unassigned

### Medium

#### ASI-1-003: Wash-sale detection ignores carried basis and reuses replacement shares across multiple sells

- **Check:** Correctness — **Confidence:** High
- **Location:** `src/lib/lot-assignment.ts:1147-1162`, `:1189-1231`
- **Evidence:** The loss test uses the same carried-basis-blind gain math as ASI-1-002, so losses on transferred lots are never detected as losses (no wash-sale flag, no 8949 column-g adjustment); and each loss-sell matches replacement buys without consuming them, so one replacement purchase can wash multiple sales (overstating disallowed losses).
- **Recommendation:** Reuse the carried-basis-aware gain from ASI-1-002's fix; track and decrement remaining replacement shares per buy.
- **Regression verification:** Transfer-lot loss + 30-day repurchase → WashSaleResult present; two loss sells + one small buy → total disallowed ≤ loss attributable to the buy's shares.
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-004: "Average" cost-basis method silently books FIFO capital gains

- **Check:** Correctness — **Confidence:** High
- **Location:** `src/lib/lot-assignment.ts:411-419`
- **Evidence:** `assignAverage` is `return assignFIFO(...)`; the comment claims the difference is display-only, but `generateCapitalGains` persists real per-lot FIFO gains transactions into the book while echoing `method: 'average'` back.
- **Impact:** Mutual-fund holders electing average cost get FIFO-dollar realized-gain history and 8949 rows, unlabeled.
- **Recommendation:** Implement average-cost allocation, or return a warning in `AutoAssignResult.warnings` and label the method `'fifo (average not implemented)'`.
- **Regression verification:** Two buys at $10/$20, sell half under 'average' → $15/share basis (or interim: warning present).
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-005: Monthly schedules with "forward" weekend adjustment skip a month after a cross-month adjustment

- **Check:** Correctness — **Confidence:** High
- **Location:** `src/lib/recurrence.ts:307-330`
- **Evidence:** `computeFirstAfterLast` advances from the weekend-*adjusted* `lastOccur`. Monthly-on-the-30th with forward adjust: Sat May 30 2026 → executes Mon Jun 1; next = month(Jun)+1 = Jul 30, silently skipping Jun 30.
- **Impact:** Rent/mortgage-style schedules on the 29th–31st drop an occurrence whenever month-end lands on a weekend — missing bill in execution, forecast, and iCal.
- **Recommendation:** Advance from the raw (unadjusted) occurrence when computing the next month.
- **Regression verification:** `lastOccur = Jun 1 2026` (from adjusted May 30) with monthly/forward → next must be Jun 30, not Jul 30.
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-006: Composite GnuCash recurrences collapsed to one row; `semi_monthly` hardcodes 1st/15th and ignores `mult`

- **Check:** Correctness — **Confidence:** High
- **Location:** `src/lib/scheduled-transactions.ts:240`; `src/lib/recurrence.ts:180-199`, `:332-342`
- **Evidence:** `new Map(recurrenceList.map(r => [r.obj_guid, r]))` keeps only the last recurrence row per SX, but desktop GnuCash stores semi-monthly/composite schedules as multiple rows — all but one are dropped. The app's own `semi_monthly` generator always yields the 1st and 15th regardless of `periodStart`, and its advance ignores `mult`.
- **Impact:** Desktop-created semi-monthly SXs compute as plain monthly (half the occurrences); user-chosen 5th/20th patterns render as 1st/15th.
- **Recommendation:** Group recurrence rows by `obj_guid` and union their date streams; derive anchor days from the rows/`periodStart`.
- **Regression verification:** SX fixture with day-1 and day-15 rows honors both; `semi_monthly` anchored on the 5th never yields the 1st.
- **Status:** Open — **Owner:** Unassigned

#### ASI-2-002: E2E suite is dead scaffolding — undiscoverable specs, wrong server target, data-dependent skips

- **Check:** Verification and test quality — **Confidence:** High
- **Location:** `playwright.config.ts:4` (`testDir: './tests/e2e'`), `tests/test-reports.spec.ts` / `tests/test-investment-charts.spec.ts` (outside testDir, never discovered — and carrying ASI-3-001's credentials), `tests/e2e/review-mode.spec.ts:3` (hardcodes `localhost:3000` while the config boots `127.0.0.1:3010`), `:234-541` (10 conditional `test.skip()` calls dependent on personal-ledger state)
- **Impact:** The e2e layer cannot run green from a clean checkout and is not in CI — illusion of coverage.
- **Recommendation:** Delete/quarantine the two root-level specs; use config `baseURL` and seeded data (demo-seed machinery exists); decide CI vs documented-manual.
- **Regression verification:** `npx playwright test --list` shows only intended specs; suite passes from a clean checkout.
- **Status:** Open — **Owner:** Unassigned

#### ASI-2-003: `findExchangeRate`/`convertAmount` have zero unit tests; every consumer mocks them

- **Check:** Verification and test quality — **Confidence:** High
- **Location:** `src/lib/currency.ts:134`, `:250`; sole test reference is a `vi.fn()` stub in `src/lib/services/__tests__/financial-summary.service.test.ts:27`
- **Evidence:** No test exercises direct/inverse/triangulation rate lookup — which is exactly where ASI-1-001 lives undetected.
- **Recommendation:** Unit-test with mocked price rows: direct, inverse, triangulated, no-rate, stale-date selection — and the ASI-1-001 recursion bound.
- **Status:** Open — **Owner:** Unassigned

#### ASI-3-003: OIDC login auto-provisions any IdP identity with readonly access to every book

- **Check:** Security — **Confidence:** High (behavior); Medium (exploitability, depends on IdP)
- **Location:** `src/app/api/auth/oidc/callback/route.ts:284-310`
- **Evidence:** Password registration is gated (`ALLOW_REGISTRATION`, invitation-only book access), but the OIDC `create` case unconditionally creates a local user for any authenticated IdP identity and grants readonly on all books — no registration gate, allowlist, or approval.
- **Impact:** With a permissive/public IdP, any authenticated stranger reads every financial book. Low practical risk with a household-only IdP, hence Medium.
- **Recommendation:** Apply the same registration gate to OIDC creation and require invitation for book roles (or an email/domain allowlist env).
- **Regression verification:** Callback test: `create` action with `ALLOW_REGISTRATION` unset must not create a user or call `grantRole`.
- **Status:** Open — **Owner:** Unassigned

#### ASI-3-004: AI "Ask your books" SQL guardrail checks for one `$1` binding, not per-table scoping

- **Check:** Security (AI module) — **Confidence:** Medium
- **Location:** `src/lib/ai-query/guardrails.ts:115-119`, `:211-219`; executed by `src/lib/ai-query/execute.ts:47-67`
- **Evidence:** Validation passes any single read-only SELECT over allowlisted tables containing *one* `ANY($1)` binding anywhere — e.g. `SELECT t.description FROM transactions t, splits s WHERE s.account_guid = ANY($1)` passes with `transactions` unscoped, exposing rows from all books. Read-only 5s-timeout transaction limits this to disclosure.
- **Impact:** A user with a role on one book can steer generated SQL into reading transaction/account text from books they were never granted.
- **Recommendation:** Require every scoped relation in FROM/JOIN position to be individually bound to `$1` (or joined into the bound set).
- **Regression verification:** Guardrail unit tests: unscoped two-table example rejected; properly-joined form accepted.
- **Status:** Resolved 2026-08-06 — but note the first fix FAILED and briefly made this worse. The 2026-08-05 attempt implemented the recommendation above (one binding per alias, still substring matching); a validation pass executed candidate payloads against it and found five surviving bypasses, two of which reached arbitrary tables (`gnucash_web_users` password hashes, TOTP secrets) rather than merely other books: a comma join trailing a `JOIN … ON` clause, and a double-quoted relation name invisible to the bare-word scanner. `OR TRUE` / `NOT (…)` and UNION-branch alias reuse defeated the predicate check. The recommendation itself was the problem — deciding whether a model-supplied predicate constrains a query requires understanding boolean position, UNION branches, and alias shadowing, which substring matching cannot do. Rewritten instead so scoping is enforced BY CONSTRUCTION: the model may only name `book_*` CTEs that `guardrails.ts` defines itself with `$1` bound, base table names are refused, and scanning runs over a real tokenizer that rejects quoted identifiers and comma joins outright. All 20 attack payloads now blocked, 8 legitimate query shapes still accepted — **Owner:** Unassigned

#### ASI-3-005: Dependency vulnerabilities — 28 advisories including an unfixable critical in `node-tesseract-ocr`

- **Check:** Security (supply chain) — **Confidence:** High (tool-reported, 2026-08-04)
- **Location:** `package-lock.json` (`npm audit`, 2026-08-04)
- **Evidence:** 1 critical: `node-tesseract-ocr` OS command injection via `recognize()` parameters (GHSA-8j44-735h-w4w2, **no fix available**) — mitigated in code: `src/lib/queue/jobs/ocr-receipt.ts` and `payslip-extraction.ts` pass only server-generated temp paths and constant configs. 15 high incl. `next` 16.1.1 (DoS/request-smuggling/CSRF-bypass advisories, fix = 16.3.0), `sharp` <0.35 (libvips CVEs), `axios`, `postcss`, `vite`, `ws`; 10 moderate; 2 low.
- **Recommendation:** `npm audit fix` for the non-breaking set; plan the `next` 16.3 and `sharp` 0.35 upgrades; replace `node-tesseract-ocr` (e.g., call `tesseract` via `execFile` directly, or use the already-present `tesseract.js`) since no patched version exists.
- **Regression verification:** `npm audit` critical/high count drops; OCR jobs still pass tests.
- **Status:** Open — **Owner:** Unassigned

#### ASI-3-006: CI actions float on major tags; PAT used where `GITHUB_TOKEN` suffices; unauthenticated deploy webhook committed

- **Check:** Security (supply chain) — **Confidence:** High
- **Location:** `.github/workflows/deploy.yml:20,23,34,37,45,53` (tag-pinned actions), `:41` (`secrets.CR_PAT`), `:62-64` (webhook, `continue-on-error` + `|| echo`)
- **Evidence:** All six actions pinned to floating major tags (the 2025 `tj-actions` compromise is the reference scenario); the job already has `packages: write` so the ephemeral `GITHUB_TOKEN` would replace the long-lived PAT; the Dockhand webhook URL is committed with no auth token, and its failure can never fail the job.
- **Recommendation:** Pin actions to full SHAs (Dependabot for bumps); switch to `GITHUB_TOKEN` and revoke the PAT; put a webhook secret in GH secrets and fail the step on non-2xx (`curl -fsS`).
- **Status:** Open — **Owner:** Unassigned

#### ASI-4-002: Repair scripts have five different dry-run conventions and none prints its target database

- **Check:** Environment safety — **Confidence:** High
- **Location:** `scripts/` — `--apply` opt-in (`repair-transfer-lot-gains.mjs:32`, `cleanup-orphaned-slots.ts:41`, `sweep-lot-gains.ts:29`), `--execute` opt-in (`fix-lot-scrub-sign-corruption.ts:29`), `--dry` opt-out (`jh-401k-separate.mjs:15`), `--dry-run` opt-out (`backfill-tax-year.ts:55`), none (`crypto-backfill.mjs`, `create-lotus-bud-book.ts`, `utilities/run-price-audit.ts`)
- **Evidence:** Several load `.env.local` silently, so the target depends on invisible file state; dev and prod differ only by host/port. Prior prod data-repair incident on record (2026-07-30).
- **Recommendation:** Shared `printDbBanner()` helper that logs host:port/dbname and requires `--yes-prod` (or interactive confirm) when the target matches prod; standardize on default-dry `--apply`.
- **Regression verification:** Every script run bare prints host/db + "dry-run" before any query.
- **Status:** Resolved 2026-08-05 — repair scripts done and retired from tracking (commit f4facea); adopt the convention for any future repair script — **Owner:** Unassigned

#### ASI-4-003: Default compose stores receipts in container-local storage — lost on recreate and invisible to the OCR worker

- **Check:** Environment safety — **Confidence:** High
- **Location:** `docker-compose.yml:39,64` (`RECEIPT_STORAGE=filesystem`, no volume for `/app/data/receipts`); `src/lib/storage/filesystem-storage.ts:5`
- **Evidence:** App and worker are separate containers with separate writable layers: the worker's `storage.get()` reads a filesystem where the app's upload never existed, so OCR fails for every receipt under the compose default; any `compose down`/image update deletes all uploaded documents while DB rows still reference them. Prod compose defaults to `s3` — mitigated there.
- **Recommendation:** Add a shared named volume `receipts-data:/app/data/receipts` to both services, or flip the dev default to `s3` (MinIO is already in the stack).
- **Regression verification:** Upload → OCR completes; `compose down && up` → file still serves.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-001: BullMQ `Worker` has no `error` listener and the process has no `unhandledRejection` backstop

- **Check:** Reliability — **Confidence:** Medium-High
- **Location:** `worker.ts:392-678` (only `completed`/`failed` listeners registered)
- **Evidence:** BullMQ's Worker emits `error` on Redis connection failures; an unlistened `error` event is a Node uncaught exception. Every other connection owner in the codebase has a listener (`db.ts:20`, `prisma.ts:34`, `redis.ts:31`) — this is the one omission. No `process.on('unhandledRejection'|'uncaughtException')` anywhere.
- **Impact:** A Redis restart can kill the worker mid-job, taking all interval timers (SimpleFin sync, email ingest, backups) down until the supervisor restarts it.
- **Recommendation:** One-line `worker.on('error', ...)`; add an `unhandledRejection` logger as a backstop.
- **Regression verification:** Stop Redis while the worker idles; it logs and reconnects instead of exiting.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-002: Backup-schedule callback can reject outside its try/catch — unhandled rejection plus silent end of the schedule chain

- **Check:** Reliability — **Confidence:** High
- **Location:** `worker.ts:702-704` (DB calls before the try block), `worker.ts:291-294` (`setScheduleGeneric` runs `await callback(); scheduleNext()` unguarded)
- **Impact:** One transient DB error at backup time is fatal by default (no rejection handler) — and even if survived, `scheduleNext()` never runs, so scheduled backups silently stop until worker restart.
- **Recommendation:** Wrap `await callback()` in try/catch inside `setScheduleGeneric` so no daily schedule can kill its own chain.
- **Regression verification:** Fake-timer unit test: rejecting callback still schedules the next run.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-003: A ~4-second Redis outage permanently disables Redis for the web process

- **Check:** Reliability — **Confidence:** High
- **Location:** `src/lib/redis.ts:14,22-28,45`
- **Evidence:** `retryStrategy` latches `connectionFailed = true` after 3 attempts; `getRedis()` and `getBullMQConnection()` then return `null` forever. `queues.ts:138` resets the queue object but the latch means no new connection is ever created.
- **Impact:** After any brief Redis restart, the web app silently loses job enqueueing, dashboard caches, data-change events, and progress streaming until the *app* container is restarted; the worker is unaffected, making it confusing to diagnose.
- **Recommendation:** Replace the permanent latch with a cooldown (retry after 30–60 s), or let ioredis retry forever with capped backoff as `data-events-subscriber.ts:110-113` already does.
- **Regression verification:** Bounce Redis 1 min; an enqueue afterwards succeeds without app restart.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-004: Worker ignores the Redis `db` index that the web enqueue side honors

- **Check:** Reliability — **Confidence:** High
- **Location:** `worker.ts:367-372` (`{host, port, password}` only) vs `src/lib/redis.ts:44-58` (parses `/db` path)
- **Impact:** `REDIS_URL=redis://host:6379/1` → web enqueues into db 1, worker listens on db 0; every queued job waits forever with no error. Latent (zero-impact if prod URL has no db path).
- **Recommendation:** Have `worker.ts` use `getBullMQConnection()` (or copy the `db` field).
- **Regression verification:** Dev with `/1` URL: manual price refresh gets picked up.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-005: SimpleFin sync advances `last_sync_at` past failed transaction imports — rows older than the 7-day overlap are dropped forever

- **Check:** Reliability — **Confidence:** Medium-High
- **Location:** `src/lib/services/simplefin-sync.service.ts:529-543` (per-txn catch continues), `:546-562` (cursor set to `now` unconditionally), `:118-129` (`computeSyncStart` = cursor − 7d)
- **Impact:** During a 90-day bootstrap or wide window, transiently-failed imports of older transactions are never re-fetched; books are silently short with only a warning notification.
- **Recommendation:** When an account has import errors, don't advance its `last_sync_at` past the earliest failed transaction's post date.
- **Regression verification:** Unit test: one import throw mid-loop → cursor does not advance past the failed row's date.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-006: Email ingest can double-process messages — dedup key recorded only after processing, and polls can overlap

- **Check:** Reliability — **Confidence:** Medium
- **Location:** `worker.ts:745-746` (15-min interval, no in-flight guard), `worker.ts:573-577` (queued job, concurrency 3); `src/lib/email-ingest.ts:660-674` vs `:755-763` (check-then-act)
- **Impact:** A slow poll overlapping the next tick (or a user-triggered job) ingests the same attachments twice — duplicate documents/receipts, duplicate draft bills.
- **Recommendation:** Claim the key before ingesting (`INSERT ... ON CONFLICT DO NOTHING RETURNING`) and add an in-flight guard mirroring the SimpleFin pattern (`simplefinSyncInFlight`, worker.ts:84).
- **Regression verification:** Two concurrent `pollEmailIngest` runs against the same message → single ingestion.
- **Status:** Open — **Owner:** Unassigned

#### ASI-6-001: Capital-gains/tax surfaces run ~8 sequential queries per investment account (N+1)

- **Check:** Performance — **Confidence:** High
- **Location:** `src/lib/reports/capital-gains.ts:594-605` (per-account `getAccountLots`); `src/lib/lots.ts:144-213` (four separate `slots` queries differing only in `name`, plus lots/account/price queries)
- **Impact:** ~30 investment accounts → ~240 sequential round trips per capital-gains/8949 load.
- **Recommendation:** Merge the four slot queries via `name: { in: [...] }`; add a batch `getLotsForAccounts(guids[])` for `loadRealizedSales`.
- **Regression verification:** `DEBUG=prisma:query` count while loading the report: ~8N before, ~5 after.
- **Status:** Open — **Owner:** Unassigned

#### ASI-6-002: Investment-account ledger recomputes full cost-basis history on every infinite-scroll page

- **Check:** Performance — **Confidence:** High
- **Location:** `src/app/api/accounts/[guid]/transactions/route.ts:145-272`
- **Evidence:** The running share/cost-basis block loads all splits + sibling splits and replays the whole history (including `traceCostBasis` per transfer-in) regardless of `offset`; the memo cache is per-request.
- **Recommendation:** Cache `investmentRunningTotals` in Redis keyed by account+range+method, invalidated by the existing `transactions` data-change events.
- **Regression verification:** `offset=0` vs `offset=400` latency — currently near-identical.
- **Status:** Open — **Owner:** Unassigned

#### ASI-6-003: Price backfill does a per-row USD lookup plus per-row INSERT

- **Check:** Performance — **Confidence:** High
- **Location:** `src/lib/yahoo-price-service.ts:455-499` (`storeFetchedPrice`: `getCurrencyByMnemonic('USD')` DB query + single-row insert per price), called from per-row loops at `:313-323`, `:558-622`, `:701-714`
- **Impact:** A full 10-year audit/backfill (~50k rows) issues ~100k sequential queries. The routine 2h incremental path is fine.
- **Recommendation:** Hoist the USD lookup per run; chunk inserts into multi-row `INSERT ... ON CONFLICT` (~500 rows), preserving the existing conflict guard.
- **Status:** Open — **Owner:** Unassigned

#### ASI-7-003: Missing env vars produce either a misleading crash loop or a healthy-looking broken app

- **Check:** Deployment — **Confidence:** High
- **Location:** `src/lib/db.ts:3-13` (no `DATABASE_URL` validation → libpq defaults to localhost), `src/lib/session-config.ts:16-31` (secret resolved lazily per request), `worker.ts:361-365` (validates only `REDIS_URL`), `docker-entrypoint.sh:13-16`
- **Evidence:** Unset `DATABASE_URL` → `ECONNREFUSED 127.0.0.1:5432` crash loop that never names the variable. Unset secrets → db-init succeeds, container stays up, traffic routes, and every session read 500s at request time; worker starts and fails each credential-touching job (matches the prior prod incident in project memory).
- **Recommendation:** In `db-init-entrypoint.ts` (first code in every container), assert `DATABASE_URL` and a ≥32-char `SESSION_SECRET || NEXTAUTH_SECRET`, exiting with a named error.
- **Regression verification:** `docker run` with each var removed; log names the missing variable.
- **Status:** Open — **Owner:** Unassigned

#### ASI-7-004: No health checks in the prod path; deploy webhook failure can never fail the pipeline

- **Check:** Deployment — **Confidence:** High
- **Location:** `Dockerfile` (no HEALTHCHECK), `docker-compose.prod.yml:24-95` (no healthcheck on app or worker; dev compose has a worker one), `.github/workflows/deploy.yml:62-64` (`continue-on-error: true` plus `|| echo`)
- **Impact:** A failed db-init crash-loops with no health signal; a misconfigured Dockhand webhook keeps GH Actions green while prod silently runs old code.
- **Recommendation:** Add `HEALTHCHECK` hitting `/api/health` (worker: `WORKER_HEALTH_PORT`, which already exists — `worker.ts:374,849`); drop `|| echo` and use `curl -fsS`.
- **Status:** Open — **Owner:** Unassigned

### Low

#### ASI-1-007: Mortgage `detectOriginalAmount` fallback double-counts the loan

- **Check:** Correctness — **Confidence:** Medium-High
- **Location:** `src/lib/services/mortgage.service.ts:192-197`
- **Evidence:** Fallback sums `|value|` over all splits — opening credit plus paydowns ≈ 2× original on a mostly-paid mortgage — then feeds rate/payment detection.
- **Recommendation:** Use `|Σ signed values|` or max single |split| in the fallback.
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-008: `calculateAge` mixes UTC parsing with local getters — Dec 31 birthdays can lose catch-up eligibility

- **Check:** Correctness — **Confidence:** High
- **Location:** `src/lib/reports/irs-limits.ts:101-112`, `:165`
- **Recommendation:** Use UTC getters throughout (or construct with local components).
- **Regression verification:** Birthday 1975-12-31, taxYear 2025, `TZ=America/New_York` → age 50.
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-009: No staleness bound or warning on price lookups used for FX and trade valuation

- **Check:** Correctness — **Confidence:** High
- **Location:** `src/lib/currency.ts:156-201`; `src/lib/lot-scrub.ts:1053-1082` (`lookupPriceOn`, which can *write* the stale value into zero-value trade legs)
- **Recommendation:** Surface the price date in warnings when older than a threshold relative to `asOfDate`.
- **Status:** Open — **Owner:** Unassigned

#### ASI-1-010: Balance-sheet `grandTotal` "should be 0" is only true for closed books

- **Check:** Correctness — **Confidence:** Medium
- **Location:** `src/lib/reports/balance-sheet.ts:132`
- **Evidence:** A − L − E(equity-type only) = retained earnings ≠ 0 on any book with un-closed income/expense activity; sign handling itself is correct.
- **Recommendation:** Add a computed retained-earnings line to Equity, or rename the field.
- **Status:** Open — **Owner:** Unassigned

#### ASI-2-004: No SQL is exercised by any test; DDL tests assert substring presence only

- **Check:** Verification — **Confidence:** High
- **Location:** 123 files `vi.mock` prisma; `src/lib/__tests__/db-init.test.ts:43-187`
- **Recommendation:** One env-gated (`TEST_DATABASE_URL`) integration suite running `initializeDatabase()` + a representative report query against throwaway Postgres.
- **Status:** Open — **Owner:** Unassigned

#### ASI-2-005: ~21 test files use the real clock — residual midnight/month-rollover flake risk only

- **Check:** Verification — **Confidence:** Medium
- **Evidence:** Sampled usage is benign (fixture timestamps, same-clock expectations, e.g. `digest.test.ts:96-99`); all date-boundary financial assertions use pinned dates.
- **Recommendation:** Optional `vi.setSystemTime` in "today"-relative tests.
- **Status:** Open — **Owner:** Unassigned

#### ASI-3-007: Outbound webhook URL validation does not resolve DNS; no delivery-time re-check

- **Check:** Security — **Confidence:** High
- **Location:** `src/lib/webhooks.ts:97-131`, delivery `:313-328`
- **Evidence:** Literal private/loopback/metadata hosts are blocked and redirects refused, but a public DNS name resolving to a private IP passes (the code's own comment says so).
- **Recommendation:** Resolve at delivery time and re-apply the private-host patterns unless `allowInternal`.
- **Status:** Open — **Owner:** Unassigned

#### ASI-3-008: No security response headers (CSP, X-Frame-Options, HSTS, nosniff)

- **Check:** Security — **Confidence:** High
- **Location:** `next.config.js:1-11` (no `headers()`)
- **Recommendation:** Add a baseline `headers()` block; session cookies are already well configured.
- **Status:** Open — **Owner:** Unassigned

#### ASI-3-009: Weak default credentials in prod compose fallbacks

- **Check:** Security — **Confidence:** High
- **Location:** `docker-compose.prod.yml:30,100-103` (`POSTGRES_PASSWORD:-gnucash`, host-exposed port), `:128-129` (`minioadmin` fallbacks)
- **Impact:** An incomplete `.env` silently runs the household's financial DB and object store on defaults.
- **Recommendation:** Remove the fallbacks so compose fails fast when the vars are unset.
- **Status:** Open — **Owner:** Unassigned

#### ASI-4-004: `backfill-tax-year.ts` applies by default (`--dry-run` opt-in)

- **Check:** Environment safety — **Confidence:** High
- **Location:** `scripts/backfill-tax-year.ts:55`, writes `:152-156`
- **Evidence:** Mitigated — writes are additive `ON CONFLICT DO NOTHING` into an app override table, reversible. Same inverted-default pattern as ASI-4-001.
- **Recommendation:** Flip to `--apply` for consistency (covered by ASI-4-002's standardization).
- **Status:** Resolved 2026-08-05 — script done and retired from tracking (commit f4facea) — **Owner:** Unassigned

#### ASI-4-005: `fix-lot-scrub-sign-corruption.ts` backup precondition is a comment, not a step

- **Check:** Environment safety — **Confidence:** High
- **Location:** `scripts/fix-lot-scrub-sign-corruption.ts:20-22`, execute path `:108-130` (per-book revert+re-scrub, no wrapping transaction)
- **Recommendation:** Check for (or take) a `backup_*` schema before `--execute`; abort if absent.
- **Status:** Resolved 2026-08-05 — script done and retired from tracking (commit f4facea) — **Owner:** Unassigned

#### ASI-4-006: Gzip decompression bomb in GnuCash XML import (admin-only)

- **Check:** Environment safety — **Confidence:** High
- **Location:** `src/app/api/import/route.ts:50` (100MB cap on compressed input), `src/lib/gnucash-xml/parser.ts:86` (`gunzipSync` with no output cap)
- **Impact:** Self-inflicted OOM only (route requires admin).
- **Recommendation:** Stream with fflate's `Gunzip` and abort past a sane cap.
- **Status:** Open — **Owner:** Unassigned

#### ASI-4-007: No container log rotation configured; `data/` not in `.dockerignore`

- **Check:** Environment safety — **Confidence:** High (repo side); prod daemon config unverifiable
- **Location:** both compose files (no `logging:` blocks); `.dockerignore` (excludes `.env*` but not `data/`, which can contain prod CSV exports on local builds)
- **Recommendation:** Add `logging: {options: {max-size: "10m", max-file: "3"}}`; add `data/` to `.dockerignore`.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-007: Email-ingest errors permanently poison the message with no user-visible signal

- **Check:** Reliability — **Confidence:** High
- **Location:** `src/lib/email-ingest.ts:783-795` (error outcome recorded → skipped forever), `:759-767` (zero-item failures never notify)
- **Recommendation:** Don't record the dedup key on exception (retry next poll); notify when `ingestedItems.length === 0`.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-008: Webhook idempotency claim wedges forever if the process dies between claim and complete

- **Check:** Reliability — **Confidence:** High
- **Location:** `src/lib/webhook-idempotency.ts` (no expiry); `src/app/api/webhooks/inbound/transaction/route.ts:116-130`
- **Impact:** Crash mid-handler → retries get 409 "in progress" indefinitely, possibly with the ledger write never having landed.
- **Recommendation:** Treat unfinished claims older than ~10 min as reclaimable.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-009: SimpleFin get-or-create helpers are check-then-act with no unique constraint; Imbalance lookup unscoped to book

- **Check:** Reliability — **Confidence:** Medium
- **Location:** `src/lib/services/simplefin-sync.service.ts:1150-1321` (`findFirst` → `create`; `:1157` `findFirst({ name })` unscoped)
- **Recommendation:** Reuse the XML importer's named-advisory-lock pattern (`gnucash-xml/importer.ts:276-333`) with post-lock re-check; scope the Imbalance lookup to the book.
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-010: OCR temp-file name can collide under worker concurrency 3

- **Check:** Reliability — **Confidence:** High
- **Location:** `src/lib/queue/jobs/ocr-receipt.ts:76` (`receipt-ocr-${Date.now()}.png`, concurrency 3 at `worker.ts:668`)
- **Impact:** Same-millisecond jobs cross-attach OCR text between receipts.
- **Recommendation:** Include `receiptId`/UUID in the name (or `mkdtemp` as `thumbnail.ts:56` already does).
- **Status:** Open — **Owner:** Unassigned

#### ASI-5-011: Price-refresh schedules collapse to `books.findFirst()`; malformed `refresh_time` causes a hot loop

- **Check:** Reliability — **Confidence:** High / Medium (hot loop)
- **Location:** `worker.ts:341-348`; `worker.ts:244-256` (`setTimeout(NaN)` fires immediately → continuous refresh loop against Yahoo)
- **Recommendation:** Validate `refresh_time` against `/^\d{1,2}:\d{2}$/` with a fallback; schedule per accessible book.
- **Status:** Open — **Owner:** Unassigned

#### ASI-6-004: SimpleFin sync reloads the entire simplefin-id meta table once per mapped account

- **Check:** Performance — **Confidence:** High
- **Location:** `src/lib/services/simplefin-sync.service.ts:397-413` (unfiltered `findMany` inside the per-account loop at `:358`)
- **Recommendation:** Hoist the query and `existingIds` set above the loop.
- **Status:** Open — **Owner:** Unassigned

#### ASI-6-005: Amount/reconcile filters applied after pagination; general-ledger variant may not apply them at all

- **Check:** Performance (correctness cross-ref) — **Confidence:** High (per-account), Medium (journal)
- **Location:** `src/app/api/accounts/[guid]/transactions/route.ts:498-508` (filter after `take/skip` at `:355-356`); `src/app/api/transactions/route.ts:175-179` (comment acknowledges filters, application not found)
- **Impact:** Selective filters degrade to a client-driven full-ledger scan (compounding ASI-6-002 on investment accounts); the journal variant needs a correctness check that the filters do anything.
- **Recommendation:** Push both filters into SQL (grouped `HAVING` on per-tx account sum; `reconcile_state` is a direct column).
- **Status:** Open — **Owner:** Unassigned

#### ASI-6-006: Ledger components render every loaded row; `@tanstack/react-virtual` is a dead dependency

- **Check:** Performance — **Confidence:** High
- **Location:** `src/components/TransactionJournal.tsx:724,780`, `src/components/AccountLedger.tsx:2497,2718` (full-array `.map()`); `package.json` declares the virtualizer, zero imports repo-wide
- **Recommendation:** Wire up the installed virtualizer in these two components, or remove the dependency.
- **Status:** Open — **Owner:** Unassigned

#### ASI-6-007: Dashboard aggregates computed in JS over all splits; every transactions event invalidates the whole book's cache; index zsets never expire

- **Check:** Performance — **Confidence:** High
- **Location:** `src/app/api/dashboard/income-expense/route.ts:138-194`, `src/app/api/dashboard/sankey/route.ts:171-202`, `src/lib/services/financial-summary.service.ts:159-192`; `src/lib/data-events-subscriber.ts:81-83` (`cacheInvalidateAllForBook` per event); `src/lib/cache.ts:40` (idx zadd without TTL)
- **Evidence:** Normally hidden by the 24h cache, exposed during editing sessions and right after each 2h sync (cold fill of 5+ widgets). Key discipline itself is good — every dashboard key ends with the date range.
- **Recommendation:** Convert sankey + income-expense to SQL `GROUP BY`; debounce invalidation (~2s coalescing); `EXPIRE` idx keys on zadd.
- **Status:** Open — **Owner:** Unassigned

#### ASI-7-005: Worker shutdown doesn't drain interval jobs; 10s SIGTERM grace can kill 5-minute jobs

- **Check:** Deployment — **Confidence:** Medium
- **Location:** `docker-compose.prod.yml:25,68` (no `stop_grace_period`), `worker.ts:851-863` (shutdown clears book schedules but not `simplefinTimers`/in-flight interval jobs)
- **Recommendation:** `stop_grace_period: 5m` on the worker; clear all timers and await in-flight timer jobs in `shutdown()`.
- **Status:** Open — **Owner:** Unassigned

#### ASI-7-006: Prisma schema ↔ db-init drift (~19 tables) and a stale `sql/001` mirror

- **Check:** Deployment — **Confidence:** High
- **Location:** `prisma/schema.prisma` vs `src/lib/db-init.ts` + `src/lib/{financial-actions,planning,documents}/schema.ts` (19 `gnucash_web_*` tables absent from Prisma); `sql/001-performance-indexes.sql` missing three indexes db-init creates
- **Impact:** Fresh installs depend on db-init running immediately after bootstrap; adding a Prisma accessor for a raw-SQL table fails at runtime; the drift widens each release with nothing checking it.
- **Recommendation:** CI assertion diffing the two sources; update or delete `sql/001`.
- **Status:** Open — **Owner:** Unassigned

#### ASI-7-007: Fresh-install bootstrap race between app and worker containers

- **Check:** Deployment — **Confidence:** High
- **Location:** `scripts/db-init-entrypoint.ts:15-35` (`bootstrapIfEmpty` checks outside the advisory lock)
- **Impact:** Cosmetic crash-loop on first boot only (loser fails on duplicate objects, restarts, converges).
- **Recommendation:** Take `withDatabaseAdvisoryLock` around `bootstrapIfEmpty` with an inside re-check.
- **Status:** Open — **Owner:** Unassigned

#### ASI-8-001: db-init comment asserts the app exclusively owns the database, contradicting actual deployment context

- **Check:** Maintainability — **Confidence:** High
- **Location:** `src/lib/db-init.ts:2489-2490`
- **Evidence:** "this app owns its databases (books are not opened by GnuCash desktop)" — project context says desktop GnuCash also uses the prod DB. This comment justified dropping native GnuCash indexes (ASI-7-001); a future edit trusting it could go further.
- **Recommendation:** Resolve the question and correct the comment (and ops docs) to match reality.
- **Status:** Open — **Owner:** Unassigned

#### ASI-8-002: ESLint scans leftover `.claude/worktrees` copies; a handful of real unused-var warnings

- **Check:** Maintainability — **Confidence:** High
- **Location:** ESLint output — ~half the 78 warnings are duplicates from `.claude/worktrees/agent-*` copies; real ones include `src/app/api/transactions/route.ts:352` (`isMultiCurrency` unused — possibly related to ASI-6-005's unapplied filters) and `src/app/(main)/business/s-corp-analyzer/page.tsx:114` (hook deps)
- **Recommendation:** Add `.claude/` to the ESLint ignore list; triage the unused-var warnings (delete or use).
- **Status:** Open — **Owner:** Unassigned

## Check Results

| Check | Result | Notes |
|-------|--------|-------|
| 1. Correctness and AI-slop indicators | Findings (2 High, 4 Medium, 4 Low) | Core numeric/fraction handling, holding-period rule, lot-scrub signs, federal tax tables all verified correct; defects concentrate in lot summaries (carried basis), FX triangulation, recurrence edges |
| 2. Verification and test quality | Findings (1 High, 2 Medium, 2 Low) | 4,507 tests pass with strong boundary coverage of money math; but nothing gates deploys, e2e is unrunnable, FX lookup untested |
| 3. Security, supply chain, privacy, data integrity | Findings (2 High, 4 Medium, 3 Low) | Auth/session/RBAC foundation strong; committed credentials and TLS-off builds are the standouts; npm audit: 1 critical (mitigated), 15 high |
| 4. Filesystem, network, customer-environment safety | Findings (1 High, 2 Medium, 4 Low) | Upload/path-traversal/network-timeout hygiene good; repair-script conventions are the risk |
| 5. Reliability, concurrency, state consistency | Findings (6 Medium, 5 Low) | Ledger transactionality/idempotency verified sound; gaps are worker/background-pipeline resilience |
| 6. Performance and resource efficiency | Findings (3 Medium, 4 Low) | Indexes and cache key discipline good; N+1 on lots and per-page cost-basis recompute are the notable items |
| 7. Deployment, migration, rollback readiness | Findings (2 High, 2 Medium, 3 Low) | db-init model and rollback story are the main structural risks |
| 8. Maintainability, observability, structure | Findings (2 Low) | Clean overall; stale ownership comment is load-bearing |
| Module: Web/UI | Limited | Server-side authorization verified for sampled client controls; accessibility not assessed (no stated target) |
| Module: Database and Data Pipeline | Findings folded into checks 5/7 | Backfills/retries mostly bounded and idempotent |
| Module: Infrastructure/Container/Cloud | Findings folded into checks 3/4/7 | Non-root runtime, no baked secrets — good; TLS-off build, tag pinning — findings |
| Module: AI and Model-Integrated Systems | Finding ASI-3-004 | Read-only execution, timeouts, allowlists present; scope binding is the gap |

## Limitations and Follow-up

- The **actual Dockhand stack definition** on TrueNAS is not in the repo; compose-level findings (health checks, volumes, grace periods, env fallbacks) must be re-checked against it before acting.
- **Whether desktop GnuCash still opens the prod DB** is unresolved and changes the severity of the native-index drops (ASI-7-001/ASI-8-001). Answer this first.
- No database execution, `EXPLAIN`, build, or e2e run was performed; performance figures are code-shape estimates.
- Per-route book-isolation and audit-log coverage were sampled (~10–15 routes each), not exhaustive across all 419 routes.
- Subagent findings at Medium/Low severity were spot-checked but not all independently re-read line-by-line; all High findings were directly verified at the reviewed commit.
- Suggested order of attack: rotate the ASI-3-001 password today; then ASI-2-001 (CI gate) + ASI-3-002 (build integrity) as one PR; then ASI-1-001/ASI-1-002 (financial correctness); then the deployment structural work (ASI-7-001/002).
