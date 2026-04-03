# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
  - `accounts/[guid]/page.tsx` - Individual account ledger with running balance
  - `ledger/page.tsx` - General ledger (all transactions)
  - `scheduled-transactions/page.tsx` - Scheduled transactions with execute/skip, enable/disable, batch mode, create new
  - `reports/contribution_summary/page.tsx` - Contribution report with IRS limit tracking
  - `reports/` - Reports dashboard with 16+ report types (balance sheet, P&L, portfolio, lots, tax harvesting, etc.)
  - `tools/` - Mortgage calculator, FIRE calculator, asset analysis
  - `layout.tsx` - Main layout with sidebar navigation, calls `initializeDatabase()`
- `api/` - API route handlers
  - `accounts/` - Account hierarchy, account-specific transactions, preferences (retirement flag, cost basis)
  - `transactions/` - Paginated transaction listing with search/filter
  - `reports/` - Contribution summary, investment portfolio, tax harvesting, and other reports
  - `scheduled-transactions/` - Scheduled transaction listing, execute/skip/batch, create new, enable/disable
  - `contribution-limits/` - IRS contribution limit management
  - `contributions/` - Tax-year override per split

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

**Conventions:**
- Test files use `*.test.ts` or `*.spec.ts` suffix
- Setup file at `src/__tests__/setup.ts` (mocks localStorage, IntersectionObserver, BigInt serialization)
- Path aliases (`@/*`) work in tests via `vite-tsconfig-paths`

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
