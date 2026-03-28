# Changelog

All notable changes to this project will be documented in this file.

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
