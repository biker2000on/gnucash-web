# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## [0.17.0.0] - 2026-07-23

### Added
- Existing books can now receive the complete Schedule F chart through an idempotent, type-aware farm-account graft.
- E-595QF and E-595CF certificates now carry issue, expiry, and return-copy dates in Documents; their obligations appear in the Action Center and compliance calendar/iCal feed.
- The Farm Analyzer now evaluates North Carolina's preceding-year OR three-preceding-year-average qualifying-farmer test from book history.

### Fixed
- Farm Analyzer configuration is now shared per book and protected by atomic singleton upserts and partial unique indexes; account-associated multi-instance tool configs remain supported.
- Farm Analyzer and Schedule F totals now convert foreign transaction values into the book currency at historical posting-date rates and fail clearly when a required rate is missing.
- Farm and S-corp analysis now share one tested household-income annualization and exclusion calculation.

### Changed
- Other singleton tool settings now use race-safe upserts, and startup removes legacy duplicate configuration rows.
- The farm correctness and reliability backlog is marked delivered.

## [0.16.0.0] - 2026-07-23

### Added
- Added the Financial Action Center: one keyboard- and mobile-friendly Fix / Decide / Do inbox fed by transaction review, receipts, statements, Data Health, insights, compliance, business close, failed jobs, and notifications.
- Added eight deterministic “Next Best Dollar” opportunity packs with inspectable value ranges, urgency, confidence, liquidity, reversibility, goal alignment, evidence, and outcome tracking.
- Added Universal Financial Provenance with stable calculation traces, “Explain this number” drill-through, stale-price warnings, per-book verified-through dates, retained decision snapshots, and an exportable evidence manifest.
- Added trace metadata to dashboard KPIs, account balances, estimated-tax results, and cash-flow forecasts.

### Changed
- Action detection is persisted and refreshed on a bounded five-minute cadence, with explicit refresh throttling and atomic, serialized materialization.
- P0 roadmap items are marked delivered and the next roadmap sequence now starts with the Money Timeline and Living Plan.

### Removed
- Removed the incomplete Amazon order-history importer, its dedicated APIs, parser/matching pipeline, database models, and stale product references.

## [0.15.0.1] - 2026-07-22

### Fixed
- SimpleFin syncs now request only what they need: the fetch window starts 7 days before the oldest account's last sync (90 days only for never-synced accounts) instead of always requesting ≥90 days. Keeps the new 2-hourly syncs inside SimpleFin's recommended 45-day range and stops the per-sync "range exceeds recommended" warning seen in the prod worker logs.

## [0.15.0.0] - 2026-07-22

### Added — Live job progress
- **Server work now reports back**: clicking Sync on SimpleFin (and other long-running actions — scrub all lots, index backfill, thumbnail regeneration, price refresh) streams live progress to the browser over SSE. A floating progress card shows per-step status ("Syncing Checking (3/7) — 42 imported so far") and finishes with a toast summarizing the result; the SimpleFin card on the Connections page shows the same progress inline and now populates its results panel even when the sync runs on the background worker.
- Failures surface as error toasts with the actual reason instead of silently landing in the notification bell; a polling fallback covers dropped connections, so a sync's outcome always reaches the page.

### Added — More frequent SimpleFin sync
- **SimpleFin syncs on its own schedule** — every 2 hours by default, configurable from 1 hour to daily in Settings → Schedules — instead of once a day with the evening price refresh. Late-posting bank transactions now land the same day. Scheduled runs are silent (no toasts) and only notify on failure; concurrent syncs of the same connection are guarded against double-importing.

### Fixed
- Notification/job SSE streams no longer leak their Redis subscription and heartbeat when a browser disconnects abruptly.
- "Run now" keeps refreshing prices and syncing SimpleFin together in both deployment modes.

## [0.14.1.0] - 2026-07-22

