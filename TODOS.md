# TODOS

Items deferred from plan reviews for future implementation.

## P1 - BUG: Multi-Lot Transfers Create Single Destination Lot

**What:** When shares transfer between accounts and the source has multiple lots, the auto-scrub engine creates one destination lot for the entire transfer-in split instead of splitting it across destination lots matching each source lot.

**Repro:** Account `56900f1b19ac4545b0f6d9bbca66feb2` (Ally VOO). On 2023-07-05, 591 shares transferred from Schwab VOO (`ca45b0d68fb442f293dd6e1d98c00e98`). The source had 4 lots:
- Lot `f8c1a42a`: 534 shares (acquired 2021-04-06)
- Lot `31c7a186`: 33 shares
- Lot `926ae7f4`: 13.89 shares
- Lot `b741b060`: 10.11 shares

The auto-scrub created one destination lot (`f0040f5a`) for all 591 shares, pointing only to the largest source lot. Cost basis is $0 (transfer), and the other 3 source lots' acquisition dates are lost.

**Expected behavior:** The 591-share transfer-in split should be sub-split into 4 destination splits (534, 33, 13.89, 10.11), each assigned to its own destination lot linked to the corresponding source lot via `source_lot_guid`. Each destination lot should carry the correct `acquisition_date` from its source lot. This preserves the full lot chain for long-term/short-term capital gains classification.

**Root cause:** `linkTransferToLot()` in `lot-assignment.ts` creates one lot per transfer-in split. It doesn't examine whether the source account's transfer-out consists of multiple lots and sub-split accordingly. The transfer-out side already has sub-splits per lot (visible in the transaction: -534, -33, -13.89, -10.11), but the transfer-in side is one lumped split (+591).

**Fix approach:**
1. In the transfer detection phase, after identifying a transfer-in, examine the source transaction's transfer-out splits
2. If the source has multiple lot-assigned splits, sub-split the transfer-in to match (proportional by quantity)
3. Create one destination lot per sub-split, each linked to the corresponding source lot
4. Carry `acquisition_date` from each source lot to its destination lot
5. This is essentially the same "sell splitting" logic (`splitSellAcrossLots`) but applied to transfers

**Effort:** M (human: ~1 week) / with CC: S (~30 min)

**Depends on:** Lot auto-assignment engine (shipped). The `splitSellAcrossLots()` function in `lot-scrub.ts` provides the pattern for sub-splitting.

**Context:** Discovered during QA of VOO account 2026-03-24. The design doc (`2026-03-22-lot-scrub-engine.md`) already identified "Transfers break lot continuity" as a known gap. This is the concrete manifestation of that gap with a real-world repro case.

---

## P2 - Monte Carlo FIRE Projections

**What:** Replace the single-line FIRE projection with a Monte Carlo simulation that samples from historical market return distributions. Show confidence bands (e.g., 10th/25th/50th/75th/90th percentile outcomes) instead of a single deterministic line.

**Why:** The current FIRE projection uses a single expected return rate (default 7%), which gives a false sense of precision. Real markets are volatile — a Monte Carlo approach using historical annual return distributions would show the range of possible outcomes: "you have a 75% chance of reaching FI by 2038, but a 25% chance it takes until 2042."

**Effort:** M (human: ~1 week) / with CC: M (~30 min)

**Depends on:** FIRE calculator data-driven upgrade (shipped). Needs a historical return dataset (e.g., S&P 500 annual returns 1928-present) either embedded or fetched.

**Context:** Deferred from QA review 2026-03-22. The single-year TWR (20.92%) was being used as the default expected return, which was wildly optimistic. Fixed to default to 7%. Monte Carlo would make the projection genuinely useful for planning by showing probability distributions instead of point estimates. Consider: Shiller CAPE data, sequence-of-returns risk modeling, and configurable asset allocation (stocks/bonds mix affects return distribution).

---

## P2 - Scheduled Transactions: Execute/Skip Upcoming Occurrences

