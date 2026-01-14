# External Integrations

**Analysis Date:** 2026-01-14

## APIs & External Services

**Payment Processing:**
- None (financial data is read from existing GnuCash database)

**Email/SMS:**
- None

**External APIs:**
- None (self-contained application)

## Data Storage

**Databases:**
- PostgreSQL - Primary data store (GnuCash database)
  - Connection: via `DATABASE_URL` environment variable (`src/lib/db.ts`)
  - Client: pg npm package (raw SQL queries)
  - Schema: GnuCash standard schema (accounts, transactions, splits, commodities)
  - Views: `account_hierarchy` created on startup (`src/lib/db-init.ts`)

**File Storage:**
- None (no file uploads)

**Caching:**
- None (all queries hit database directly)
- Browser localStorage for UI state persistence (`src/components/AccountHierarchy.tsx`)

## Authentication & Identity

**Auth Provider:**
- None (no authentication implemented)
- Application is currently open/unprotected

**OAuth Integrations:**
- None

## Monitoring & Observability

**Error Tracking:**
- None (console.error only)

**Analytics:**
- None

**Logs:**
- Console output only (stdout/stderr)
- No structured logging

## CI/CD & Deployment

**Hosting:**
- Docker container (multi-stage build)
  - Base: Node.js 20 Alpine
  - Deployment: Manual or platform-specific
  - Container exposes port 3000

**CI Pipeline:**
- Not configured
- No GitHub Actions workflows

## Environment Configuration

**Development:**
- Required env vars: `DATABASE_URL` (PostgreSQL connection string)
- Secrets location: `.env.local` (gitignored)
- Local database: User must provide PostgreSQL with GnuCash schema

**Staging:**
- Not configured (no separate environment)

**Production:**
- Secrets management: Environment variables in container
- Database: Same PostgreSQL instance as GnuCash desktop (read-write access)

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None

## Database Schema Details

**Core Tables (GnuCash Standard):**
- `accounts` - Chart of accounts with hierarchy
- `transactions` - Transaction headers
- `splits` - Transaction line items (double-entry)
- `commodities` - Currencies and securities

**Custom Views:**
- `account_hierarchy` - Recursive CTE view for account tree
  - Created by `src/lib/db-init.ts` on app startup
  - Provides fullname paths and depth levels

**Connection Pattern:**
```typescript
// src/lib/db.ts
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});
export const query = (text: string, params?: any[]) => pool.query(text, params);
```

## Service Dependencies

**Required:**
- PostgreSQL 12+ with GnuCash database schema
- Network access to database server

**Optional:**
- None

## Third-Party Libraries with External Behavior

**Swagger UI:**
- `swagger-ui-react` - Renders API documentation
- No external network calls (self-contained)

**next-pwa:**
- Workbox-based service worker
- Enables offline caching
- No external service dependencies

---

*Integration audit: 2026-01-14*
*Update when adding/removing external services*
