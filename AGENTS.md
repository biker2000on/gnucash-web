# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

GnuCash Web is a Progressive Web App for managing GnuCash financial data. Built with Next.js 16, React 19, and TypeScript. It connects to a PostgreSQL database containing GnuCash data.

## Common Commands

```bash
npm install          # Install dependencies
npm run dev          # Start dev server at http://localhost:3000
npm run build        # Production build
npm run start        # Start production server
npm run lint         # Run ESLint
```

**Docker:**
```bash
docker build -t gnucash-web .
docker run -p 3000:3000 -e DATABASE_URL="..." gnucash-web
```

## Architecture

### App Router Structure (src/app/)

- `(main)/` - Route group containing primary pages
  - `accounts/page.tsx` - Account hierarchy tree view
  - `actions/page.tsx` - Financial Action Center with Fix/Decide/Do lanes, batch triage, mobile swipe actions, weekly close metrics, and calculation drill-through
  - `accounts/[guid]/page.tsx` - Individual account ledger with running balance
  - `ledger/page.tsx` - General ledger (all transactions)
  - `scheduled-transactions/page.tsx` - Scheduled transactions with execute/skip, enable/disable, batch mode, create new
  - `reports/contribution_summary/page.tsx` - Contribution report with IRS limit tracking
  - `reports/` - Reports dashboard with 16+ report types (balance sheet, P&L, portfolio, lots, tax harvesting, etc.)
  - `tools/` - Mortgage calculator, FIRE calculator, asset analysis, Farm & Apiary Analyzer (`farm-analyzer/` — 4-scenario farm formalization tax comparison)
  - `business/reports/schedule-f/page.tsx` - Schedule F farm report with apiary-aware keyword mapping and per-account override panel
  - `layout.tsx` - Main layout with sidebar navigation (note: `initializeDatabase()` runs via `docker-entrypoint.sh`/`db-init.js` in Docker or `scripts/dev-run-db-init.ts` in dev, not from the layout)
- `api/` - API route handlers
  - `accounts/` - Account hierarchy, account-specific transactions, preferences (retirement flag, cost basis)
  - `transactions/` - Paginated transaction listing with search/filter
  - `reports/` - Contribution summary, investment portfolio, tax harvesting, and other reports
  - `scheduled-transactions/` - Scheduled transaction listing, execute/skip/batch, create new, enable/disable
  - `contribution-limits/` - IRS contribution limit management
  - `contributions/` - Tax-year override per split
  - `tools/farm-analysis/` - Farm analyzer scenarios; `business/reports/schedule-f/` + `business/schedule-f/mappings/` - Schedule F report and mapping overrides

### Key Libraries (src/lib/)

- `db.ts` - PostgreSQL connection pool; `toDecimal()` converts GnuCash fraction-based numerics
- `db-init.ts` - Creates `account_hierarchy` view on app startup (recursive CTE)
- `gnucash.ts` - GnuCash utilities: fraction conversion (`toDecimal`, `toDecimalNumber`, `fromDecimal`), GUID generation, `findOrCreateAccount` for account hierarchy creation
- `lot-scrub.ts` - GnuCash-compatible lot scrub engine (sell splitting across lots, transfer lot linking, auto capital gains generation)
- `lot-assignment.ts` - Auto-assign algorithms (FIFO/LIFO/average) with scrub engine integration, scrub-all with topological ordering, revert support
- `lots.ts` - Lot querying and summary computation (realized/unrealized gains, holding periods, transfer metadata)
- `cost-basis.ts` - Cost basis tracing across account transfers with FIFO/LIFO/average allocation
- `types.ts` - Core TypeScript interfaces: Account, Transaction, Split
- `format.ts` - Currency formatting utility
- `scheduled-transactions.ts` - Shared utility: `resolveTemplateSplits()`, GnuCash date parsing
- `recurrence.ts` - Recurrence computation engine (9 period types, weekend adjustment, month-end clamping)
- `tax/farm-analysis.ts` - Farm formalization engine: 4-scenario comparison (unreported cash, hobby, Schedule F, Schedule F + NC LLC) with SE tax, QBI, and §179 modeling
- `tax/nc-farm-rules.ts` - NC farm rules: qualifying-farmer sales-tax exemption ($10k threshold), present-use value hints, LLC formation/annual-report fees
- `tax/farm-book-data.ts` - Pulls and annualizes farm income/expense actuals from user-selected account subtrees
- `business/schedule-f.ts` / `schedule-f-mappings.ts` / `schedule-f-report.ts` - Schedule F line classification (apiary-aware keyword mapper + manual overrides in the lazily-created `gnucash_web_schedule_f_mappings` table) and report generation
- `book-templates.ts` - Chart-of-accounts templates per entity type, including the Schedule F-aligned farm template for books with `business_activity = 'farm'`
- `financial-actions/` - Shared action contracts, source adapters, deterministic eight-pack Opportunity Engine, durable state store, refresh throttling, and lazy schema
- `provenance.ts` - Stable calculation trace IDs, bounded trace persistence, retrieval, and evidence-manifest support