**What:** Add the ability to execute or skip upcoming scheduled transaction occurrences from the web UI. Executing creates the actual GnuCash transaction (with splits matching the template), skipping advances `last_occur` and decrements `rem_occur` without creating a transaction.

**Why:** The scheduled transactions page is currently read-only — you can see what's coming but can't act on it. The most valuable action is executing upcoming payments (salary, mortgage) directly from the web app instead of opening GnuCash desktop. This is the core use case mentioned in the original feature brief.

**Effort:** M (human: ~1 week) / with CC: S (~30 min)

**Depends on:** Scheduled transactions UI (shipped). Requires write access to GnuCash tables: `transactions`, `splits`, `schedxactions` (updating `last_occur`, `rem_occur`, `instance_count`).

**Context:** Deferred from initial scheduled transactions implementation (2026-03-22). The template resolution logic already exists in the API — executing means creating a real transaction from the resolved template amounts and account mappings, then updating the schedxaction metadata. Need to handle: transaction date (use occurrence date vs today), multi-split transactions, and GnuCash GUID generation for new transactions.

---

## P2 - Scheduled Transactions: Enable/Disable

**What:** Toggle scheduled transactions on/off from the web UI. Updates the `enabled` field (0/1) on the `schedxactions` table.

**Why:** Simple quality-of-life feature — disable a scheduled transaction that's no longer relevant (e.g., old subscription) without opening GnuCash desktop. The UI already shows enabled/disabled badges.

**Effort:** S (human: ~2 days) / with CC: S (~10 min)

**Depends on:** Scheduled transactions UI (shipped). Single field update on `schedxactions.enabled`.

**Context:** Deferred from initial implementation. Trivial write operation — PATCH endpoint + toggle button in the UI. Low risk since it only flips a boolean flag.

---

## P3 - Scheduled Transactions: Create New

**What:** Create new scheduled transactions from the web UI with recurrence pattern configuration. Particularly useful for salary deposits and mortgage payments — the mortgage calculator could auto-generate a scheduled transaction matching the amortization schedule.

**Why:** Currently scheduled transactions can only be created in GnuCash desktop. For users who primarily use the web app (the goal of this project), being able to set up recurring salary and mortgage payments without desktop access completes the workflow. The mortgage payoff calculator already knows the payment amount, accounts, and frequency.

**Effort:** L (human: ~2 weeks) / with CC: M (~45 min)

**Depends on:** Scheduled transactions UI (shipped), execute/skip feature (for testing the created transactions). Requires writing to: `schedxactions`, `recurrences`, template `accounts`, template `transactions`/`splits`, and `slots` (for account GUID mapping).

**Context:** Deferred from initial implementation. This is the most complex scheduled transaction write operation because it requires creating the full GnuCash template structure (template root account → child template accounts → template transaction with splits → slots mapping template accounts to real accounts). The mortgage calculator integration (auto-creating a scheduled transaction from payoff parameters) would be a natural follow-up.

---

## P2 - Payslip Integration (PDF + QuickBooks Online)

**What:** Import payroll stubs into GnuCash Web. Phase 1: PDF upload + AI extraction into structured line items, mapped to GnuCash accounts via reusable per-employer templates, posted as detailed split transactions. Phase 2: QuickBooks Online API as an optional structured data source (OAuth 2.0 + Intuit Payroll API).

**Why:** Paychecks currently import via SimpleFin as lump-sum deposits with no breakdown. Users who want to track taxes, deductions, and retirement contributions must manually create split transactions. This automates that workflow and stores payslip PDFs alongside receipts.

**Effort:** L (human: ~2-3 weeks) / with CC: M-L (~1-2 hours)

**Depends on:** Receipt storage infrastructure (shipped), AI extraction pipeline (shipped), BullMQ queue (shipped).

**Spec:** [`docs/superpowers/specs/2026-03-24-payslip-integration-design.md`](docs/superpowers/specs/2026-03-24-payslip-integration-design.md)

