# Changelog

All notable changes to this project will be documented in this file.

## [0.9.2.0] - 2026-07-11

### Added
- **Cryptocurrency support**: crypto commodities are now handled as a distinct `CRYPTO` asset class (moved out of the misused `EUREX` namespace) with daily price quotes from Yahoo Finance via `{SYMBOL}-USD` pairs. Full historical prices backfilled from each holding's first transaction; ongoing daily refresh and the scheduled price job now include crypto automatically. Crypto is tagged sector "Crypto" for sector-exposure and rebalancing.

### Fixed
- **Price precision**: stored price quotes now use 1e8 resolution instead of the currency's 1/100 fraction, so sub-cent assets (e.g. SiaCoin, IOST) no longer round to $0.00.
- **Settings**: the top four settings cards (Commodity Quotes, IRS Limits, Categorization Rules, household Inventory) now collapse like the rest of the page.

## [0.9.1.0] - 2026-07-10

### Added
- **Inventory**: receive stock against posted vendor bills (unit costs from the bill lines, no double-posting), reorder points with automatic low-stock alerts (after bank sync and on demand), per-item **FIFO valuation** option with layer-based COGS, a Stock Valuation report, and a **setting to enable inventory on household books** (standalone Inventory nav item)
- **Recurring invoices**: define from any invoice or bill ("Make recurring..."), cadence with month-end anchoring, optional auto-post, runs automatically after bank sync plus Run-now, atomic claim-first generation (no duplicates), notifications per generated document
- **Customer statements**: printable per-customer statement with opening/closing balance, chronological activity, running balance, and an aging footer
- **Statements**: OFX account auto-detection (ACCTID) with a per-book learned account map — re-uploads skip the account picker; assign-account flow for unmapped files; create a categorization rule directly from a reconcile missing line
- **Dashboard**: sparkline and bar chart custom widgets (monthly balance or spend series) and per-book dashboard layouts
## [0.9.0.0] - 2026-07-10

### Added
- **Inventory management** (business books): items/SKUs with book-wide moving-average-cost valuation, stock locations, receive/ship/adjust/transfer/return movements with negative-stock protection, bills of materials with assembly costing, optional balanced GnuCash ledger postings (inventory asset + COGS), and explicit invoice-line fulfillment that links sales to items and posts cost of goods sold — plus a full UI (items, item detail with stock by location and movement history, BOM editor and assemble, locations, invoice Fulfillment section)
- **Composable dashboard**: a searchable widget gallery to add/remove widgets (goals, budget pacing, AR/AP, dividends, subscriptions, data health, plus all existing charts), business-only widgets gated by entity type, and a custom widget builder — define stat widgets from the UI over account balances or trailing spend, evaluated book-scoped on the server
- **Sector-based rebalancing**: allocate by sector in addition to symbol, with fund exposure spread via sector weights, sector targets mapped back to per-symbol trades, and a sector-data backfill for holdings missing metadata
- **Three new reports**: Budget Report (budgeted vs actual per account with subtotals), Sales by Customer, and Expenses by Vendor (new Business Reports category)
- Dividends: TTM tooltips ("trailing twelve months") and per-security links to account ledgers

### Changed
- **Budgets overview** overhauled: sortable and filterable table with status pills (Active/Past/No amounts), resilient per-row progress, per-row action menus (scenario/compare for any budget), and a proper mobile card layout
- **KPI/stat cards are dramatically more compact on mobile** (shared StatCard/StatGrid across 12 pages, ~75% less vertical space on phones; desktop unchanged)
- Navigation: Receipts, Payslips, and Statements folded into one Uploads group; Inventory added to the Business group
## [0.8.0.0] - 2026-07-09

