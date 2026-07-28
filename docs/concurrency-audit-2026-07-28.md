# Multi-User Concurrency Audit — 2026-07-28

**Question:** Can multiple users safely edit and work in the same book at one time?

**Verdict: NO — not yet.** The app has multi-user *auth* (RBAC, sessions, per-book permissions), but the data layer is architected single-user. Every Prisma transaction runs at PostgreSQL's default READ COMMITTED isolation (`isolationLevel` appears nowhere in the codebase), row locking exists in only three subsystems, and exactly one endpoint has (opt-in) optimistic concurrency. Concurrent editing of the same book today produces silent lost updates, duplicated money, and in one case an unrecoverable corrupted account tree.

This document consolidates four parallel audits: API write paths, complex multi-step operations, client-side freshness, and schema-level safeguards.

---

## What exists today (the good parts — use as templates)

| Pattern | Location | Notes |
|---|---|---|
| `SELECT … FOR UPDATE` inside `$transaction` | `src/lib/services/scheduled-tx-execute.ts:71,167` | Correct shape; serializes SX counters |
| `FOR UPDATE` with deadlock-safe `ORDER BY id` | `src/lib/inventory-engine.ts:512,534` | |
| Advisory lock + `FOR UPDATE` + version CAS | `src/lib/planning/living-plan.ts:327-360` | Best-protected write path in the codebase |
| Advisory lock + status-guarded conditional UPDATE + rowCount check | `src/lib/business/reimbursements.ts:250-338` | |
| Compare-and-swap claim (`UPDATE … WHERE next_date = expected RETURNING`) | `src/lib/business/recurring-invoices.ts:16-19` | Cheapest retrofit pattern for post/close/sweep flows |
| `withDatabaseAdvisoryLock` for startup DDL | `src/lib/db.ts:21-61`, `src/lib/db-init.ts:1916-1927` | db-init races are solved (codex/db-init-startup-lock is merged) |
| Server-side recompute + 409 on reconcile finalize | `src/lib/reconcile.ts:278-294` | Good validation, but no row locks (see below) |
| Optimistic lock on transaction PUT via `enter_date` | `src/app/api/transactions/[guid]/route.ts:153-162` | Opt-in only; TOCTOU (compare outside the tx) |
| Balances computed on read, `account_hierarchy` is a plain view | `financial-summary.service.ts`, `db-init.ts:17` | No stored-balance staleness — good |
| GUID generation | `src/lib/guid.ts`, `src/lib/gnucash.ts:93` | crypto-random, collision-safe |

---

## CRITICAL — data corruption or destruction

### C1. Transaction edit is delete-and-recreate with a bypassable, racy lock
`src/app/api/transactions/[guid]/route.ts:109-317`
- The `original_enter_date` 409 check (line 153) is **opt-in** — only the inline ledger editors send it (`EditableRow.tsx:183,249`, `InlineEditRow.tsx:119`, `InvestmentEditRow.tsx:178`). The primary edit UIs — `TransactionFormModal.tsx:64-96` and `TransactionEditModal.tsx:78-97` — **do not**, so they blindly overwrite.
- Even when sent, the compare happens *outside* the `$transaction` (TOCTOU): two users who both pass the check both commit; last writer wins.
- Line 214 `splits.deleteMany` + re-insert from the request body: the loser's splits are annihilated wholesale (added splits deleted, corrections reverted).
- Reconcile/lot preservation (lines 221, 230-238) reads from a **pre-transaction snapshot** (`existingSplitByGuid`, line 190) — a concurrent reconcile or lot assignment is silently reverted to stale values.
- DELETE (lines 319-399) accepts no version token at all, and its `gnucash_web_transaction_meta` cleanup runs *before/outside* the `$transaction` (lines 348-360) — a failed delete destroys the SimpleFin dedup record, causing re-import duplicates.
- The `enter_date` token is also **not bumped** by sibling write paths (`transactions/bulk`, `splits/bulk/move`, reconcile, lot assignment, review PATCH), so even the protected path silently clobbers those.