**Context:** Designed 2026-03-24. Phase 1 (PDF + AI) builds on existing receipt/OCR infrastructure. Phase 2 (QBO API) deferred — requires Intuit developer approval and paid QuickBooks Payroll subscription. Key features: per-employer account mapping templates, SimpleFin deposit enrichment/dedup, balance validation with imbalance account fallback, employer contribution tracking (informational only).

---

## P4 - Receipt AI Re-Extraction Batch Job

**What:** A "Re-extract all" button in AI settings that enqueues BullMQ jobs to re-run extraction on all existing receipts that used regex, using the newly configured AI provider.

**Why:** When a user configures AI for the first time, their existing receipts have `extraction_method: "regex"`. Re-extraction with AI would improve match quality for the backlog without requiring re-upload.

**Effort:** S (human: ~2 days) / with CC: S (~10 min)

**Depends on:** Receipt auto-matching feature with AI provider configuration.

**Context:** Deferred from eng review 2026-03-22. Users get AI extraction on new uploads immediately. The batch re-extraction is a nice-to-have that adds batch job management complexity. Users can also manually trigger re-extraction per receipt.

---

## P2 - Retirement & Brokerage Contribution Reports

**What:** A reporting feature that surfaces total contributions to retirement accounts (401k, IRA, Roth IRA, HSA, etc.) and brokerage accounts over configurable time periods (YTD, annual, lifetime). Show per-account contribution totals, contribution limits vs. actual (where applicable), and aggregate summaries across all retirement/brokerage accounts.

**Why:** Users need visibility into how much they've contributed to tax-advantaged and investment accounts for tax planning, IRS limit tracking, and financial goal monitoring. This data exists in the GnuCash transaction history but isn't surfaced in an actionable way — users currently have to manually trace deposit transactions across multiple accounts.

**Effort:** M (human: ~1 week) / with CC: M (~30 min)

**Depends on:** Account hierarchy (shipped), investment lots/transfers support (shipped).

**Context:** Added 2026-03-26. Key considerations: distinguish contributions from transfers between accounts (a rollover from 401k to IRA is not a new contribution), handle employer match as a separate line item, support IRS annual limits (e.g., $23,500 for 401k in 2025) with progress bars, and allow drill-down to individual transactions backing each contribution total. **Tax-year attribution:** Contributions must be attributed to the correct tax year, not just the transaction date. Retirement accounts (IRA, Roth IRA, HSA) allow prior-year contributions up to the filing deadline (e.g., a 2025 IRA contribution made in February 2026). The transaction description typically contains this info (e.g., "2025 Roth IRA Contribution"). The report should parse descriptions for year indicators and allow manual override of the tax year per transaction. Group-by and filter-by should operate on tax year, not just calendar date.

---

## P2 - SimpleFin Import: Manual Transaction Reconciliation & Transfer Dedup

**What:** Two related features for SimpleFin import: (1) Manually created transactions should be reconciled/matched to incoming SimpleFin transactions on import, preventing duplicates when a user has already entered a transaction before the bank feed arrives. (2) Transfers between two accounts that both have SimpleFin feeds should be automatically deduplicated — the transfer appears in both bank feeds but should only create one transaction.

**Why:** Without reconciliation, users who proactively enter transactions get duplicates when SimpleFin imports the same transaction days later. Without transfer dedup, a $500 transfer from checking to savings creates two transactions (one from each bank feed) instead of one. Both issues erode trust in the import pipeline and create manual cleanup work.

**Effort:** L (human: ~2 weeks) / with CC: M (~45 min)

**Depends on:** SimpleFin import (shipped).

**Context:** Added 2026-03-26. Reconciliation approach: on import, before creating a new transaction, search for existing unreconciled transactions in the same account within a date window (±3 days) with matching amount. Present candidates for user confirmation or auto-match with high confidence (exact amount + date match). Transfer dedup approach: detect when two SimpleFin transactions across different accounts have matching amounts (one positive, one negative) within a close date window, and link them as a single transfer transaction. Edge cases: partial matches, split transactions, same-amount recurring transactions (rent vs. one-time transfer).

---

## P2 - Fix Asset Analysis Tool: Manual Account Selection

