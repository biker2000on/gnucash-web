# Polyagent cross-model review — Transaction Comments/History + Document Vault

**Run:** `20260820-comments-vault-rev1` · **Scope:** `9ffaa70a..b5e736a3` (4 integrated commits)
**Reviewers:** Claude Opus (correctness/data-integrity/concurrency), Codex gpt-5.6-sol (security/API contracts/performance), lead-owned Opus reviewer covering the UI/UX-regression lens after the Grok CLI failed three attempts without producing a report (its worktree is preserved; evidence under `~/.polyagent/projects/gnucash-web-775407fe/runs/20260820-comments-vault-rev1`).
**Compliance:** both completed review worktrees verified source-clean.
**Outcome:** every accepted finding was fixed the same day in two lead-verified fix commits (`af24c6dc` comments, `eb96617b` vault, plus `2e0559dc` tripwire cleanup). Final gate on the integrated tree: tsc 0, eslint 0 warnings, schema drift 0, **6,290/6,290 tests**.

## High findings (all fixed)

| # | Lens | Finding | Fix |
|---|---|---|---|
| H1 | correctness | History timeline formatted every amount as USD regardless of book/transaction currency (`transaction-history.ts`; route never passed currency) | Route resolves `transactions.currency_guid → commodities.mnemonic` into `HistoryResolvers.currency`; EUR assertions added |
| H2 | correctness | FX cash splits misclassified as investment share legs (`isShareLeg` fired on any `value ≠ quantity`, which the repo's FX convention guarantees for cross-currency cash) | Share-leg decision keyed off the split account's commodity namespace, resolver supplied by the route |
| U1 | ui/ux | One shared `expanded` object drove card groups AND the TanStack table — collapsing any card group persisted a state the table read as "collapse everything" | Separate persisted card/table expansion state, storage key bumped to v2, malformed persisted state type-guarded |
| U2 | ui/ux | Prior-year missing-tax-forms warning regressed: only rendered under Group-by→Tax-year, never in table view | Warning derived from the documents themselves; renders in both views under every grouping |
| S1 | security/contract | Search hits carried a `documents`-index id the UI compared against `entity_documents.id` — search could highlight/act on the wrong document | `sourceKind`/`sourceId` emitted on hits, `canonicalDocumentId` on list rows, UI reconciles by source id first |

## Medium findings (all fixed)

- **Comments API:** combined PATCH non-atomic and returned the wrong comment (now one `$transaction`, returns the edited comment + `threadResolved`); `auditId` accepted unvalidated (now proven to belong to the transaction, 400 otherwise); nested `PATCH/DELETE /transactions/{guid}/comments/{id}` never checked `{guid}` owns `{id}` (now 404 on mismatch); no pagination/caps (comments list newest-200 + `hasMore`, comment-counts elements validated as 32-hex, mention notifications deduped); dead deep link `/ledger?transaction=<guid>` (now opens the transaction modal end-to-end); history/comments fetch failures coupled (now settled independently); badges blanked on every infinite-scroll page and vanished past 500 rows (delta-fetching accumulator + chunking).
- **Vault backend:** tag vocabulary creation raced the `(book_guid,name)` unique index (now `ON CONFLICT DO NOTHING` + re-select); `setDocumentTags` DELETE-then-INSERT untransacted (now `$transaction`); tag-filtered search filtered after the 20-hit LIMIT → false negatives and a fabricated `totalHits` (tag predicate pushed into the SQL before LIMIT); apply-rules unbounded synchronous sweep (set-based, batched inserts, 500-doc cap with continue token); thumbnail render could run inline on the upload request when Redis was down (inline path now worker-only); boot backfill enqueued every document at once (batched 200/pass); thumbnails cached 7 days in shared browser profiles (now `must-revalidate` + ETag/304).
- **Vault UI:** page ignored the list response's `tags`/`thumbnailStatus` sidecars — one `/tags` request per document and a thumbnail fetch per card regardless of status (now seeded from the list; fetch only when `complete`; distinct terminal "failed" state).

## Low findings (all fixed unless noted)

Comments: `entity_type` filters on every read; soft-deleted roots can no longer be resolved; TZ-safe date rendering; guid-less splits diff by position; trailing-punctuation usernames mentionable; comments hard-deleted with their transaction; read-only modal presentation parity. Vault: `book_root_guid` semantic mismatch between the two new tables documented loudly at both DDL sites (deliberately not migrated); id lists chunked at 1,000; hydration-safe persisted state; tag-editor dialog semantics (Escape/outside-click/focus return); vocabulary refreshed after saves; fileName/notes/relative-expiry metadata restored. Native `title=` reintroduced by the fix wave itself was caught by the tripwire and replaced with `Tip`.

## Explicitly checked and not broken

RBAC matrix exact (viewers read, editors comment, authors edit own, admins delete; timekeeper rejected); no cross-book comment access by id; soft-delete leak-free; reply nesting capped at one level; mention parser ignores emails; all SQL parameterized; DDL idempotent/advisory-lock/dual-container safe; thumbnail route book-scoped, nosniff, rasterized-only (no HTML/SVG smuggling path); rule matching in-memory with literal `%_`; vocabulary counts book-scoped; card/table views genuinely share one filtered dataset; upload staging, tax archive, preview, download, edit, delete, suggestions all survived the refactor; DESIGN.md conformance across the new UI.

## Residual (accepted, not fixed)

- No per-user rate limiting on comment posting (repo has no rate-limit primitive; body capped at 4,000 chars, mentions deduped).
- History audit window capped at 500 rows, now surfaced as "older changes not shown".
- Search remains capped at 20 hits per group (pre-existing contract).
- The new tag-filter SQL shapes (`source_id` regex-guarded `::integer` cast, `UNNEST(...)::integer[]` insert) run against real Postgres only in CI's integration tier.