### C2. Account reparenting can create a cycle that bricks the book
`src/lib/services/account.service.ts:227-252, 445-497`
- Cycle check walks `parent_guid` outside the transaction, no locks. A moves X under Y while B moves Y under X → both validate, both commit → cycle. Every recursive CTE (`book-scope.ts:86`, `account_hierarchy` view, book delete) then infinite-loops or dies. **No repair path exists.** `move()` isn't even in a transaction.

### C3. Book delete: unscoped global DELETE + extension cleanup outside the transaction
`src/app/api/books/[guid]/route.ts:167-258`
- Lines 229-234: `DELETE FROM transactions WHERE guid NOT IN (SELECT tx_guid FROM splits)` — **not book-scoped**; sweeps split-less transactions from *every* book.
- Line 214: `deleteBookExtensionData` runs before/outside the `$transaction` — if core deletion fails, all `gnucash_web_*` rows and files are already permanently gone.
- Account-tree enumeration (lines 186-207) runs outside the transaction — a concurrently created account orphans the tree or FK-aborts the delete (after extension data is gone).

### C4. Invoice/statement/close-book flows double-post money
- **Invoice post** — `invoice-engine.ts:844-971`: "already posted" guard read without `FOR UPDATE`; two posts → two A/R transactions + two lots, one orphaned and invisible to the UI, permanently inflating A/R and revenue.
- **Statement finalize** — `statement-reconcile-data.ts:536-738`: no status precondition anywhere; reads/tie-out outside the tx. Two finalizes (or one double-click) book **every added line twice**.
- **Close book** — `close-book.ts:143,182`: no already-closed marker; two runs zero income/expense into equity twice.
- **Payment application** — `invoice-engine.ts:1107,1153`: no locking on open-doc balances; concurrent payments over-apply and drive A/R credit-negative.
- **Funding-rule sweep** — `funding-rules.service.ts:524-592`: dedup via `findFirst` on non-unique `transactions.num`; overlapping runs double-sweep.
- **Invoice/voucher numbering** — `invoice-engine.ts:406-436`, `vouchers.ts:84-131`: read-modify-write counter slot, no `FOR UPDATE`, no unique on `invoices.id` → duplicate document numbers that *repeat* on subsequent pairs.

### C5. Overwrite XML import with no book lock or read-only mode
`src/lib/gnucash-xml/importer.ts:174-629`
- Atomic (good), but with `overwrite: true` it mass-deletes then re-inserts for up to 5 minutes at READ COMMITTED while other users keep writing — their commits are silently wiped or applied on top of half-restored data. No "import in progress" flag. Commodity creation (lines 204-235) is check-then-insert with no unique on `(namespace, mnemonic)`.

### C6. No `gnclock` interlock with GnuCash desktop
`prisma/schema.prisma:396-402` (`@@ignore`d; zero references in `src/`)
- The app never reads nor writes `gnclock`. Desktop holding the book in RAM will overwrite web-app writes on save (and vice versa), with **no warning in either direction**. For the stated goal ("fix the GnuCash multi-user complaint"), this is table stakes.

---

## HIGH — duplicated or wrong financial data under concurrency

