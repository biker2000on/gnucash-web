# Codebase Structure

**Analysis Date:** 2026-01-14

## Directory Layout

```
gnucash-web/
├── src/                    # Source code
│   ├── app/               # Next.js App Router
│   │   ├── (main)/       # Main route group with sidebar layout
│   │   ├── api/          # API route handlers
│   │   └── docs/         # Swagger documentation page
│   ├── components/        # React components
│   │   ├── ui/           # Generic UI components (Modal, etc.)
│   │   └── filters/      # Filter components
│   ├── hooks/            # Custom React hooks
│   └── lib/              # Shared utilities and types
├── public/               # Static assets
├── .planning/            # Planning documentation
├── next.config.ts        # Next.js configuration
├── tsconfig.json         # TypeScript configuration
├── Dockerfile            # Container build
└── package.json          # Project manifest
```

## Directory Purposes

**src/app/**
- Purpose: Next.js App Router pages and API routes
- Contains: Page components, layouts, API route handlers
- Key files: `layout.tsx` (root), `(main)/layout.tsx` (main layout with sidebar)
- Subdirectories: `(main)/` (pages), `api/` (REST endpoints), `docs/` (Swagger UI)

**src/app/(main)/**
- Purpose: Main application pages with shared layout
- Contains: Account hierarchy, ledger, individual account pages
- Key files: `accounts/page.tsx`, `ledger/page.tsx`, `accounts/[guid]/page.tsx`
- Subdirectories: `accounts/`, `ledger/`

**src/app/api/**
- Purpose: REST API endpoints
- Contains: Route handlers for CRUD operations
- Key files: `accounts/route.ts`, `transactions/route.ts`
- Subdirectories: `accounts/`, `transactions/`, `splits/`, `commodities/`, `docs/`

**src/components/**
- Purpose: Reusable React components
- Contains: UI components, view components, modals
- Key files: `AccountHierarchy.tsx`, `AccountLedger.tsx`, `TransactionJournal.tsx`
- Subdirectories: `ui/` (generic), `filters/` (filter components)

**src/components/ui/**
- Purpose: Generic, reusable UI primitives
- Contains: Modal, AccountSelector, DateRangePicker
- Key files: `Modal.tsx`, `AccountSelector.tsx`, `DateRangePicker.tsx`

**src/components/filters/**
- Purpose: Transaction filter components
- Contains: Filter panel and individual filter controls
- Key files: `FilterPanel.tsx`, `AccountTypeFilter.tsx`, `AmountFilter.tsx`, `ReconcileFilter.tsx`
- Barrel export: `index.ts`

**src/hooks/**
- Purpose: Custom React hooks
- Contains: Reusable hook logic
- Key files: `useDateFilter.ts`

**src/lib/**
- Purpose: Shared utilities, types, database access
- Contains: Type definitions, helpers, validation
- Key files: `db.ts`, `types.ts`, `validation.ts`, `format.ts`, `db-init.ts`, `guid.ts`, `datePresets.ts`

## Key File Locations

**Entry Points:**
- `src/app/layout.tsx` - Root layout (fonts, global styles)
- `src/app/(main)/layout.tsx` - Main layout (sidebar, database init)
- `src/app/(main)/page.tsx` - Home page redirect

**Configuration:**
- `tsconfig.json` - TypeScript config with `@/*` path alias
- `next.config.ts` - Next.js configuration
- `eslint.config.mjs` - ESLint configuration
- `postcss.config.mjs` - PostCSS/Tailwind configuration
- `Dockerfile` - Docker build configuration

**Core Logic:**
- `src/lib/db.ts` - Database connection pool, query helper, toDecimal
- `src/lib/db-init.ts` - Database schema initialization (account_hierarchy view)
- `src/lib/types.ts` - TypeScript interfaces for domain objects
- `src/lib/validation.ts` - Transaction validation logic

**API Routes:**
- `src/app/api/accounts/route.ts` - Account hierarchy endpoint
- `src/app/api/accounts/[guid]/transactions/route.ts` - Account ledger endpoint
- `src/app/api/transactions/route.ts` - Transaction list and create
- `src/app/api/transactions/[guid]/route.ts` - Transaction detail, update, delete
- `src/app/api/splits/bulk/reconcile/route.ts` - Bulk reconciliation

**Testing:**
- No test files present (no testing framework configured)

**Documentation:**
- `CLAUDE.md` - Development instructions for AI assistants
- `src/app/docs/page.tsx` - Swagger UI documentation page
- `src/lib/swagger.ts` - Swagger/OpenAPI configuration
- `src/app/api/docs/route.ts` - Swagger JSON endpoint

## Naming Conventions

**Files:**
- PascalCase.tsx for React components (`AccountHierarchy.tsx`, `TransactionModal.tsx`)
- camelCase.ts for utilities and hooks (`db.ts`, `useDateFilter.ts`)
- kebab-case for directories (`date-filter/` if existed)
- route.ts for API route handlers

**Directories:**
- lowercase for all directories (`components`, `lib`, `hooks`)
- Bracketed for dynamic routes (`[guid]`)
- Parenthesized for route groups (`(main)`)

**Special Patterns:**
- `index.ts` for barrel exports (`src/components/filters/index.ts`)
- `route.ts` for Next.js API routes
- `page.tsx` for Next.js pages
- `layout.tsx` for Next.js layouts

## Where to Add New Code

**New Feature:**
- Primary code: `src/components/` for UI, `src/lib/` for logic
- API endpoint: `src/app/api/{resource}/route.ts`
- Tests: Not applicable (no testing framework)
- Config if needed: Project root

**New Component:**
- Implementation: `src/components/{ComponentName}.tsx`
- UI primitive: `src/components/ui/{ComponentName}.tsx`
- Types: `src/lib/types.ts`

**New API Route:**
- Definition: `src/app/api/{resource}/route.ts`
- Dynamic: `src/app/api/{resource}/[param]/route.ts`
- Related logic: `src/lib/`

**New Page:**
- Route: `src/app/(main)/{route}/page.tsx`
- Dynamic: `src/app/(main)/{route}/[param]/page.tsx`
- Layout if needed: `src/app/(main)/{route}/layout.tsx`

**Utilities:**
- Shared helpers: `src/lib/{name}.ts`
- Custom hooks: `src/hooks/use{Name}.ts`
- Type definitions: `src/lib/types.ts`

## Special Directories

**public/**
- Purpose: Static assets served at root URL
- Source: Manually placed files
- Contains: `sw.js`, `workbox-*.js` (PWA service worker)
- Committed: Partially (service worker files may be generated)

**.planning/**
- Purpose: Project planning documentation
- Source: Created by GSD workflow
- Committed: Yes

**.next/**
- Purpose: Next.js build output
- Source: Generated by `npm run build`
- Committed: No (in .gitignore)

**node_modules/**
- Purpose: npm dependencies
- Source: Generated by `npm install`
- Committed: No (in .gitignore)

---

*Structure analysis: 2026-01-14*
*Update when directory structure changes*
