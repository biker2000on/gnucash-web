# Architecture

**Analysis Date:** 2026-01-14

## Pattern Overview

**Overall:** Next.js App Router Full-Stack Application

**Key Characteristics:**
- Server-side rendering with App Router
- Read-write Progressive Web App for GnuCash data
- Direct PostgreSQL database access (no ORM)
- Route groups for layout organization

## Layers

**Presentation Layer (Components):**
- Purpose: UI components and client-side interactivity
- Contains: React components with "use client" directive
- Location: `src/components/*.tsx`, `src/components/ui/*.tsx`, `src/components/filters/*.tsx`
- Depends on: Library layer for utilities and types
- Used by: Page components

**Page Layer (App Router):**
- Purpose: Server components, routing, data fetching
- Contains: Page and layout components
- Location: `src/app/(main)/*.tsx`, `src/app/api/*.ts`
- Depends on: Library layer, component layer
- Used by: Next.js router

**API Layer:**
- Purpose: REST API endpoints for data operations
- Contains: Route handlers (GET, POST, PUT, DELETE)
- Location: `src/app/api/**/*.ts`
- Depends on: Library layer (db, types, validation)
- Used by: Client components via fetch

**Library Layer:**
- Purpose: Shared utilities, types, database access
- Contains: Database client, type definitions, validation, formatting
- Location: `src/lib/*.ts`
- Depends on: Node.js built-ins, pg driver
- Used by: All other layers

**Hooks Layer:**
- Purpose: Reusable React hooks
- Contains: Custom hooks for state and logic
- Location: `src/hooks/*.ts`
- Depends on: React, Library layer
- Used by: Component layer

## Data Flow

**Page Load (Server-Side):**

1. User navigates to route (e.g., `/accounts`)
2. Next.js matches route in `src/app/(main)/`
3. Layout component (`src/app/(main)/layout.tsx`) initializes database schema
4. Page component fetches initial data via direct DB queries
5. Server renders HTML with initial data
6. Client hydrates with React components

**Client-Side Data Fetching:**

1. Component mounts (e.g., `AccountLedger`)
2. IntersectionObserver triggers infinite scroll
3. Component calls API endpoint via fetch (e.g., `/api/accounts/{guid}/transactions`)
4. API route handler queries PostgreSQL
5. Response returned as JSON
6. Component updates state and re-renders

**Transaction CRUD:**

1. User action triggers form submission
2. Client validates data (`src/lib/validation.ts`)
3. POST/PUT/DELETE to `/api/transactions` or `/api/transactions/{guid}`
4. Server validates, executes DB operations
5. Response returned to client
6. UI updates with new data

**State Management:**
- Server: Stateless (database per request)
- Client: React useState/useEffect for local state
- Persistence: localStorage for UI preferences (e.g., expanded nodes, sort settings)

## Key Abstractions

**Database Access:**
- Purpose: PostgreSQL query execution
- Location: `src/lib/db.ts` (query function, toDecimal helper)
- Pattern: Connection pool with simple query wrapper

**Type Definitions:**
- Purpose: TypeScript interfaces for domain objects
- Location: `src/lib/types.ts`
- Examples: Account, Transaction, Split, CreateTransactionRequest

**Validation:**
- Purpose: Input validation for transactions
- Location: `src/lib/validation.ts`
- Pattern: Validation function returning ValidationResult

**Database Views:**
- Purpose: Computed account hierarchy
- Location: `src/lib/db-init.ts`
- Pattern: Recursive CTE view created on app startup

## Entry Points

**Web Application:**
- Location: `src/app/layout.tsx` (root layout)
- Triggers: HTTP request to any route
- Responsibilities: Font loading, global styles, HTML shell

**Main Layout:**
- Location: `src/app/(main)/layout.tsx`
- Triggers: Routes within (main) group
- Responsibilities: Database initialization, sidebar layout

**API Routes:**
- Location: `src/app/api/**/route.ts`
- Triggers: HTTP requests to /api/*
- Responsibilities: Data operations, validation, response formatting

## Error Handling

**Strategy:** Try/catch with console.error logging, return error responses

**Patterns:**
- API routes: `try/catch` wrapping entire handler, return 500 with generic error
- Client components: `try/catch` in async functions, set error state
- No global error boundary configured

## Cross-Cutting Concerns

**Logging:**
- Console.log for info output (database init)
- Console.error for error logging
- No structured logging framework

**Validation:**
- Manual validation in `src/lib/validation.ts`
- Server-side validation in API routes
- OpenAPI/Swagger JSDoc annotations for documentation

**Numeric Handling:**
- GnuCash stores amounts as fractions (numerator/denominator)
- `toDecimal()` in `src/lib/db.ts` converts to decimal strings
- BigInt used for precision in calculations

**Currency Formatting:**
- `formatCurrency()` in `src/lib/format.ts`
- Uses Intl.NumberFormat with fallback for non-standard mnemonics

---

*Architecture analysis: 2026-01-14*
*Update when major patterns change*