**What:** Redesign the Asset Analysis tool so it starts with a blank/empty account list instead of defaulting to all Asset accounts. Users should manually add specific accounts or sub-account trees to the analysis. Provide an account picker with search and the ability to add/remove individual accounts or entire sub-hierarchies.

**Why:** Defaulting to all Asset accounts makes the tool noisy and misleading — it includes checking accounts, receivables, and other non-investment assets that don't belong in an asset allocation analysis. Users need to curate the account set to get meaningful results (e.g., only brokerage + retirement accounts).

**Effort:** S (human: ~3 days) / with CC: S (~15 min)

**Depends on:** Asset Analysis tool (shipped), account hierarchy (shipped).

**Context:** Added 2026-03-26. The account picker should support: searching by account name, expanding the hierarchy to select sub-trees, persisting the selected accounts to localStorage (or user preferences once auth exists), and showing a summary of selected accounts before running the analysis. Consider a "suggested" preset that auto-selects accounts of type STOCK, MUTUAL, and ASSET accounts with commodity holdings.

---

## P1 - OIDC Authentication & Per-Book Authorization

**What:** Full authentication and authorization system. OIDC-based login (supporting providers like Keycloak, Auth0, Google, etc.), with a per-book permission model. Components:
1. **OIDC authentication:** Login via OpenID Connect provider, session management, token refresh.
2. **Book-level permissions:** Users are granted access to specific books with role-based permissions (admin, editor, viewer).
3. **Permission editor UI:** Admin users can list users with access to a book, invite new users, change roles, and revoke access.
4. **Default admin on import:** When a book is imported, the importing user automatically becomes the admin for that book.
5. **Security reimplementation:** Replace any existing auth mechanisms with the OIDC-based system. All API routes and pages enforce authorization.

**Why:** Currently the app has no access control — anyone with the URL can view all financial data. Multi-user support is essential for shared households, accountants managing client books, and basic security. Per-book permissions are necessary once multiple books exist in the same database.

**Effort:** XL (human: ~3-4 weeks) / with CC: L (~2-3 hours)

**Depends on:** Multi-book support (needed for per-book permissions to be meaningful).

**Context:** Added 2026-03-26. Implementation approach: use `next-auth` (Auth.js v5) with the OIDC provider for authentication. Store user-book-role mappings in a new `user_book_permissions` table. Roles: `admin` (full control + permission management), `editor` (read/write transactions), `viewer` (read-only). Middleware checks session + book permission on every request. The permission editor is an admin-only settings page per book. Consider: API key auth for programmatic access, audit logging of permission changes, and graceful handling of OIDC provider downtime.

---

## P2 - FIRE Calculator: Expose Assumptions & Monte Carlo Analysis

**What:** Enhance the FIRE calculator with two improvements: (1) Surface and make configurable the underlying assumptions (inflation rate, withdrawal strategy, Social Security estimates, tax rates, healthcare costs, asset allocation glide path, etc.). (2) Add Monte Carlo simulation using historical return distributions to show probability-weighted outcome ranges instead of a single deterministic projection.

**Why:** The current calculator uses fixed assumptions that may not match the user's situation, and a single expected return rate that gives false precision. Exposing assumptions lets users model their specific scenario. Monte Carlo analysis (see existing P2 TODO) shows the range of possible outcomes — "you have an 80% chance of not running out of money by age 90" is far more useful than "you'll have $X at age 90."

**Effort:** L (human: ~2 weeks) / with CC: M (~45 min)

**Depends on:** FIRE calculator (shipped). Monte Carlo needs a historical return dataset.

**Context:** Added 2026-03-26. This extends the existing P2 Monte Carlo TODO with the assumptions exposure component. Key assumptions to surface: expected real return rate, inflation rate, safe withdrawal rate (4% default), Social Security start age and estimated benefit, tax rate in retirement, healthcare cost model, and asset allocation changes over time. Monte Carlo specifics: use Shiller CAPE or S&P 500 annual return data (1928-present), run 10,000+ simulations, show confidence bands (10th/25th/50th/75th/90th percentile), and highlight sequence-of-returns risk in early retirement years.