### Reports (src/lib/reports/)

- `contribution-summary.ts` - Contribution report generator: batch SQL query, classification, IRS limits
- `contribution-classifier.ts` - Classifies deposits as contribution/transfer/employer match/dividend/fee
- `irs-limits.ts` - IRS contribution limit defaults (2024-2026) with DB overrides and catch-up calculation

### Services (src/lib/services/)

- `scheduled-tx-execute.ts` - Execute/skip/batch scheduled transaction occurrences with SELECT FOR UPDATE locking
- `scheduled-tx-create.ts` - Create new scheduled transactions with full GnuCash template structure
- `mortgage.service.ts` - Mortgage detection (Newton-Raphson rate extraction) and dynamic payment computation
- `account.service.ts` - Account CRUD with notes, tax_related, retirement, reparenting support
- `financial-summary.service.ts` - Net worth, savings rate, investment value aggregation

### Components (src/components/)

- `AccountHierarchy.tsx` - Expandable tree with sorting, filtering, localStorage state persistence
- `AccountLedger.tsx` - Per-account transactions with running balance, infinite scroll
- `TransactionJournal.tsx` - All transactions with infinite scroll, debounced search
- `reports/ContributionTable.tsx` - Contribution report with expandable per-account drill-down and tax-year editing
- `reports/ContributionLimitBar.tsx` - IRS limit progress bar with color-coded thresholds
- `scheduled-transactions/CreateScheduledPanel.tsx` - Slide-over form for creating new scheduled transactions
- `provenance/ProvenanceModal.tsx` - Shared “Explain this number” drill-through for formulas, steps, assumptions, warnings, and source evidence

## Key Technical Details

- **Database**: PostgreSQL with GnuCash schema. The `account_hierarchy` view is auto-created on startup.
- **Numeric Handling**: GnuCash stores amounts as fractions. Use `toDecimal()` from `db.ts` for conversion.
- **UI State**: AccountHierarchy persists expansion, sorting, and visibility toggles to localStorage.
- **Infinite Scroll**: TransactionJournal and AccountLedger use IntersectionObserver.
- **Path Alias**: `@/*` resolves to `./src/*` (configured in tsconfig.json).

## Environment Variables

Required in `.env.local` (see `.env.example` for all options):
```
DATABASE_URL=postgresql://user:password@host:port/database
NEXTAUTH_SECRET=<generate with: openssl rand -base64 32>
REDIS_URL=redis://localhost:6379
```

Optional AI, S3 storage, and other variables documented in `.env.example`.

## Testing

Vitest is configured with jsdom environment and v8 coverage.

```bash
npx vitest              # Run tests in watch mode
npx vitest run          # Run tests once
npx vitest --coverage   # Run with coverage report
```

**Config:** `vitest.config.ts` — uses `@vitejs/plugin-react`, `vite-tsconfig-paths`, jsdom environment.

**Test locations:**
- `src/__tests__/` — smoke tests, setup files
- `src/lib/__tests__/` — unit tests for library modules (e.g., `numeric.test.ts`, `lot-scrub.test.ts`)
- `src/lib/services/__tests__/` — service layer tests
- Module-local `__tests__/` folders (e.g., `src/lib/tax/__tests__/`, `src/lib/business/__tests__/`)

**Conventions:**
- Test files use `*.test.ts` or `*.spec.ts` suffix
- Setup file at `src/__tests__/setup.ts` (mocks localStorage, IntersectionObserver, BigInt serialization)
- Path aliases (`@/*`) work in tests via `vite-tsconfig-paths`


## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
