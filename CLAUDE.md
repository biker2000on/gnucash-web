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

No testing framework is currently configured.
