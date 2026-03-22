# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GnuCash Web is a read-only Progressive Web App for viewing GnuCash financial data. Built with Next.js 16, React 19, and TypeScript. It connects to a PostgreSQL database containing GnuCash data.

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
  - `layout.tsx` - Main layout with sidebar navigation, calls `initializeDatabase()`
- `api/` - API route handlers
  - `accounts/` - Account hierarchy and account-specific transactions
  - `transactions/` - Paginated transaction listing with search/filter

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

### Components (src/components/)

- `AccountHierarchy.tsx` - Expandable tree with sorting, filtering, localStorage state persistence
- `AccountLedger.tsx` - Per-account transactions with running balance, infinite scroll
- `TransactionJournal.tsx` - All transactions with infinite scroll, debounced search

## Key Technical Details

- **Database**: PostgreSQL with GnuCash schema. The `account_hierarchy` view is auto-created on startup.
- **Numeric Handling**: GnuCash stores amounts as fractions. Use `toDecimal()` from `db.ts` for conversion.
- **UI State**: AccountHierarchy persists expansion, sorting, and visibility toggles to localStorage.
- **Infinite Scroll**: TransactionJournal and AccountLedger use IntersectionObserver.
- **Path Alias**: `@/*` resolves to `./src/*` (configured in tsconfig.json).

## Environment Variables

Required in `.env.local`:
```
DATABASE_URL=postgresql://user:password@host:port/database
```

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