- **H1. Lot scrub races** (`lot-assignment.ts:313-325`, `lot-scrub.ts:133-345`): no locks anywhere in the lot engine. Concurrent scrubs on one account → duplicate empty lots + duplicate "Realized Gain" transactions (idempotency guard can't see uncommitted peers). `openLots[].shares` mutated in-place from a stale snapshot → wrong cost basis / realized gains, silently. `scrubAllAccounts` (`:603-720`) isn't a transaction at all and swallows per-account errors → half-scrubbed book.
- **H2. Scheduled-transaction double-execution** (`scheduled-tx-execute.ts:59-144`): `FOR UPDATE` serializes but does **not** deduplicate — no check that `occurrenceDate <= last_occur`. Two users clicking Record for the same occurrence book it twice, deterministically. Also `resolveTemplateSplits` (line 86) uses the global prisma client, escaping the lock's transaction.
- **H3. SimpleFin sync duplicates** (`simplefin-sync.service.ts:339-351`): `simplefin_transaction_id` has no unique index; dedup set built once at sync start; no "sync in progress" guard → overlapping syncs import everything in the window twice.
- **H4. Duplicate trading accounts** (`trading-accounts.ts:122-192`): three-level check-then-create with no unique on `accounts(parent_guid, name)` → concurrent multi-currency saves create duplicate Trading trees; balances split across them.
- **H5. Duplicate prices** (`prices` has no unique on `(commodity_guid, currency_guid, date)`): manual entry, implied-price service, and Yahoo fetch all blind-insert → portfolio valuations become non-deterministic between page loads.
- **H6. Reconciliation races** (`reconcile.ts:205-305`): no `FOR UPDATE` on candidate splits; two concurrent reconciliations both pass tie-out against pre-state; overlapping selections both pass the already-reconciled guard. No partial unique index preventing two 'started' sessions per account (the pattern exists at `db-init.ts:1723` for reimbursements — just not applied here). Reconciled-split edit guard in transaction paths is a pre-transaction TOCTOU.
- **H7. Duplicate sibling accounts** (`gnucash.ts:160-186` `findOrCreateAccount`, `default-book.ts:143-221`): check-then-insert with no unique on `(parent_guid, name)`.
- **H8. Lot revert not book-scoped** (`api/accounts/[guid]/lots/revert/route.ts:5-20`): any editor of any book can destroy another book's scrub run by runId (runIds are returned in API responses). Also an authorization bug.
- **H9. Audit undo** (`audit.service.ts:249-294`): `revert_update` has no double-undo guard and overwrites all edits made since; no `undone_at` marker, entries stay clickable forever.

---

## MEDIUM — staleness and multi-process divergence

- **M1. No cross-user change propagation.** React Query used in only 5 files; everything else is fetch-once `useEffect` snapshots that never refresh. `useAccounts.ts:53` sets `staleTime: Infinity` ("hierarchy is static" — false in multi-user). SSE + Redis pub/sub infra exists (`job-progress.ts:46`, book-scoped channels) but carries only job progress/notifications — no data-change events. Users act on hours-stale ledgers, budgets, and SX lists all day.
- **M2. Budget grid is pure last-writer-wins** with optimistic UI that hides the loss (`InlineAmountEditor.tsx:77-93`); `BatchEditModal` wipes a colleague's per-period tuning; `BudgetService.addAccount`/`setAllPeriods` aren't transactional (partial-period failure states).
- **M3. Process-global caches break under the shipped 2-process topology** (web + worker in `docker-compose.prod.yml`): `book-scope.ts:70` account-guid cache invalidated per-process only, and *not* invalidated at all by SimpleFin auto-created accounts (`simplefin-sync.service.ts:1071+`) or trading-account creation → balances/reports silently exclude new accounts; spurious 404s from `isAccountInActiveBook`. `period-lock.service.ts:41` 5s cache → posts into just-locked periods.
- **M4. Redis dashboard cache gaps**: 24h TTL; invalidated by transaction/price/import writes but **not** by reconcile, account CRUD, budget writes, or business-doc posting. `net-worth` key omits user id while `kpis` includes it (and `balance_reversal` is per-user).
- **M5. Pool exhaustion**: two pools (`db.ts:9`, `prisma.ts:23`), no `max` (default 10 each), while transaction PUT/import/lot-assign hold interactive transactions for 120–300s. ~10 concurrent heavy ops drain the pool for everyone.
- **M6. Period-lock and reconciled-split checks are pre-transaction TOCTOU** in all transaction write routes.
- **M7. Bulk ops plan against stale snapshots** (`transactions/bulk/route.ts:186-277`, `splits/bulk/move`, `splits/[guid]/reconcile:150` — the latter also missing a book-scope check).
- **M8. Misc**: hardcoded `SESSION_SECRET` fallback (`session-config.ts:15` — should fail closed); `book-scope.ts:16-61` auto-assigns first book without checking `gnucash_web_book_permissions`; `localStorage` preferences not user-scoped (`UserPreferencesContext.tsx:37` — `balanceReversal` flips displayed signs for the next user on a shared machine); `docs/security-rbac-research.md` still says "Pre-Implementation" though RBAC has shipped; dead `TransactionService` (`transaction.service.ts`) is unreferenced but contains traps (`lot_guid: null` on edit, float-tolerance balance check) — delete it.

---

## Remediation plan (dependency order)

### Phase 1 — stop silent lost updates (core ledger)
1. Make `original_enter_date` **required** on transaction PUT and DELETE; move the compare **inside** the `$transaction` as `UPDATE … WHERE guid = ? AND enter_date = ?` → 0 rows = 409. Thread the token through `TransactionFormModal` and `TransactionEditModal`.
2. Bump `enter_date` (or add a dedicated `version` slot) in every transaction-touching path: bulk edit, split move, reconcile, lot assignment, review.
3. Re-read `existingSplitByGuid` inside the transaction so reconcile/lot preservation uses live state.
4. Move period-lock and reconciled-split checks inside the transaction.

### Phase 2 — kill the double-money paths
5. Claim-first conditional updates (recurring-invoices pattern) for: invoice post, statement finalize, close book, funding sweep, audit undo (`undone_at`).
6. `FOR UPDATE` on: invoice row + counter slot, payment open-docs, reconcile candidate splits.
7. Occurrence idempotency in `executeOccurrence`/`skipOccurrence`: reject `occurrenceDate <= last_occur` inside the existing `FOR UPDATE`; pass `tx` into `resolveTemplateSplits`.

### Phase 3 — unique constraints (turn races into clean errors)
8. `prices(commodity_guid, currency_guid, date)`; `commodities(namespace, mnemonic)`; `accounts(parent_guid, name)`; partial unique on `gnucash_web_transaction_meta(simplefin_transaction_id)`; partial unique on `gnucash_web_reconciliation_sessions(account_guid) WHERE status='started'`; unique or dedup table for funding-sweep `num`; unique on `slots(obj_guid, name)` for counters. (Some need a dedupe pass on existing data first.)

### Phase 4 — serialize the heavy operations per book
9. `pg_advisory_xact_lock(hashtext('book:'||bookGuid))` (pattern already in `living-plan.ts:327`) around: lot auto-assign/clear/revert/scrub-all, XML import, book delete, account reparenting (covering the cycle check), close book. Use `pg_try_advisory_lock` for scrubs/imports so the second user gets a clean 409 "operation in progress".
10. Fix book delete: scope the transactions DELETE to the book's accounts; move tree enumeration and `deleteBookExtensionData` inside the `$transaction`.
11. Book-scope the lot revert route.

### Phase 5 — freshness and multi-process correctness
12. Publish `data-change:book:{bookGuid}` events on the existing Redis/SSE channel from write routes; client provider invalidates React Query caches + dispatches window events for non-RQ pages.
13. Drop `staleTime: Infinity` in `useAccounts`; invalidate the Redis dashboard cache from account/budget/reconcile/business writes; user-scope the net-worth cache key.
14. Replace `book-scope.ts` / `period-lock.service.ts` module-global caches with per-request `cache()` or Redis.
15. Set explicit pool `max`; shorten interactive-transaction timeouts; move import/lot-assign fully onto the job queue.

### Phase 6 — GnuCash desktop coexistence
16. Read `gnclock` at book open and before writes; insert/remove the app's own row; persistent UI banner when desktop holds the lock.

### Cleanup
17. Delete dead `src/lib/services/transaction.service.ts`; fail closed on missing `SESSION_SECRET`; enforce book permissions in `book-scope.ts` fallback; update `docs/security-rbac-research.md` status; user-scope localStorage prefs.
