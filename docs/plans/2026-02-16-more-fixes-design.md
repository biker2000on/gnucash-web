# GnuCash Web - More Fixes & Enhancements Design

**Date:** 2026-02-16
**Status:** Approved

## Overview

10 features across 3 phases, ordered by dependency and impact. Phase 1 is all client-side UX improvements. Phase 2 extends existing data patterns. Phase 3 adds server-side infrastructure (Redis + BullMQ).

---

## Phase 1: UI/UX Polish (Client-Side)

### 1A. Global Keyboard Shortcuts System

**New files:**
- `src/contexts/KeyboardShortcutContext.tsx` - Provider + central shortcut registry
- `src/lib/hooks/useKeyboardShortcut.ts` - Hook for registering shortcuts
- `src/components/KeyboardShortcutHelp.tsx` - Help modal (triggered by `?` key)

**Architecture:**
- `KeyboardShortcutProvider` wraps app in `layout.tsx`
- Maintains `Map<string, { key, description, handler, scope }>` of all registered shortcuts
- Single document-level `keydown` listener
- Scoped shortcuts: `global`, `transaction-form`, `date-field`, `amount-field`
- Global shortcuts suppressed when focus is inside `<input>`, `<textarea>`, `<select>`, or `[contenteditable]`
- Chord support: prefix key (`g`) sets 500ms timer for second key. Valid chord fires handler; timeout/invalid key resets.

**Shortcut map:**

| Key | Action | Scope |
|-----|--------|-------|
| `?` | Open help modal | global |
| `n` | New transaction | global (not in input) |
| `g d` | Go to Dashboard | global (chord) |
| `g a` | Go to Accounts | global (chord) |
| `g l` | Go to Ledger | global (chord) |
| `g i` | Go to Investments | global (chord) |
| `g r` | Go to Reports | global (chord) |
| `Esc` | Close modal / cancel | global |
| `Ctrl+Enter` | Save and Close transaction | transaction-form |
| `Ctrl+Shift+Enter` | Save and Add Another | transaction-form |
| `+` | Add 1 day to date | date-field (focused) |
| `-` | Subtract 1 day from date | date-field (focused) |
| `t` | Set date to today | date-field (focused) |
| `Ctrl+T` | Apply tax to amount | amount-field (focused) |

### 1B. Save and Add Another

**Changes to `TransactionForm.tsx`:**
- Add `onSaveAndAnother?: () => void` prop
- Second button "Save & New" next to existing "Save"
- On save-and-another: call `onSave()`, reset form (keep date, clear description/splits/etc.)
- `Ctrl+Shift+Enter` triggers save-and-another
- `Ctrl+Enter` triggers save-and-close (existing)

**Changes to `TransactionFormModal.tsx`:**
- Pass through `onSaveAndAnother` handler that saves then re-opens form fresh

### 1C. Date Field Shortcuts

**Changes to `TransactionForm.tsx` date input:**
- `onKeyDown` handler on date `<input>`
- `+` increments date by 1 day, `-` decrements, `t` sets to today
- `preventDefault()` on these keys to avoid typing into field
- Standard `Date` arithmetic for increment/decrement

### 1D. Math in Amount Fields

**New file:** `src/lib/math-eval.ts`
- Safe recursive descent parser for arithmetic: `+`, `-`, `*`, `/`, parentheses, decimals
- No `eval()` - pure parser/evaluator
- On `blur` or `Enter` in amount fields: if value contains operators, evaluate and replace with result
- Example: `100+50*2` -> blur -> `200`

**Changes to `SplitRow.tsx`:**
- Wrap debit/credit inputs with math evaluation on blur
- Subtle visual indicator when field contains an expression

### 1E. Tax Rate Setting & Shortcut

**Changes to `UserPreferencesContext.tsx`:**
- Add `defaultTaxRate: number` (decimal, e.g., `0.0675` for 6.75%)
- Add `setDefaultTaxRate: (rate: number) => Promise<void>`
- Persist via existing `/api/user/preferences` endpoint

**Changes to Profile page:**
- Add "Default Tax Rate" input with `%` suffix, validate 0-100 range

**Changes to `SplitRow.tsx`:**
- `Ctrl+T` when amount field focused: multiply current value by `(1 + taxRate)`
- If field contains math expression, evaluate first, then apply tax
- Toast: "Tax applied: $50.00 + 6.75% = $53.38"

---

## Phase 2: Data Features

### 2A. New Book Wizard with Currency & Templates

**New files:**
- `src/components/NewBookWizard.tsx` - Multi-step wizard modal
- `src/lib/account-templates.ts` - Template parsing and loading
- `src/data/account-templates/` - Bundled GnuCash template JSON files

**Wizard steps:**
1. **Book Name & Currency** - Name, description, master currency dropdown (ISO 4217 list + existing commodities)
2. **Template Selection** - Two-level picker:
   - Locale (en_US, en_GB, de_DE, fr_FR, es_ES, pt_BR)
   - Template type (Personal, Business, Personal + Business, etc.)
   - Preview pane showing account tree
3. **Confirmation** - Review and create

**Template data:**
```typescript
interface AccountTemplate {
  name: string;
  type: AccountType;
  children?: AccountTemplate[];
  placeholder?: boolean;
  description?: string;
}
interface TemplateFile {
  locale: string;
  name: string;
  description: string;
  currency: string;
  accounts: AccountTemplate[];
}
```

Pre-convert GnuCash XML templates to JSON at build time. Bundle common locales as static files.

**API:**
- Extend `POST /api/books` to accept `currency_guid` and `template_id`
- New `POST /api/books/from-template` for creating book + full account hierarchy