### Fixed — Tax-advantaged accounts
- **Form 8949 / Capital Gains report no longer includes retirement accounts**: sales inside 401k/IRA/HSA (and accounts mapped 'exclude' in the tax estimator) are now filtered out of the report, the CSV export, the 1099-B reconciliation, and the Year-End Tax Package — matching the Schedule D numbers the tax estimator already computed correctly.
- **Tax-Loss Harvesting no longer offers retirement lots as candidates** (losses inside tax-advantaged accounts aren't deductible). Wash-sale detection still deliberately spans all accounts, since an IRA repurchase can wash a taxable loss.
- **Tax Schedule / TXF export** gains the same sheltered-income guard as the tax estimator: dividends or interest earned inside a retirement account that credit a shared income account no longer appear on the schedule.

### Fixed — Compliance calendar
- **Deadlines now roll to the next business day** the way the IRS actually schedules them (IRC §7503): weekend and federal-holiday due dates move forward, including observed holidays and the DC Emancipation Day quirk (e.g. Sat Apr 15, 2028 correctly becomes Tue Apr 18). Previously the calendar only added a note while keeping the weekend date.

## [0.14.0.0] - 2026-07-22

### Added — Farm & Apiary
- **Farm & Apiary Analyzer** (/tools/farm-analyzer): decide whether to formalize a home farm — compares four ways of handling farm income side by side: unreported cash (shown for honesty, clearly flagged as not legal and never recommended), hobby reporting, Schedule F sole proprietorship, and Schedule F + NC LLC. Pulls your actual income and expenses from farm account subtrees you pick in your book, annualizes them, and models self-employment tax, QBI, §179 equipment expensing (with the wage-inclusive business-income limit), the NC qualifying-farmer sales-tax exemption ($10k threshold, conditional E-595CF path with clawback warnings), present-use value property-tax hints, and LLC formation/annual-report fees. The headline insight: a single-member LLC changes nothing about taxes — it buys liability protection for $125 + $200/yr.
- **Farm business activity**: label a sole proprietorship or LLC book as a "Farm or ranch" (Settings → entity profile, or at book creation). Farm-labeled books get a Schedule F-aligned chart of accounts (Honey Sales, Pollination Services, Feed & Syrup, Mite Treatments, Jars & Packaging, hives and equipment assets) instead of the generic business template.
- **Schedule F report** (/business/reports/schedule-f): farm income and expenses mapped onto IRS Schedule F lines with an apiary-aware keyword mapper (feed→16, treatments→31, jars→28, fuel→19…) and a per-account manual override panel. On a household book it scopes itself to the farm accounts selected in the analyzer.
- **Farm compliance deadlines**: farm-labeled books add the farmer estimated-tax options (March 1 file-and-pay, single Jan 15 payment) plus NC present-use value listing period and E-595QF certificate upkeep to the compliance calendar, reminders, and iCal feed.

### Fixed
- Business decision tools (S-Corp Analyzer and the new Farm Analyzer) no longer aggregate a linked household book's income for users who only have access to the business book.
- Schedule C/F mapping storage retries table creation after a transient database failure instead of failing until restart, and Schedule F mapping batches now save atomically.

### Changed
- The entity profile gains a business-activity field ('general' or 'farm') — additive column, no migration needed on existing books.

### Added — Home Inventory
- **Photos-first walk-through mode**: a "Photos only" / "Detail each" toggle in the room-by-room stepper (choice persists per browser). In photos-only mode you snap photos for each item (item + serial label group into one) and save it as an un-named draft — no typing — then move room to room. The recap flags how many items still need details.
- **Bulk detailing on the desktop**: the inventory page shows a "N items captured without details" banner that opens a room-grouped list of every draft, each with its photos beside inline fields (name, category, value, purchased, warranty, serial, room). "Save & file" names the item and drops it from the list; the count updates live.

### Changed
- A home inventory item can now be created without a name (a "draft"); the existing detail-as-you-go flow is unchanged. New `GET /api/home/items?draft=1` returns the un-detailed work list, and the home summary reports a `draftItems` count. No database migration required — a draft is simply an item with a blank name.

## [0.13.1.0] - 2026-07-17

### Added — Home Inventory
- **Multiple photos per item**: home inventory items now hold a photo gallery instead of a single image — capture the item plus its serial-number label in one pass. New `gnucash_web_home_item_photos` table (one row per photo, FK-cascade to the item) with a one-time backfill of the legacy single photo; new `POST /api/home/items/[id]/photos` and `GET`/`DELETE /api/home/items/[id]/photos/[photoId]` endpoints. The walk-through and room detail forms accept multiple files; the room detail view shows a per-item gallery with per-photo removal and a count badge on the list thumbnail.
- **Walk-through back navigation**: the room-by-room capture stepper gains a "← Previous room" button next to "Next room", so you can move in both directions (flushing any pending item entry before stepping).

### Changed
- Book deletion now cleans up per-photo storage files and rows via the new photos table.

## [0.13.0.0] - 2026-07-12

### Changed — Unification
- **Task-oriented navigation**: the sidebar regroups by life domain — Home, Money, Budgets & Goals, Investments, Taxes, Planning, Reports, Business, Settings — driven by a new single-source feature registry
- **Domain hubs**: /money, /taxes, and /planning are curated landing pages with stats and task-grouped feature cards, replacing the flat Tools/Reports card walls as entry points
- **Command palette upgrades**: entries derive from the registry, descriptions are searchable ("raise cash" finds the Sell Planner), recently used commands lead when opened, and a visible Search button in the sidebar opens it for mouse users
- **Feature Catalog** (/catalog): the searchable everything-directory with star pinning — pinned features appear in a Pinned sidebar group
- **Related links**: cross-link strips on key pages (8949 ↔ Sell Planner, budgets → Budget Income Statement, FIRE → Drawdown/Scenario, digest → Year in Review, holdings → rebalancing/lots)

### Added
- **iCal calendar feeds**: subscribe Google/Apple Calendar to tokenized feeds of upcoming scheduled transactions, bond maturities/coupons, and RMD deadlines
- **Price alerts**: per-commodity above/below thresholds checked after each daily price refresh, delivered through notifications/email/webhooks
- **Email-in ingestion**: forward receipts, statements, or payslips to an IMAP mailbox (INGEST_IMAP_*); the worker polls every 15 minutes with a sender allowlist and Message-ID dedupe, feeding the existing extraction pipelines
- **Accountant share links**: admin-created, time-boxed public URLs rendering a self-contained read-only report document — no app access, secret shown once, view counting
- **Time Machine** (/tools/time-machine): the whole book as of any date, with historical security prices and a two-date compare mode
- **Document Search** (/search): one query across receipt OCR text, statement lines, payslips, and transactions with highlighted snippets
- **FX Revaluation report**: foreign-currency holdings with average acquisition rates and unrealized/realized FX gains
- **Spending vs National Averages**: your categories against approximate BLS Consumer Expenditure Survey figures for your household size

## [0.12.0.0] - 2026-07-12

### Added
- **Sell Planner**: raise a target amount of cash tax-optimally — losses harvested first with wash-sale screening (incl. IRA buys per Rev. Rul. 2008-5), long-term gains by gain-per-dollar, partial final lots landing exactly on target, incremental federal+state tax via the real engine, and side-by-side savings vs naive FIFO and long-term-only plans
- **Net-Worth Attribution**: any period's change decomposed into savings, market gains, debt paydown, and an honest residual — cents-exact by construction — with waterfall summary, monthly stacked chart, and drill-downs
- **Year in Review**: the annual wrapped — net worth arc, savings rate, top categories with YoY deltas, dividends, best/worst holding, taxes paid, subscription changes, streaks
- **Scenario Sandbox**: one what-if (e.g. the Buy-a-House template) threaded through cash flow, 30-year net worth, current+next-year taxes (itemize-vs-standard decided), and FIRE date, side by side with baseline
- **Report Schedules**: email any saved report weekly/monthly/quarterly (HTML + CSV, idempotent per period), checked daily by the worker; plus global print stylesheets for clean PDFs from any page
- **API tokens & webhooks**: hashed personal access tokens (Bearer gcw_…) with live role capping, and HMAC-signed outbound webhooks on notifications with SSRF guards — docs in docs/api-tokens.md
- **Opt-in TOTP two-factor auth**: RFC 6238 with encrypted secrets and single-use recovery codes; strictly opt-in — nothing changes for un-enrolled users, OIDC untouched
- **In Case of Emergency**: per-account beneficiary/institution/contact metadata assembled into a printable, grouped account map with book-level instructions
- **Fixed Income ladder**: bonds/CDs/treasuries with Newton-solved YTM, per-year maturity ladder, weighted averages, 12-month maturity calendar, and coupon estimates
- **AI additions**: natural-language quick-add ("$40 gas yesterday" → prefilled entry), a factual narrative paragraph atop the monthly digest, and daily proactive insight cards (category spikes, first-time merchants, savings-rate drops, net-worth milestones, cash drops) on the dashboard

## [0.11.0.0] - 2026-07-12

Closes every "worth building" gap from the GnuCash desktop parity audit
(docs/gnucash-desktop-parity-2026-07.md).

### Added
- **Tax Schedule Report + TXF export**: tax-relevant accounts grouped by TXF code and IRS form (1040, Schedules A–E) with per-account drill-down, a per-account TXF override mapper, and a downloadable TXF V042 file for TurboTax/TaxCut import
- **Budget Income Statement**: budget-vs-actual P&L over any period range with favorable/unfavorable variances, % of budget, rollup subtotals, per-period barchart, and CSV export; **Budget Balance Sheet**: projected end-of-period balances (opening + budgeted flows) with an actual-basis comparison column
- **Close Book**: year-end closing entries that zero income/expense into a chosen equity account (per currency, cumulative-through-date so re-closing is safe), fully previewed and undoable via History
- **Account Breakdown**: one parameterized pie/bar report replacing desktop's eight account chart reports — type tabs, depth 1–4, click-to-drill with breadcrumbs, Other bucket
- **Price History** chart for any commodity's stored quotes with source badges; **Income & Expenses by Day of Week**; **Average Balance** (monthly average/min/max/ending daily balances)
- **Customer Summary**: per-customer sales, expenses, profit, and markup %
- **Jobs**: management UI (owner, desktop-compatible rate slot, deactivate) with per-job invoice rollup report
- **Employees & expense vouchers**: employee CRUD plus vouchers posted through the native invoice engine (A/P credit, expense debits, gncExpVoucher numbering) with reimbursement via the standard payment path and an Employee Report
- **Manual reconcile window**: reconcile any account against a statement ending balance — tick splits, exact integer-cents difference, server-verified tie-out before marking splits reconciled
- **QIF import**: Quicken files (bank/cash/card/asset/liability, multi-account, splits, categories) with transfer pairing, duplicate detection, category mapping overrides, and a preview-first flow

## [0.10.0.0] - 2026-07-12

### Added
- **Command palette (Ctrl+K)**: fuzzy search across actions (new transaction, switch book/account, help), every page, all reports, tools, and business pages, plus live account matches and transaction search with amount/date context
- **Ask Your Books**: chat at /tools/ask answers plain-English questions ("how much did we spend on restaurants in Q1?") via guard-railed, read-only SQL generated by the configured AI provider — single-SELECT-only validation, mandatory book scoping, LIMIT caps, 5s statement timeout, collapsible SQL, result tables, and drill-down links
- **Drawdown & Roth Conversion Planner**: year-by-year retirement spend-down at /tools/drawdown — withdrawal sequencing, SECURE 2.0 RMDs (Uniform Lifetime Table), bracket-filling Roth conversions solved exactly to the bracket top, annual federal+state tax via the tax engine, IRMAA tier warnings, depletion detection, conversions on/off comparison, and book-prefilled balances + Social Security
- **Equity compensation (RSU/ESPP)**: post vest events (FMV basis on net shares, gross value as W-2 income, sell-to-cover withholding) and ESPP purchases (FMV basis with the discount as ordinary income) as balanced GnuCash transactions with live split preview and history — the 8949 double-taxation trap avoided by construction
- **Schedule E (rental property)**: per-property income/expense rollups mapped to Schedule E lines with manual overrides, straight-line depreciation (27.5/39-year, mid-month convention), combined summary, and a property manager — works on household books
- **Year-End Tax Package**: one ZIP from /reports/tax-package with Form 8949 + Schedule D CSVs, contribution summary with IRS limit usage, Schedule C (when applicable), a new charitable-giving (Schedule A) detail report with $250+ acknowledgment flags, withholding snapshot, and a README manifest
- **Email notifications**: any notification (monthly digest, budget overspend, anomalies, low balances, reorders, bank-sync status) can be emailed via SMTP_* env config, with per-user opt-in, minimum severity, and per-type filters in Settings
- **Nightly book backups**: every book exported to desktop-compatible compressed GnuCash XML at 02:30 UTC through the storage backend (filesystem/S3) with retention (BACKUP_RETENTION, default 30), plus Settings list/download/delete and Run-now
- **Change history with undo**: full before/after snapshots on transaction mutations enable Restore (deleted), Revert (updated), and Delete (created) from Settings > History; audit coverage extended to accounts; every undo is itself audited
- **Bulk transaction editing**: ledger edit mode gains Edit description (set or find-and-replace), Recategorize (safe counter-split selection with per-row skip reasons), and bulk Tags
- **Retroactive categorization rules**: per-rule "Apply to history" with dry-run preview, date range, only-uncategorized (Imbalance/Orphan) toggle, and 500-per-batch application
- **Quick Add (mobile/offline)**: thumb-first capture at /quick-add with keypad entry, recent categories, and an IndexedDB offline queue that syncs idempotently on reconnect; PWA shortcut included

### Fixed
- **Realized gain/loss rows in the investment ledger rendered blank**: lot-close gains transactions (zero-share, income-offset) now classify as their own type, showing the signed gain in the Buy/Sell columns and on mobile cards with a Realized G/L badge; return-of-capital detection tightened to the GnuCash shape
- Audited the legacy lot-scrub sell-splitting sign corruption: prod is clean; dev retains 598 corrupted sub-splits with a ready repair script (`scripts/fix-lot-scrub-sign-corruption.ts`)

## [0.9.4.0] - 2026-07-11

### Fixed
- **Account performance chart now includes closed positions and cash**: the per-account chart resolved its accounts from *current* holdings, so any position since sold to zero (e.g. a fund liquidated in a 401k provider switch) had its entire history dropped — the pre-switch balance read far too low. The chart now resolves the selected account's full subtree server-side (every holding ever held under it, including closed ones) plus its cash balance, so historical value is complete and the line stays continuous through a rebalance (previously it cratered to ~$0 and broke TWR to −100%). Internal sell→cash→buy transfers net out of the return math, and the Account View "Total Value" includes cash to match.

## [0.9.3.0] - 2026-07-11

### Fixed
- **Account paths never include the root account**: the investments cash/portfolio views built paths from the book's top-level root account (e.g. `Root Account:Assets:…`); paths now start at the first real account, matching the rest of the app. Works regardless of the root's name.

### Data (prod + dev, not shipped in the image)
- **John Hancock "Industrial Insight 401k"**: its holdings were recorded under real tickers (VT, FSMDX) but priced in John Hancock *units* that differ from the market, which inflated the historical 401k balance (VT was ~4.8× overstated). Split these into separate JH-specific commodities (`JOHNHANCOCK` namespace) with market quoting disabled, and backfilled a daily price series = buy-derived ratio × the ticker's real market price. The real VT/FSMDX tickers are preserved for future use. Migration: `scripts/jh-401k-separate.mjs`.

## [0.9.2.0] - 2026-07-11

### Added
- **Cryptocurrency support**: crypto commodities are now handled as a distinct `CRYPTO` type/namespace (moved out of the misused `EUREX` namespace) with daily price quotes from Yahoo Finance via `{SYMBOL}-USD` pairs. Full historical prices backfilled from each holding's first transaction; ongoing daily refresh and the scheduled price job now include crypto automatically. Crypto is tagged sector "Crypto" for sector-exposure and rebalancing, `CRYPTO` is an offered commodity type in the editor, and symbol verification maps crypto to its Yahoo pair (so crypto rows verify correctly).

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