### Added
- **Statement Import & Reconcile**: upload a bank or credit-card statement (PDF, CSV, or OFX/QFX), parse it (deterministic CSV/OFX parsers, or the AI extraction core for PDF), and reconcile it against the ledger. The workspace auto-matches statement lines to existing transactions, lists transactions that are on the statement but missing from the ledger (each with a suggested category to review before adding) and ledger entries not on the statement, and enforces a balance tie-out to the statement's closing balance before finalizing a full GnuCash reconciliation (matched + newly-added splits marked reconciled). Available on any book — household or business.

### Fixed
- Sidebar: **Invoices** and **Bills** now highlight independently (they share a path and differ only by query string); the Business nav group also auto-expands on business routes
## [0.7.1.0] - 2026-07-09

### Added
- **Schedule C account mapper**: a dense mapping panel on the Schedule C report (mirroring the tax estimator's mapper) to manually assign expense accounts to Schedule C lines; manual overrides win over the keyword heuristic and the report re-totals live on save
- **Keyboard shortcut nav chords**: g u (Budgets), g o (Goals), g t (Tags), g w (Tools), g s (Settings)

### Changed
- **Keyboard shortcuts modal** is now a dense 2-3 column grid and is page-aware: shortcuts contributed by the current page group under a "This Page" heading shown first, and disappear when you navigate away
- **Entity settings section** adapts its labels to the entity type (Household / Business / Organization) instead of always reading "Household & entity"

### Fixed
- Switching a book's entity type to a business or nonprofit now reveals the Business navigation group immediately, without a page refresh
## [0.7.0.0] - 2026-07-08

### Added — Business (AR/AP, shown only for business-entity books)
- **Customers, vendors, jobs, bill terms, and tax tables**: full CRUD over the native GnuCash business tables with auto-numbering, deactivate-not-delete referential safety, and management pages under /business
- **Invoice & bill engine**: GnuCash-desktop-compatible posting (real transaction + A/R-A/P lot + gncInvoice slot frames + book counters), GnuCash's own discount/tax semantics (PRETAX/SAMETIME/POSTTAX, tax-included), unposting, and payments with FIFO or explicit allocation that close lots on full payment
- **Invoice & bill UI**: filterable list, draft line-item editor with live totals, post/unpost, payment modal with per-invoice allocation, payment center, and a clean printable document
- **Business reports**: AR/AP aging (current/30/60/90+ per owner), sales tax collected with monthly filing summary, Schedule C estimate for sole proprietors, and a business dashboard (revenue, outstanding AR, AP due, top customers, avg days-to-pay)
- **Business navigation group** in the sidebar, gated on the book's entity type — household books never see it

### Added — Budgets
- **Budget vs Actual**: per-account progress with pace marker, projected end-of-period overspend (on-track/warning/over), period stepping via [ ] keys, YoY comparison, and compact progress bars on the budget list
- **Envelope/rollover budgeting**: unspent amounts carry forward (deficits too), sinking funds, per-line settings for rollover/threshold/goal link
- **Overspend alerts**: threshold/over/projected alerts through the notification stream, scanned automatically after bank sync and on demand
- **Goal-linked budget lines**: link a budget category to a financial goal, with inline goal progress
- **Auto-budget wizard**: generate a budget from trailing history (median or mean), 50/30/20-style percent-of-income or zero-based templates, editable preview before creation
- **Budget scenarios**: duplicate any budget scaled by a factor (lean/stretch) and compare two budgets side by side
## [0.6.0.0] - 2026-07-08

### Added
- **Capital Gains — Form 8949 / Schedule D**: realized stock/fund sales bucketed into IRS 8949 boxes with Schedule D totals, wash-sale adjustments, CSV export in IRS column order, and 1099-B reconciliation (paste/upload broker rows to confirm basis). Flags rows whose implied per-share price is wildly inconsistent with the same security's other sales, so a corrupt underlying transaction can't silently produce a wrong number on the form.
- **Spending Watch (anomaly & fraud alerts)**: detects duplicate charges, first-time merchants, amount outliers, and category spikes; runs automatically on each SimpleFIN sync and delivers deduplicated alerts through the notification stream, plus an on-demand review page
- **Financial Goals tracker**: emergency-fund (N months of expenses), savings-target, and debt-payoff goals with completion dates projected through the cash-flow forecast and debt engines, on-track/behind badges, and a per-goal "$X/mo to hit your date" hint
- **Monthly Digest**: a month-at-a-glance summary (net-worth change, cash flow, top categories with month-over-month deltas, subscription changes, upcoming bills, budget status) viewable in-app and deliverable to notifications
- **Investment Benchmark comparison**: portfolio time-weighted return vs S&P 500 / Dow / NASDAQ / Russell 2000 over 1Y/3Y/5Y/YTD/max, with a growth-of-100 chart and a one-click index-price backfill when coverage is missing
- **Dividend Income tracking & calendar**: trailing-12-month and per-year totals, yield-on-cost and current yield per holding, a monthly income chart, and a forward payment calendar that projects active payers from trailing income (stopped securities excluded)
- **Data Health dashboard**: checks for unbalanced transactions, structural corruption, missing/stale prices, quote-flag drift, and unreconciled aging, rolled into a 0-100 health score with fix links
- **Withholding Checkup**: projects year-end federal tax from year-to-date data, flags under-withholding, and computes the safe-harbor target with the remaining quarterly 1040-ES estimate and a recommended per-paycheck adjustment

### Fixed
- Dividend forward projection tracked a security's single most-recent payment (overshooting trailing income ~3x) and projected securities that stopped paying years ago; it now anchors to trailing-12-month income and excludes inactive payers

## [0.5.0.0] - 2026-07-08

### Added
- **Cash Flow Forecast tool**: projects cash account balances 30/60/90/180 days forward from scheduled-transaction occurrences plus a 90-day historical daily run rate, with per-account chart lines, a warning threshold, low-balance alerts, and an upcoming-events table
- **Subscription detection tool**: finds recurring charges (weekly/monthly/quarterly/annual) from spending history with merchant normalization, price-increase tracking, stopped/new status, and monthly/annualized cost totals
- **Debt Payoff Planner**: snowball vs avalanche vs minimum-only comparison across all liability accounts with freed-minimum rollover, mortgage APR/payment prefill from saved mortgage configs, balance-over-time chart, per-debt payoff dates, and payment-too-low warnings
- **Portfolio Rebalancing**: per-symbol target allocations with drift bars and an absolute tolerance band, threshold rebalancing (only out-of-band holdings are traded), buy-only cash-flow mode for new money, and tax-aware sell ordering (losses first, then long-term gains) annotated from lot data
- **Auto-categorization rules engine**: user-defined contains/exact/regex rules checked ahead of the history-based guess during SimpleFIN sync (rule hits import as high confidence), with a Settings → Rules page offering learned suggestions from transaction history, one-click rule creation, and a description test box

### Fixed
- Imbalance-routed SimpleFIN imports are now stored with low confidence (previously mis-stored as medium)
- Credit-card accounts no longer flood the cash-flow-forecast low-balance warnings; the combined net-cash warning is preserved
- Debt payoff chart windows to the longest completed plan instead of stretching to the 100-year simulation cap when minimums never pay off
- `fetchScheduledTransactions` moved from the scheduled-transactions route into `src/lib/scheduled-transactions.ts`, fixing production builds after a dev session

## [0.4.0.0] - 2026-06-12

### Added
- **Monte Carlo FIRE Calculator**: seeded bootstrap simulation over the Damodaran 1928–2024 stock/bond/CPI dataset with 10/25/50/75/90 confidence bands, FI-age distribution, retirement-age success sensitivity, and a full assumptions panel (allocation + glide path, inflation mode, withdrawal strategy, retirement tax, healthcare bump, contribution growth, end age, simulation count)
- **Social Security estimation from book data**: SSA benefit formula (AWI indexing, top-35 years, AIME → PIA bend points, claiming ages 62–70) computed from W-2-mapped or salary-account earnings history, feeding the FIRE calculator as a data-driven default with override
- **Tax Estimator tool**: federal liability for 2024–2026 (brackets, standard/itemized with OBBBA SALT cap and senior deduction, LTCG/QDI stacking, SE tax, NIIT, Additional Medicare, safe-harbor 1040-ES schedule), pluggable state modules (no-tax, flat, CA/NY, flat-rate fallback), account→tax-category mapper with auto-suggestions, and side-by-side contribution scenarios validated against IRS limits
- **Account & transaction tagging**: global tags with colors, tag chips in ledgers and the account tree, context-menu tag editor, `/tags` management page, and `#tag` search syntax in the general ledger and account ledgers (account tags propagate to their transactions)
- **Optional OIDC login (Pocket ID or any OIDC provider)**: env-configured (`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`/`OIDC_PROVIDER_NAME`), PKCE S256, verified-email auto-link migrates existing manual accounts, explicit link/unlink in profile, OIDC-only users can set a password later
- **Granular roles**: readonly/edit/admin enforced on every mutating API route, per-book role management UI in Settings → Users with last-admin protection, read-only UX gating on ledgers, accounts, scheduled transactions, and tags

### Fixed
- Ledger deep links with a seeded search (e.g. `/ledger?search=%23tag`) now apply the filter on first load

## [0.3.0.0] - 2026-04-08

### Added
- **Amazon Order Import**: Upload Amazon order history (CSV or ZIP from "Request My Data" export) and match orders to existing credit card transactions with item-level splits
- Amazon CSV parser with ZIP extraction, supporting "Request My Data" and "Order History Reports" formats
- Order matching engine scores transactions by amount and date proximity
- Split generator with rounding absorber for balanced GnuCash transactions
- Category mapper with learned suggestions from prior imports
- Batch-based import flow: upload, review matches, confirm, and apply
- Searchable account picker (reuses existing AccountSelector) for credit card, tax, and shipping account selection
- Collapsible download instructions with direct links to Chrome extensions (Order History Reporter, Order Exporter, OrderPro) for instant export
- Amazon Import card on Tools hub page
- Database tables for import batches, Amazon orders, and category mappings
- 287 tests covering CSV parsing, matching, split generation, category mapping, and service layer

## [0.2.3.0] - 2026-03-28

### Added
- **Execute/skip scheduled transactions**: execute upcoming occurrences from the web UI, creating real GnuCash transactions from templates with proper GUID generation and fraction-based amounts. Skip advances metadata without creating a transaction.
- **"Since Last Run" batch mode**: contextual amber banner in the Upcoming view shows overdue count with a "Process All" button that batch-executes all overdue occurrences
- **Enable/disable toggle**: interactive toggle switch on each scheduled transaction row replaces the static enabled/disabled badge. Optimistic UI with rollback on failure.
- **Create new scheduled transactions**: slide-over panel with name, recurrence pattern (all 9 GnuCash period types), start/end dates, multi-split account picker, auto-create/notify options. Creates full GnuCash template structure (root account, child accounts, slot mappings, template transaction/splits, schedxaction, recurrence)
- **Mortgage dynamic amounts**: `MortgageService.computePaymentForDate()` computes principal/interest splits from current balance and detected rate for mortgage-linked scheduled transactions
- **Account editing modal**: notes, tax_related, retirement flags, reparenting support in account service
- Concurrency protection prevents double-execution when processing scheduled transactions from multiple tabs
- 18 new tests covering execute/skip, create, and mortgage payment computation

### Fixed
- Batch execute sent wrong field name (`scheduledTransactionGuid` instead of `guid`), causing "Process All" to always fail

## [0.2.2.0] - 2026-03-28

### Added
- **Contribution Summary report**: surfaces total contributions to retirement and brokerage accounts with per-account breakdowns, IRS contribution limit tracking with progress bars, and configurable grouping by calendar year or tax year
- **Contribution classification engine**: automatically categorizes deposits as contributions, employer match, rollovers/transfers, dividends, or fees based on the source account type, with hierarchy-aware retirement flag inheritance
- **IRS contribution limits service**: hardcoded defaults for 2024-2026 (401k, IRA, Roth IRA, HSA, 403b, 457) with user-editable overrides via database table, catch-up contribution support using birth date from user profile
- **Retirement account toggle**: investment accounts (STOCK, MUTUAL, ASSET, BANK) can be flagged as retirement accounts with a type selector (401k, IRA, Roth IRA, HSA, etc.) in the account detail page
- **Tax-year attribution**: per-transaction tax year overrides for prior-year contributions, with inline editing in the report and a backfill script for historical data
- **Tax-year backfill script** (`scripts/backfill-tax-year.ts`): parses transaction descriptions for year indicators and sets tax-year overrides for historical prior-year contributions
- API endpoints: `GET/PUT /api/contribution-limits`, `PUT/DELETE /api/contributions/[splitGuid]/tax-year`, `GET /api/reports/contribution-summary`
- 36 new tests (IRS limits: 12, contribution classifier: 13, report generator: 11)

### Fixed
- Floating-point drift in financial summation replaced with integer-cent accumulation
- Birthday read server-side to avoid PII in query parameters
- Account preferences COALESCE pattern replaced with CASE WHEN to allow clearing retirement_account_type to null
- Contribution limits PUT endpoint now validates account type, numeric ranges
- Tax-year override route now checks book scope (isAccountInActiveBook)
- Retirement account query scoped to active book, O(n) array lookup replaced with Set

## [0.2.1.0] - 2026-03-27

### Added
- SimpleFin reconciliation matching: automatically links bank-imported transactions to existing manually-entered ones based on amount, date proximity, and description similarity
- Transfer dedup matching: detects when the same transfer is imported from both sides (e.g., checking → savings) and links them instead of creating duplicates
- "Bank-verified" badge on reconciled transactions in the account ledger
- Match count display in sync results (reconciled + deduplicated)
- Schema migration: `match_type`, `match_confidence`, `matched_at`, `simplefin_transaction_id_2` columns on transaction meta

### Changed
- Project description updated from "read-only" to reflect current read-write capabilities

### Fixed
- Currency precision: matching now uses account's `commodity_scu` instead of hardcoded precision=2, supporting JPY, KWD, and other non-standard currencies
- Transfer dedup restricted to 2-split transactions only, preventing incorrect split selection on multi-split transactions
- Match writes wrapped in database transactions for atomicity
- Removed split mutation from transfer dedup (no longer rewrites `splits.account_guid`)

## [0.2.0.0] - 2026-03-22

### Added
- Receipt attachment and management system with upload, view, search, and OCR
- Drag-and-drop and mobile camera capture for receipt uploads
- Receipt gallery page (`/receipts`) with thumbnail grid, search, and filters
- Paperclip receipt indicator on transaction rows in ledger views
- Combined view/upload receipt modal with multi-receipt carousel
- Storage backend abstraction supporting filesystem (default) and S3/MinIO
- Thumbnail generation via sharp for uploaded images and PDF placeholder
- BullMQ OCR job with Tesseract auto-detection (system binary or WASM fallback)
- API endpoints: upload, serve, delete, link/unlink, list/search, thumbnails
- Receipt counts in transaction and account ledger queries
- Tesseract OCR in Docker image for production receipt text extraction
- Swap button to reverse From/To accounts in transaction form
- Mobile date input with native calendar picker and +/- buttons

### Fixed
- Swap button arrow orientation for mobile/desktop layouts
- FIFO/LIFO/Average dropdown styling alignment with investment page selects
- AutoAssignDialog rendering via portal to escape overflow-clip container