**UI:** `BookSwitcher.tsx` "New Book" opens wizard instead of inline form.

### 2B. Index Price Backfill

**Changes to `src/lib/market-index-service.ts`:**
- New `backfillIndexPrices(symbol)`:
  1. Query `MIN(post_date)` from transactions (earliest transaction date)
  2. Query latest stored index price date
  3. Fetch gap using existing `fetchHistoricalPrices()` from `yahoo-price-service.ts` (uses `chart()` endpoint)
  4. Dedup via existing `getExistingPriceDates()` pattern

**API:** `POST /api/investments/backfill-indices`
- Triggers backfill for ^GSPC and ^DJI
- Returns count of new prices inserted

**UI:** Button on Investments page: "Backfill Historical Index Data" with progress indicator.

### 2C. Cash Flow Stacked Area Chart

**New file:** `src/components/charts/CashFlowChart.tsx`

**API:** `GET /api/dashboard/cash-flow-chart`
- Returns monthly time-series: `{ months: string[], income: number[], expenses: number[], netCashFlow: number[] }`
- Query param: `period` (6M, 1Y, 2Y, ALL)
- Groups by month, sums income and expense accounts

**Chart (Recharts):**
- X-axis: months
- Stacked areas: Income (green), Expenses (red/negative)
- Net cash flow line overlay (blue dashed)
- Tooltip with all three values
- Period selector (6M / 1Y / 2Y / ALL)
- Wrapped with `ExpandableChart`

**Integration:** Dashboard + Reports section.

---

## Phase 3: Backend Caching & Refresh Engine

### 3A. Infrastructure

**New dependencies:** `bullmq`, `ioredis`

**New files:**
- `src/lib/redis.ts` - Redis connection singleton
- `src/lib/queue/worker.ts` - BullMQ worker entry point
- `src/lib/queue/queues.ts` - Queue definitions and schedulers
- `src/lib/queue/jobs/refresh-prices.ts` - Price refresh handler
- `src/lib/queue/jobs/cache-aggregations.ts` - Aggregation caching handler
- `src/lib/cache.ts` - Cache read/write/invalidate helpers

**Docker Compose (`docker-compose.yml`):**
```yaml
version: '3.8'
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: redis://redis:6379
    depends_on: [redis]

  worker:
    build: .
    command: ["node", "worker.js"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: redis://redis:6379
    depends_on: [redis]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: ["redis-data:/data"]

volumes:
  redis-data:
```

**Architecture:**
```
Next.js App (web)          Worker Process
  |                           |
  +-- API routes              +-- BullMQ Worker
  |   +-- read from cache     |   +-- refresh-prices job
  |   +-- fallback to DB      |   +-- cache-aggregations job
  |                           |   +-- backfill-indices job
  +-- /api/admin/queues       |
      +-- trigger/monitor     |
                              +-- Writes to Redis cache
         +----------+
         |  Redis   |
         |  +- cache| (key-value aggregations)
         |  +- queue| (BullMQ job queue)
         +----------+
```

### 3B. Job Types

**1. Price Refresh (`refresh-prices`)**
- Calls existing `fetchAndStorePrices()` from `yahoo-price-service.ts`
- Default: daily at 22:00 UTC (after US market close)
- Configurable frequency

**2. Cache Aggregations (`cache-aggregations`)**
- Computes and caches: net worth, income/expense monthly totals, account balance tree, KPIs
- Cache key: `cache:{bookGuid}:{metric}:{date}`
- TTL: 24 hours, refreshed daily

**3. Index Backfill (`backfill-indices`)**
- On-demand job (Phase 2 UI trigger or scheduled)
- Fetches ^GSPC and ^DJI back to earliest transaction date

### 3C. Cache Integration

**Pattern - cache-aside with fallback:**
```typescript
const cached = await cache.get(`net-worth:${bookGuid}:${today}`);
if (cached) return Response.json(cached);
const result = await calculateNetWorth(bookGuid);
await cache.set(`net-worth:${bookGuid}:${today}`, result, 86400);
return Response.json(result);
```

**Cached APIs:**
- `/api/dashboard/kpis`
- `/api/dashboard/net-worth`
- `/api/dashboard/income-expense`
- `/api/dashboard/sankey`

**Cache invalidation (forward-only):**
- When a transaction is created/updated/deleted, determine its `post_date`
- Invalidate cached aggregations for that date **and all dates after it**
- Dates **before** the transaction date remain cached (unaffected)
- Implementation: Redis sorted sets keyed by date for efficient range invalidation

### 3D. Settings Page

**New page:** `src/app/(main)/settings/page.tsx`

**Sections:**
1. **Price Refresh Schedule** - Enable/disable, frequency (daily/6hr/12hr), time of day, "Refresh Now"
2. **Index Data** - "Backfill Historical Data" button, date range display
3. **Cache Management** - "Clear All Caches" button, cache stats
4. **Tax Rate** - Default tax rate % input (also accessible from Profile page)

**API endpoints:**
- `GET/PATCH /api/settings/schedules`
- `POST /api/settings/schedules/run-now`
- `POST /api/settings/cache/clear`
- `GET /api/settings/cache/stats`

### 3E. Worker Process

Separate `worker.ts` entry point compiled alongside Next.js. Runs as its own Docker service.

**Graceful degradation:** If Redis is unavailable, app works normally with live computation (current behavior). Cache is purely an optimization layer.

---

## Playwright Validation

All features validated using Playwright headless with `.env.test` credentials. Validation against "Last Year" (2025) data.

## Out of Scope (Deferred)

- Sync engine to GnuCash desktop database
- Two-way sync / conflict resolution
- Plaid / Stripe integration scheduling