---

## P3 - Scheduled Book Sync to External PostgreSQL / GnuCash Desktop

**What:** A scheduled background job that syncs the GnuCash Web book data to an external PostgreSQL database (or other target) in a format compatible with GnuCash desktop. This enables round-tripping: edit in the web app, sync back to a database that GnuCash desktop can open.

**Why:** Once GnuCash Web supports multiple books in a single database, the database schema diverges from what GnuCash desktop expects (desktop assumes one book per database). A sync job that exports a single book to a separate database preserves desktop compatibility for users who still use both interfaces.

**Effort:** L (human: ~2 weeks) / with CC: M (~1 hour)

**Depends on:** Multi-book support, OIDC auth (to know which books exist and who owns them).

**Context:** Added 2026-03-26. Approach: scheduled BullMQ job (configurable interval, e.g., nightly) that dumps a single book's tables to a target PostgreSQL database in vanilla GnuCash schema format. Must handle: incremental sync (only changed rows since last sync), conflict detection (warn if desktop made changes since last sync), schema compatibility (GnuCash desktop expects specific table structures), and connection management (target DB credentials stored per-book in settings). Consider: pg_dump/pg_restore for initial seed, logical replication for incremental, or application-level row-by-row sync.

---

## P3 - Account & Transaction Tagging

**What:** A tagging system for accounts and transactions that provides an alternative, non-hierarchical grouping mechanism alongside the existing account hierarchy. Tags are flat labels (not hierarchical) that can be applied to any account or transaction. Features:
1. **Tag CRUD:** Create, rename, delete tags. Tags are global to the book.
2. **Apply tags:** Tag individual transactions or accounts. Bulk-tag operations for transaction ranges.
3. **Tag-based views:** Filter/group transactions and accounts by tag. A "tag browser" page showing all tags with counts.
4. **Tag-based reporting:** Run existing reports (balance, P&L) scoped to a tag instead of an account subtree.
5. **Multi-tag support:** Accounts and transactions can have multiple tags.

**Why:** The GnuCash account hierarchy is great for standard accounting structure, but users often need cross-cutting categorization that doesn't fit the tree — e.g., tagging all "vacation" expenses across Food, Travel, and Entertainment accounts, or tagging transactions related to a specific project, property, or tax event. Tags provide this flexibility without restructuring the chart of accounts.

**Effort:** L (human: ~2-3 weeks) / with CC: L (~1-2 hours)

**Depends on:** Core transaction/account infrastructure (shipped). OIDC auth (tags should respect book permissions).

**Context:** Added 2026-03-26. Storage: new `tags` table (id, book_guid, name, color) and junction tables `transaction_tags` (transaction_guid, tag_id) and `account_tags` (account_guid, tag_id). UI: tag chips with colors displayed on transaction rows and account tree nodes, a tag picker autocomplete component, and a dedicated tag management page. Consider: tag groups/categories as a future extension (but keep V1 flat), import/export of tags, and whether GnuCash desktop's `slots` KVP system could store tags for round-trip compatibility.

---

## P3 - Revisit Account Reconciliation UX

**What:** Re-evaluate the account reconciliation flow after go-live based on real-world usage. The current flow doesn't feel right, but the specific pain points and improvements need to be identified through actual use.

**Why:** Reconciliation is a core accounting workflow — if it's clunky, users will skip it or fall behind, leading to unreconciled accounts and reduced trust in the data. Getting this right matters for the app to be a credible GnuCash companion.

**Effort:** TBD (needs discovery first)

**Depends on:** Go-live, real user feedback.

**Context:** Added 2026-03-26. This is intentionally open-ended — the current reconciliation flow needs to be used in practice before specific improvements can be scoped. After go-live, collect friction points: Is the workflow too many clicks? Is it unclear which transactions are unreconciled? Is the balance matching confusing? Does it need bank statement import integration? Revisit this TODO with concrete findings and then scope specific fixes.
