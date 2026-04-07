# TODOS

Items deferred from plan reviews for future implementation.

## P3 - Amazon Order History Reports CSV Format Support

**What:** Support Amazon's "Order History Reports" CSV format (multi-file: orders CSV + items CSV joined by Order ID) as an alternative to the "Request My Data" single-file format.

**Why:** The MVP Amazon import only supports "Request My Data" format. The "Order History Reports" format includes Amazon's item categories (useful for auto-categorization) and is more familiar to users who've used Amazon's built-in download feature. Requires a multi-file upload UI and a join step in the parser.

**Effort:** S (human: ~3 days) / with CC: S (~15 min)

**Depends on:** Amazon Order Import feature.

**Context:** Deferred from eng review 2026-04-06. The "Request My Data" format has item-level detail in one file, making it simpler to parse. Adding "Order History Reports" later is a clean extension: add a second parser function, detect format by header row, and allow multi-file upload. The two formats have different column names and structures, but both normalize to the same `AmazonOrder` interface.

---

## P2 - Monte Carlo FIRE Projections

**What:** Replace the single-line FIRE projection with a Monte Carlo simulation that samples from historical market return distributions. Show confidence bands (e.g., 10th/25th/50th/75th/90th percentile outcomes) instead of a single deterministic line.

**Why:** The current FIRE projection uses a single expected return rate (default 7%), which gives a false sense of precision. Real markets are volatile — a Monte Carlo approach using historical annual return distributions would show the range of possible outcomes: "you have a 75% chance of reaching FI by 2038, but a 25% chance it takes until 2042."

**Effort:** M (human: ~1 week) / with CC: M (~30 min)

**Depends on:** FIRE calculator data-driven upgrade (shipped). Needs a historical return dataset (e.g., S&P 500 annual returns 1928-present) either embedded or fetched.

**Context:** Deferred from QA review 2026-03-22. The single-year TWR (20.92%) was being used as the default expected return, which was wildly optimistic. Fixed to default to 7%. Monte Carlo would make the projection genuinely useful for planning by showing probability distributions instead of point estimates. Consider: Shiller CAPE data, sequence-of-returns risk modeling, and configurable asset allocation (stocks/bonds mix affects return distribution).

---

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

---

## P2 - Scheduled Transaction: Edit & Create from Existing

**What:** Two enhancements to scheduled transactions:
1. **Edit scheduled transaction:** From the scheduled transactions list, click an existing scheduled transaction to open an edit panel (similar to the create panel) where users can modify the name, recurrence, splits, amounts, start/end dates, and auto-create/notify settings.
2. **Create scheduled transaction from existing transaction:** From any ledger (account ledger or general ledger), select a transaction and click "Schedule" to pre-populate a new scheduled transaction with that transaction's description, splits, and amounts. The user then sets the recurrence and saves.

**Why:** Currently scheduled transactions can only be created from scratch with no way to edit after creation. Most scheduled transactions originate from an existing real transaction ("I paid rent, now I want this to repeat monthly"). Creating from an existing transaction saves manual re-entry of accounts and amounts.

**Effort:** M (human: ~1 week) / with CC: S-M (~20-30 min)

**Depends on:** Scheduled transaction create (shipped), AccountSelector component (shipped).

**Context:** Added 2026-03-30. The edit panel should reuse the `CreateScheduledPanel` component (refactored to handle both create and edit modes). The "Schedule" action in ledgers should be part of a new right-click context menu on transaction rows — the ledgers currently have no context menu, and there are now enough actions to justify one (schedule, duplicate, delete, view receipt, etc.). Consider: pre-selecting the recurrence based on transaction patterns (e.g., if similar transactions appear monthly, default to monthly), and an update API endpoint (`PATCH /api/scheduled-transactions/[guid]`).

---

## P3 - Ledger Transaction Context Menu

**What:** A right-click context menu on transaction rows in both the Account Ledger and General Ledger (TransactionJournal). Actions:
1. **Schedule** — Create a scheduled transaction pre-filled from this transaction (see above)
2. **Duplicate** — Create a copy of this transaction with today's date
3. **Delete** — Delete the transaction (with confirmation)
4. **Edit** — Open the transaction edit modal
5. **Attach receipt** — Open the receipt upload/link dialog for this transaction
6. **View in account** — (General Ledger only) Navigate to the account ledger for the selected split's account
7. **Copy transaction ID** — Copy the GUID to clipboard (power user feature)

**Why:** Currently transaction actions require clicking into edit mode or using keyboard shortcuts. A context menu provides discoverable access to all actions and is the natural place to add new actions like "Schedule" without cluttering the row UI with more buttons.

**Effort:** S-M (human: ~3-4 days) / with CC: S (~15-20 min)

**Depends on:** Ledger components (shipped). Individual actions mostly exist already — this is primarily a UI container.

**Context:** Added 2026-03-30. Implementation: a shared `TransactionContextMenu` component using a portal-based dropdown positioned at the cursor. Trigger on `onContextMenu` event on transaction rows. The menu should be keyboard-accessible (Escape to close, arrow keys to navigate). Consider: touch device support (long-press to trigger), and keeping the menu minimal at first — only include actions that are already implemented, add new ones as they ship.

---

## Completed

### SimpleFin Import: Manual Transaction Reconciliation & Transfer Dedup
**Completed:** v0.2.1.0 (2026-03-27)

Reconciliation matching links bank-imported transactions to existing manually-entered ones. Transfer dedup detects when the same transfer is imported from both sides and links them. "Bank-verified" badge in ledger. Match counts in sync results.
