# Work Plan: Investment & Fixed Asset Improvements

## Context

### Original Request
Four major improvement areas for the investment dashboard and fixed asset tracking:
1. **Investment Data Enhancements**: Cash visualization (per-account + overall), industry exposure, commodity deduplication
2. **Market Index Comparison**: S&P 500 and DJIA overlay on performance chart with profile-based defaults
3. **Fixed Asset Valuation via Transactions**: Depreciation/appreciation recorded as real GnuCash transactions in fixed asset accounts
4. **Performance Chart Profile Settings**: Configurable defaults for comparison lines, time period, and display mode

### Research Findings

**Yahoo Finance Capabilities (already integrated via yahoo-finance2):**
- `quoteSummary` with `assetProfile` module provides sector/industry for individual stocks
- `quoteSummary` with `topHoldings` module provides sector weights for ETFs/mutual funds
- `^GSPC` (S&P 500) and `^DJI` (Dow Jones) are valid symbols for `chart()` calls
- No API key required; already using `yahoo-finance2` in `src/lib/yahoo-price-service.ts`
- **IMPORTANT**: The `historical()` endpoint is deprecated and causing errors. Must use `chart()` endpoint instead (see T1.0).

**Data Storage Strategy:**
- The app already has `gnucash_web_*` extension tables created via `CREATE TABLE IF NOT EXISTS` in `src/lib/db-init.ts`
- New `gnucash_web_commodity_metadata` table for industry/sector data (cached from Yahoo)
- New `gnucash_web_depreciation_schedules` table to store depreciation/appreciation configuration per fixed asset account
- **Fixed asset valuations are NOT stored in a separate table.** Instead, value changes are recorded as real GnuCash transactions (depreciation/appreciation) posted to the fixed asset accounts. The account balance IS the current value.
- New `gnucash_web_user_preferences` table for storing per-user chart/display preferences
- Market index prices go into the existing GnuCash `prices` table by creating virtual commodities for ^GSPC and ^DJI in the `commodities` table (see Acceptable GnuCash Table Modifications below)

**Existing Transaction Creation Pattern (REUSE for fixed asset transactions):**
- `POST /api/transactions` endpoint already handles creating transactions with splits
- `CreateTransactionRequest` interface in `src/lib/types.ts` defines the shape
- `validateTransaction()` in `src/lib/validation.ts` validates double-entry balancing
- `toNumDenom()` converts decimal amounts to GnuCash num/denom format
- `generateGuid()` from `@/lib/prisma` generates 32-char hex GUIDs
- `processMultiCurrencySplits()` handles multi-currency scenarios
- `InvestmentTransactionForm` component demonstrates the client-side pattern for building splits and calling the POST endpoint

### Codebase Context

**Current Investment Infrastructure:**
- Portfolio API (`src/app/api/investments/portfolio/route.ts`): Fetches STOCK/MUTUAL accounts, builds holdings with account paths, groups by parent category for allocation pie chart
- History API (`src/app/api/investments/history/route.ts`): Daily portfolio value time series using point-in-time shares + historical prices
- HoldingsTable component: Per-account rows, sortable, links to account ledger. Currently keyed by `accountGuid` (no commodity grouping)
- PerformanceChart component: Recharts LineChart/AreaChart with period selector and $/% toggle
- AllocationChart component: Recharts PieChart grouped by parent account category
- Yahoo service (`src/lib/yahoo-price-service.ts`): `fetchHistoricalPrices()`, `fetchAndStorePrices()`, `getQuotableCommodities()`, dedup via `getExistingPriceDates()`
- **Price service facade** (`src/lib/price-service.ts`): Re-exports all functions from `yahoo-price-service.ts`. Consumers import from this facade.
- Price storage: `storeFetchedPrice()` inserts into GnuCash `prices` table with dedup via `getExistingPriceDates()`

**Account Structure Assumptions:**
- Brokerage accounts have parent accounts (e.g., "Roth IRA", "401k") containing children of type STOCK/MUTUAL
- Cash sibling accounts are BANK/ASSET type under the same parent as STOCK/MUTUAL accounts
- `extractAccountCategory()` in portfolio route uses parent folder name (second-to-last path segment)

**Extension Table Pattern (ESTABLISHED in `src/lib/db-init.ts`):**
- Tables are created via `CREATE TABLE IF NOT EXISTS` inside `src/lib/db-init.ts`
- The `createExtensionTables()` function runs on app startup via `initializeDatabase()`
- Existing tables: `gnucash_web_users`, `gnucash_web_audit`, `gnucash_web_saved_reports`
- All prefixed with `gnucash_web_` to avoid GnuCash schema conflicts
- Auto-increment integer IDs, timestamps, JSON columns for flexible data
- Prisma models are added to `prisma/schema.prisma` for typed client generation, then `prisma generate` (NOT `prisma db push`)

**Navigation Lives in `src/components/Layout.tsx`:**
- `navItems` array at line 118 defines sidebar navigation entries
- `iconMap` at lines 104-112 maps icon names to inline SVG icon components (no external icon library)
- Adding a nav item requires: (1) creating a new icon component function, (2) adding it to `iconMap`, (3) adding an entry to `navItems`

**GnuCash `commodities` Table Schema (from Prisma introspection):**
The `commodities` table has exactly these columns:
- `guid` (VarChar(32), PK)
- `namespace` (VarChar(2048))
- `mnemonic` (VarChar(2048))
- `fullname` (VarChar(2048), nullable)
- `cusip` (VarChar(2048), nullable)
- `fraction` (Int)
- `quote_flag` (Int)
- `quote_source` (VarChar(2048), nullable)
- `quote_tz` (VarChar(2048), nullable)

**NOTE:** `commodity_scu` and `non_std_scu` are columns on the `accounts` table, NOT the `commodities` table. Do not attempt to insert these fields into commodities.

---

## Work Objectives

### Core Objective
Enhance the investment dashboard with cash visibility (per-account and overall), industry exposure analysis, commodity consolidation, market benchmark comparison with configurable profile defaults, and transaction-based fixed asset depreciation/appreciation tracking. Migrate Yahoo Finance price fetching from deprecated `historical()` to `chart()` endpoint.

### Deliverables
1. Yahoo Finance API migration from `historical()` to `chart()` endpoint
2. Cash percentage visualization per brokerage/retirement account AND overall portfolio-wide cash percentage
3. Industry/sector exposure bar chart powered by Yahoo Finance metadata
4. Consolidated holdings table with commodity deduplication and expand/collapse
5. S&P 500 and DJIA comparison lines on the performance chart (toggleable, default off, configurable via profile settings)
6. Performance chart profile settings (default comparison lines, time period, display mode)
7. Fixed asset depreciation/appreciation tracking via real GnuCash transactions

### Definition of Done
- [ ] `fetchHistoricalPrices()` uses `yahooFinance.chart()` instead of deprecated `yahooFinance.historical()`
- [ ] All existing callers of `fetchHistoricalPrices()` continue to work without changes
- [ ] Cash percentage shows correctly for each parent brokerage account AND as an overall/portfolio-wide total
- [ ] Industry bar chart displays sector allocation from Yahoo Finance data
- [ ] Holdings table groups same-commodity entries with expandable detail
- [ ] Performance chart has toggleable S&P 500 and DJIA overlay lines
- [ ] Performance chart defaults are configurable via user profile settings
- [ ] Market index historical prices are fetched and stored automatically
- [ ] Fixed asset page exists showing ASSET accounts with current balances (from GnuCash transactions)
- [ ] Depreciation/appreciation transactions can be created for fixed asset accounts
- [ ] Depreciation schedules can be configured and auto-generate transactions
- [ ] All new features are type-safe with proper error handling
- [ ] All new API endpoints have TypeScript response interfaces

---

## Must Have / Must NOT Have

### Must Have
- Yahoo Finance migration: Replace deprecated `historical()` with `chart()` endpoint in `fetchHistoricalPrices()`
- Cash detection: Find BANK/ASSET siblings of STOCK/MUTUAL accounts under same parent
- Overall cash %: Aggregate total cash across all brokerage accounts vs total investment value
- Industry data: Use yahoo-finance2 `quoteSummary` for sectors; cache in DB
- Commodity dedup: Group by `commodity_guid` across accounts; show total + per-account breakdown
- Index comparison: Fetch ^GSPC and ^DJI as virtual commodities; overlay on performance chart
- Profile settings: User-configurable defaults for performance chart (comparison lines on/off, time period, $ vs %)
- Depreciation schedules table: `gnucash_web_depreciation_schedules` for storing depreciation config per fixed asset
- User preferences table: `gnucash_web_user_preferences` for storing chart/display defaults
- Transaction-based valuations: Create real GnuCash depreciation/appreciation transactions in fixed asset accounts
- Graceful degradation: If Yahoo sector lookup fails, show "Unknown" rather than error
- Dedup safety: All price inserts must use `getExistingPriceDates()` pattern (prices table has NO unique constraint)
- New service integration via `src/lib/price-service.ts` facade
- Extension tables created in `src/lib/db-init.ts` following established pattern (NOT as separate migration files)

### Must NOT Have
- Real-time price quotes (app policy: historical closes only)
- Separate valuations table for fixed assets (valuations are GnuCash transactions, not a separate table)
- Zillow ZHVI integration (removed from scope)
- KBB-specific or car-specific valuation features (depreciation calculator is generic)
- Modification of core GnuCash table **structure** (no ALTER TABLE, no schema changes)
- Separate migration files in `prisma/migrations/` (use db-init.ts instead)

### Acceptable GnuCash Table Modifications (Exceptions)
The following INSERT operations into core GnuCash tables are explicitly permitted:
1. **`prices` table**: INSERT new price rows (already done by existing `storeFetchedPrice()`)
2. **`commodities` table**: INSERT new rows for INDEX namespace virtual commodities (^GSPC, ^DJI) with these required field values:
   - `guid`: Generated via `generateGuid()` (import from `@/lib/gnucash` or `@/lib/prisma` which re-exports it)
   - `namespace`: `'INDEX'`
   - `mnemonic`: `'^GSPC'` or `'^DJI'`
   - `fullname`: `'S&P 500 Index'` or `'Dow Jones Industrial Average'`
   - `cusip`: `''` (empty string)
   - `fraction`: `10000` (4 decimal places for index values)
   - `quote_flag`: `0` (CRITICAL: must be 0 to prevent `getQuotableCommodities()` from returning them -- index fetching is handled separately)
   - `quote_source`: `null`
   - `quote_tz`: `null`

   **These are the ONLY 9 columns on the `commodities` table.** Do NOT attempt to insert `commodity_scu` or `non_std_scu` -- those columns belong to the `accounts` table, not `commodities`.

3. **`transactions` and `splits` tables**: INSERT new rows for depreciation/appreciation transactions on fixed asset accounts. This follows the exact same pattern as the existing `POST /api/transactions` endpoint used by `InvestmentTransactionForm`. The app already creates transactions -- this extends that capability to fixed assets.

**Rationale**: INDEX commodities are read-only reference data needed for price comparison. Using `quote_flag: 0` ensures they are invisible to the existing `fetchAndStorePrices()` flow and GnuCash desktop's Finance::Quote. Depreciation/appreciation transactions are standard double-entry bookkeeping that GnuCash desktop will display correctly.

---

## Task Flow and Dependencies

```
Phase 1: Database & Infrastructure
  T1.0 Migrate Yahoo Finance from historical() to chart() endpoint (PREREQUISITE for all price fetching)
  T1.1 Create gnucash_web_commodity_metadata table (in db-init.ts)
  T1.2 Create gnucash_web_depreciation_schedules table (in db-init.ts)
  T1.3 Create gnucash_web_user_preferences table (in db-init.ts)
  T1.4 Create commodity metadata service (Yahoo quoteSummary integration)
  T1.5 Create market index service (^GSPC, ^DJI commodity creation + price fetching) [depends on T1.0]

Phase 2: Investment Data Enhancements (depends on Phase 1)
  T2.1 Add cash detection logic to portfolio API (per-account + overall)
  T2.2 Add industry/sector data to portfolio API
  T2.3 Implement commodity deduplication in portfolio API
  T2.4 Build CashAllocationCard component (per-account + overall total row)
  T2.5 Build IndustryExposureChart component
  T2.6 Refactor HoldingsTable for grouped/expandable rows

Phase 3: Market Index Comparison & Profile Settings (depends on T1.3, T1.5)
  T3.1 Add market index data to history API
  T3.2 Create user preferences API and service
  T3.3 Update PerformanceChart with comparison lines + toggle + profile defaults
  T3.4 Build chart settings UI (gear icon on PerformanceChart)

Phase 4: Fixed Asset Tracking (depends on T1.2)
  T4.1 Create fixed assets page and navigation (update src/components/Layout.tsx)
  T4.2 Create depreciation/appreciation transaction service
  T4.3 Build depreciation schedule configuration form
  T4.4 Build fixed asset detail view with transaction history
  T4.5 Add generic depreciation schedule calculator utility

Phase 5: Integration & Polish
  T5.1 Update investments page layout to incorporate new components
  T5.2 Update "Refresh All Prices" to also fetch index prices (via price-service facade)
  T5.3 Add loading states and error handling for all new features
```

---

## Detailed TODOs

### Phase 1: Database & Infrastructure

#### T1.0: Migrate Yahoo Finance from `historical()` to `chart()` Endpoint
**File:** `src/lib/yahoo-price-service.ts`
**Action:** Replace the deprecated `yahooFinance.historical()` call with `yahooFinance.chart()` in `fetchHistoricalPrices()`

**Background:**
The `historical()` endpoint in yahoo-finance2 is deprecated and causing runtime errors. The replacement is `yahooFinance.chart()`, which returns data in a different structure that must be mapped to the existing `{ date, close }` output interface.

**Current code (lines 132-148):**
```typescript
export async function fetchHistoricalPrices(
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<HistoricalPriceRow[]> {
  const yahooFinance = new YahooFinance();

  const rows = await yahooFinance.historical(symbol, {
    period1: startDate,
    period2: endDate,
    interval: '1d',
  });

  return rows
    .filter((r) => typeof r.close === 'number' && r.close > 0)
    .map((r) => ({ date: r.date, close: r.close }));
}
```

**New code using `chart()`:**
```typescript
export async function fetchHistoricalPrices(
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<HistoricalPriceRow[]> {
  const yahooFinance = new YahooFinance();

  const result = await yahooFinance.chart(symbol, {
    period1: startDate,
    period2: endDate,
    interval: '1d',
  });

  // chart() returns { quotes: Array<{ date, open, high, low, close, volume }> }
  // Map to the same HistoricalPriceRow interface used by all callers
  const quotes = result.quotes ?? [];
  return quotes
    .filter((q) => typeof q.close === 'number' && q.close > 0)
    .map((q) => ({ date: q.date, close: q.close as number }));
}
```

**Key differences between `historical()` and `chart()`:**
- `historical(symbol, opts)` returns `Array<{ date, open, high, low, close, volume, adjClose }>` directly
- `chart(symbol, opts)` returns `{ meta: {...}, quotes: Array<{ date, open, high, low, close, volume }>, events: {...} }`
- The quotes inside `chart()` have the same shape, but they are nested under `.quotes`
- `chart()` also provides `.meta` with currency, exchange info, etc.

**Callers that depend on `fetchHistoricalPrices()` (all import via price-service facade):**
1. `fetchAndStorePrices()` in `yahoo-price-service.ts` (lines 426, 452, 479) -- calls directly
2. `detectAndFillGaps()` in `yahoo-price-service.ts` (line 180) -- calls directly
3. Any new code in this plan (T1.5 market index service) -- will use the migrated version

**No caller changes needed** because the function signature and return type (`HistoricalPriceRow[]`) remain identical. Only the internal implementation changes.

**Also update the JSDoc comment** on `fetchHistoricalPrices()`:
- Change "Uses yahooFinance.historical()" to "Uses yahooFinance.chart()"
- Note that this was migrated from the deprecated historical() endpoint

**Acceptance Criteria:**
- `fetchHistoricalPrices()` uses `yahooFinance.chart()` instead of `yahooFinance.historical()`
- Return type remains `HistoricalPriceRow[]` (same `{ date, close }` interface)
- `fetchAndStorePrices()` continues to work for all quotable commodities
- `detectAndFillGaps()` continues to work
- No changes to any callers outside `yahoo-price-service.ts`
- Build passes with no type errors

#### T1.1: Create `gnucash_web_commodity_metadata` Table
**File:** `prisma/schema.prisma` (add Prisma model for client generation)
**Also modify:** `src/lib/db-init.ts` (add CREATE TABLE to `createExtensionTables()`)
**Action:** Add new model to extension tables section + raw SQL CREATE TABLE in db-init.ts

**Migration approach:** Follow the established pattern in `src/lib/db-init.ts`. Add the `CREATE TABLE IF NOT EXISTS` SQL to the `createExtensionTables()` function, which runs automatically on app startup via `initializeDatabase()`. Also add the Prisma model to `prisma/schema.prisma` for typed client generation, then run `prisma generate` (NOT `prisma db push`).

```prisma
model gnucash_web_commodity_metadata {
  id               Int       @id @default(autoincrement())
  commodity_guid   String    @db.VarChar(32)
  mnemonic         String    @db.VarChar(50)
  sector           String?   @db.VarChar(255)
  industry         String?   @db.VarChar(255)
  sector_weights   Json?     // For ETFs/funds: { "Technology": 25.5, "Healthcare": 15.2, ... }
  asset_class      String?   @db.VarChar(50)  // "stock", "etf", "mutual_fund", "bond"
  last_updated     DateTime  @default(now())
  created_at       DateTime  @default(now())

  @@unique([commodity_guid])
  @@index([mnemonic])
}
```

**Add to `createExtensionTables()` in `src/lib/db-init.ts`:**
```typescript
const commodityMetadataTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_commodity_metadata (
        id SERIAL PRIMARY KEY,
        commodity_guid VARCHAR(32) NOT NULL,
        mnemonic VARCHAR(50) NOT NULL,
        sector VARCHAR(255),
        industry VARCHAR(255),
        sector_weights JSONB,
        asset_class VARCHAR(50),
        last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(commodity_guid)
    );
    CREATE INDEX IF NOT EXISTS idx_commodity_metadata_mnemonic ON gnucash_web_commodity_metadata(mnemonic);
`;
```

Then add `await query(commodityMetadataTableDDL);` to the try block in `createExtensionTables()`.

**Acceptance Criteria:**
- Table is created via `CREATE TABLE IF NOT EXISTS` in `src/lib/db-init.ts` `createExtensionTables()`
- Prisma model is added so `prisma generate` produces typed client
- Table is created with proper indexes
- Does not conflict with GnuCash tables
- No separate migration file created in `prisma/migrations/`

#### T1.2: Create `gnucash_web_depreciation_schedules` Table
**File:** `prisma/schema.prisma` (add Prisma model for client generation)
**Also modify:** `src/lib/db-init.ts` (add CREATE TABLE to `createExtensionTables()`)
**Action:** Add new model for storing depreciation/appreciation schedule configuration per fixed asset account

This table stores the **configuration** for how an asset depreciates or appreciates over time. It does NOT store the valuations themselves -- those are recorded as real GnuCash transactions.

```prisma
model gnucash_web_depreciation_schedules {
  id                    Int       @id @default(autoincrement())
  account_guid          String    @db.VarChar(32)
  purchase_price        Decimal   @db.Decimal(15, 2)
  purchase_date         DateTime  @db.Date
  useful_life_years     Int
  salvage_value         Decimal   @db.Decimal(15, 2) @default(0)
  method                String    @db.VarChar(30)  // "straight-line", "declining-balance"
  decline_rate          Decimal?  @db.Decimal(5, 4)  // For declining balance, e.g., 0.2000
  contra_account_guid   String    @db.VarChar(32)  // e.g., "Expenses:Depreciation" for depreciation, "Income:Unrealized Gains" for appreciation
  frequency             String    @db.VarChar(20) @default("monthly")  // "monthly", "quarterly", "yearly"
  is_appreciation       Boolean   @default(false)  // true for assets that appreciate (real estate), false for depreciating (vehicles)
  last_transaction_date DateTime? @db.Date  // Date of last auto-generated transaction
  enabled               Boolean   @default(true)
  notes                 String?   @db.Text
  created_at            DateTime  @default(now())
  updated_at            DateTime  @default(now())

  @@unique([account_guid])
  @@index([account_guid])
}
```

**Add to `createExtensionTables()` in `src/lib/db-init.ts`:**
```typescript
const depreciationSchedulesTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_depreciation_schedules (
        id SERIAL PRIMARY KEY,
        account_guid VARCHAR(32) NOT NULL,
        purchase_price DECIMAL(15, 2) NOT NULL,
        purchase_date DATE NOT NULL,
        useful_life_years INTEGER NOT NULL,
        salvage_value DECIMAL(15, 2) NOT NULL DEFAULT 0,
        method VARCHAR(30) NOT NULL,
        decline_rate DECIMAL(5, 4),
        contra_account_guid VARCHAR(32) NOT NULL,
        frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
        is_appreciation BOOLEAN NOT NULL DEFAULT FALSE,
        last_transaction_date DATE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(account_guid)
    );
    CREATE INDEX IF NOT EXISTS idx_depreciation_schedules_account ON gnucash_web_depreciation_schedules(account_guid);
`;
```

Then add `await query(depreciationSchedulesTableDDL);` to the try block in `createExtensionTables()`.

**Acceptance Criteria:**
- Table is created via `CREATE TABLE IF NOT EXISTS` in `src/lib/db-init.ts` `createExtensionTables()`
- Unique constraint on account_guid (one schedule per fixed asset account)
- Stores depreciation config (purchase price, useful life, method, contra account, frequency)
- `is_appreciation` flag distinguishes appreciating assets (homes) from depreciating ones (vehicles)
- `contra_account_guid` allows user to specify which expense/income account to use
- `last_transaction_date` tracks auto-generation progress
- No separate migration file created in `prisma/migrations/`

#### T1.3: Create `gnucash_web_user_preferences` Table
**File:** `prisma/schema.prisma` (add Prisma model for client generation)
**Also modify:** `src/lib/db-init.ts` (add CREATE TABLE to `createExtensionTables()`)
**Action:** Add new table for storing per-user display/chart preferences

```prisma
model gnucash_web_user_preferences {
  id              Int       @id @default(autoincrement())
  user_id         Int
  preference_key  String    @db.VarChar(100)  // e.g., "performance_chart.sp500_enabled"
  preference_value String   @db.Text          // JSON-encoded value
  updated_at      DateTime  @default(now())

  @@unique([user_id, preference_key])
  @@index([user_id])
}
```

**Add to `createExtensionTables()` in `src/lib/db-init.ts`:**
```typescript
const userPreferencesTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_user_preferences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
        preference_key VARCHAR(100) NOT NULL,
        preference_value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, preference_key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON gnucash_web_user_preferences(user_id);
`;
```

**Known preference keys for performance chart:**
- `performance_chart.sp500_default` -- boolean, whether S&P 500 line is on by default
- `performance_chart.djia_default` -- boolean, whether DJIA line is on by default
- `performance_chart.default_period` -- string, e.g., "1Y", "6M", "3M", "1M", "ALL"
- `performance_chart.default_mode` -- string, "dollar" or "percent"

Then add `await query(userPreferencesTableDDL);` to the try block in `createExtensionTables()`.

**Acceptance Criteria:**
- Table is created via `CREATE TABLE IF NOT EXISTS` in `src/lib/db-init.ts`
- Foreign key to `gnucash_web_users` with cascade delete
- Unique constraint on (user_id, preference_key) prevents duplicates
- Flexible key-value structure supports arbitrary preference types
- No separate migration file created in `prisma/migrations/`

#### T1.4: Create Commodity Metadata Service
**File:** `src/lib/commodity-metadata.ts` (NEW)
**Action:** Service to fetch and cache industry/sector data from Yahoo Finance

**Key functions:**
- `fetchCommodityMetadata(symbol: string)`: Call `quoteSummary` with `assetProfile` + `topHoldings` modules
- `getCachedMetadata(commodityGuid: string)`: Read from DB, return cached data
- `refreshMetadata(commodityGuid: string, symbol: string)`: Fetch from Yahoo, upsert to DB
- `refreshAllMetadata()`: Batch refresh for all quotable commodities
- `getPortfolioSectorExposure(holdings)`: Aggregate sector weights across holdings weighted by market value

**Yahoo Finance Integration:**
```typescript
// For individual stocks:
const summary = await yahooFinance.quoteSummary(symbol, { modules: ['assetProfile'] });
// summary.assetProfile.sector -> "Technology"
// summary.assetProfile.industry -> "Consumer Electronics"

// For ETFs/mutual funds:
const summary = await yahooFinance.quoteSummary(symbol, { modules: ['topHoldings'] });
// summary.topHoldings.sectorWeightings -> [{ realestate: 0.02 }, { technology: 0.28 }, ...]
```

**Acceptance Criteria:**
- Successfully fetches sector for individual stocks (e.g., AAPL -> Technology)
- Successfully fetches sector weights for ETFs (e.g., VOO -> diversified weights)
- Caches results in DB; re-fetches only if `last_updated` is older than 7 days
- Handles Yahoo Finance errors gracefully (returns null/empty, does not throw)

#### T1.5: Create Market Index Service
**File:** `src/lib/market-index-service.ts` (NEW)
**Action:** Service to manage market index tracking via virtual commodities

**Key functions:**
- `ensureIndexCommodities()`: Create or find commodities for ^GSPC and ^DJI in `INDEX` namespace
- `fetchIndexPrices(days?: number)`: Fetch historical prices for both indices using `fetchHistoricalPrices()` from `price-service` facade (which now uses `chart()` endpoint per T1.0)
- `getIndexHistory(indexSymbol: string, startDate: Date)`: Get stored index price history
- `normalizeToPercent(prices: PriceData[], baseDate: Date)`: Convert absolute prices to % change from base

**Integration with price-service facade:**
- Import `fetchHistoricalPrices`, `storeFetchedPrice`, and `getExistingPriceDates` from `@/lib/price-service` (the facade that re-exports from yahoo-price-service.ts)
- Do NOT import directly from yahoo-price-service.ts
- `fetchHistoricalPrices` will already be using the `chart()` endpoint (migrated in T1.0)

**Import for `generateGuid`:**
- Import `generateGuid` from `@/lib/gnucash` (canonical source) or `@/lib/prisma` (which re-exports it)
- Recommended: `import { generateGuid } from '@/lib/gnucash';`

**Implementation Notes -- Commodity Creation:**
- Create commodities in the GnuCash `commodities` table using raw SQL INSERT via Prisma `$executeRaw`
- Use `namespace: 'INDEX'` with `quote_flag: 0` (CRITICAL -- see "Acceptable GnuCash Table Modifications" above)
- The `commodities` table has exactly 9 columns. Required field values for each commodity INSERT:
  ```sql
  INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
  VALUES ($1, 'INDEX', '^GSPC', 'S&P 500 Index', '', 10000, 0, NULL, NULL)
  ```
  ```typescript
  // In TypeScript:
  {
    guid: generateGuid(),          // 32-char hex, import from @/lib/gnucash
    namespace: 'INDEX',
    mnemonic: '^GSPC',             // or '^DJI'
    fullname: 'S&P 500 Index',     // or 'Dow Jones Industrial Average'
    cusip: '',                     // empty string
    fraction: 10000,               // 4 decimal places for index values
    quote_flag: 0,                 // MUST be 0 to avoid getQuotableCommodities() pickup
    quote_source: null,
    quote_tz: null,
  }
  ```
  **WARNING:** Do NOT include `commodity_scu` or `non_std_scu` in the INSERT -- those columns do NOT exist on the `commodities` table. They are `accounts` table columns.
- Check if commodity already exists (by namespace + mnemonic) before inserting

**Implementation Notes -- Price Deduplication:**
- MUST use `getExistingPriceDates(commodityGuid, startDate, endDate)` to get existing dates as a Set
- Then iterate historical prices and skip any date already in the Set
- Do NOT use `INSERT ... ON CONFLICT` -- the prices table has NO unique constraint
- This follows the exact same pattern used by `fetchAndStorePrices()` and `detectAndFillGaps()` in yahoo-price-service.ts

**Implementation Notes -- getQuotableCommodities() Safety:**
- Because INDEX commodities have `quote_flag: 0`, they will NOT be returned by `getQuotableCommodities()` (which filters `quote_flag: 1`)
- Therefore `fetchAndStorePrices()` will never process them -- index price fetching is handled separately by this service
- No changes needed to `getQuotableCommodities()` filter

**TypeScript Interfaces:**
```typescript
export interface IndexPriceData {
  date: string;      // YYYY-MM-DD
  value: number;     // Absolute index value
  percentChange: number;  // % change from base date
}

export interface IndexHistoryResult {
  symbol: string;
  name: string;
  data: IndexPriceData[];
}
```

**Acceptance Criteria:**
- Index commodities are created with exactly 9 fields (matching `commodities` table columns) if they do not exist
- `quote_flag` is set to 0, confirmed by querying back after insert
- Historical prices are fetched using migrated `fetchHistoricalPrices()` (chart endpoint) and stored using `getExistingPriceDates()` dedup pattern
- Price data can be retrieved for any date range
- Does not interfere with existing commodity/price queries (INDEX namespace + quote_flag=0)
- `generateGuid` is imported from `@/lib/gnucash` (or `@/lib/prisma`)

---

### Phase 2: Investment Data Enhancements

#### T2.1: Add Cash Detection to Portfolio API (Per-Account + Overall)
**File:** `src/app/api/investments/portfolio/route.ts`
**Action:** Detect BANK/ASSET sibling accounts under brokerage parents; calculate cash percentages per account AND overall

**Logic:**
1. For each parent account that contains STOCK/MUTUAL children, find sibling accounts of type BANK, ASSET, or CASH
2. Sum the balance of those cash accounts (using splits value_num/value_denom)
3. Calculate cash percentage per account: `cashBalance / (cashBalance + investmentValue) * 100`
4. Calculate overall/portfolio-wide totals by summing across all brokerage accounts
5. Return as `cashByAccount` and `overallCash` in the response:
```typescript
cashByAccount: Array<{
  parentGuid: string;
  parentName: string;
  parentPath: string;
  cashBalance: number;
  investmentValue: number;
  cashPercent: number;
}>;
overallCash: {
  totalCashBalance: number;
  totalInvestmentValue: number;
  totalValue: number;
  cashPercent: number;
};
```

**Acceptance Criteria:**
- Correctly identifies BANK/ASSET accounts that are siblings of STOCK/MUTUAL accounts
- Cash balance is calculated correctly from splits
- Per-account cash percentage is accurate relative to account value (cash + investments)
- Overall/portfolio-wide cash percentage sums all cash across all brokerage accounts vs total investment value
- Handles accounts with no cash siblings (cashPercent = 0)

#### T2.2: Add Industry/Sector Data to Portfolio API
**File:** `src/app/api/investments/portfolio/route.ts`
**Action:** Include sector/industry metadata in holdings response

**Logic:**
1. After building holdings, fetch metadata for each unique commodity from `gnucash_web_commodity_metadata`
2. For holdings without cached metadata, trigger a background refresh (don't block the response)
3. Aggregate sector exposure across all holdings, weighted by market value:
   - Individual stocks: 100% weight to their sector
   - ETFs/funds: Use sector_weights JSON to distribute market value across sectors
4. Return as `sectorExposure` in the response:
```typescript
sectorExposure: Array<{
  sector: string;
  value: number;
  percent: number;
}>
```

**Acceptance Criteria:**
- Sector data loads from cache for fast responses
- Missing metadata triggers async refresh without blocking
- ETF sector weights are properly distributed (e.g., $10k in VOO with 28% tech = $2.8k tech)
- Sectors are aggregated correctly across all holdings
- "Unknown" sector for commodities without metadata

#### T2.3: Implement Commodity Deduplication in Portfolio API
**File:** `src/app/api/investments/portfolio/route.ts`
**Action:** Group holdings by `commodity_guid` and return both consolidated and per-account data

**Logic:**
1. After building individual holdings, group by `commodity_guid`
2. For each commodity group, create a consolidated entry:
   - `totalShares`: sum of all accounts' shares
   - `totalCostBasis`: sum of all accounts' cost basis
   - `totalMarketValue`: sum of all accounts' market value
   - `accounts`: array of per-account breakdowns with full account path
3. Return as `consolidatedHoldings` alongside existing `holdings`:
```typescript
consolidatedHoldings: Array<{
  commodityGuid: string;
  symbol: string;
  fullname: string;
  totalShares: number;
  totalCostBasis: number;
  totalMarketValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  latestPrice: number;
  priceDate: string;
  accounts: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
  }>;
}>
```

**Acceptance Criteria:**
- Same commodity across multiple accounts is collapsed into one row
- Total values are mathematically correct sums
- Per-account breakdown is available for expansion
- Single-account commodities still work (accounts array has one entry)
- Sorting works on consolidated values

#### T2.4: Build CashAllocationCard Component (Per-Account + Overall)
**File:** `src/components/investments/CashAllocationCard.tsx` (NEW)
**Action:** Display cash percentage per brokerage account AND an overall/total row

**Design:**
- Card layout similar to PortfolioSummaryCards
- Each brokerage account shows: name, cash balance, investment value, cash %
- **Overall/Total row** at the top or bottom showing portfolio-wide totals: total cash, total investments, overall cash %
- Visual bar showing cash vs. investment split per row
- Color coding: green if cash < 10%, yellow 10-20%, red > 20% (configurable thresholds)
- Overall row visually distinguished (bold, slightly larger, separator line)

**Acceptance Criteria:**
- Renders one row per brokerage account with cash
- Renders an overall/total row showing portfolio-wide cash percentage
- Overall row correctly sums all per-account values
- Percentage bar is visually clear
- Handles edge cases: all cash, no cash, zero total value

#### T2.5: Build IndustryExposureChart Component
**File:** `src/components/investments/IndustryExposureChart.tsx` (NEW)
**Action:** Horizontal bar chart showing sector/industry allocation

**Design:**
- Recharts horizontal BarChart
- Sectors sorted by value descending
- Each bar shows: sector name, dollar value, percentage
- Color-coded bars (consistent colors per sector)
- Wrap in ExpandableChart for modal expansion
- Loading state while metadata is being fetched

**Acceptance Criteria:**
- Displays all sectors with correct percentages
- Percentages sum to ~100% (within rounding)
- Handles "Unknown" sector gracefully
- Responsive layout
- Works in both compact and expanded modes

#### T2.6: Refactor HoldingsTable for Grouped Rows
**File:** `src/components/investments/HoldingsTable.tsx`
**Action:** Support consolidated view with expandable commodity groups

**Design:**
- Default view shows consolidated rows (one per commodity)
- Click a row to expand and show per-account breakdown (indented sub-rows)
- Expanded sub-rows show account path instead of symbol
- Chevron icon indicates expandable rows (only for multi-account commodities)
- Maintain sort functionality on consolidated values
- Keep existing click-to-navigate behavior on sub-rows (navigate to account ledger)

**Implementation:**
- Accept new `consolidatedHoldings` prop in addition to existing `holdings`
- When `consolidatedHoldings` is provided, use grouped view
- Track expanded state per commodity: `expandedCommodities: Set<string>`
- Sub-rows use lighter background to visually nest

**Acceptance Criteria:**
- Single-account commodities render as normal rows (no expand icon)
- Multi-account commodities show expand/collapse chevron
- Expanded rows show per-account details with full account path
- Sort applies to consolidated totals
- Sub-row click navigates to the specific account ledger

---

### Phase 3: Market Index Comparison & Profile Settings

#### T3.1: Add Market Index Data to History API
**File:** `src/app/api/investments/history/route.ts`
**Action:** Include S&P 500 and DJIA historical data in the response

**Logic:**
1. After computing portfolio history, query index prices from the same date range
2. Import `getIndexHistory`, `normalizeToPercent` from `@/lib/market-index-service`
3. Normalize both indices to % change from the start of the selected period
4. Return alongside portfolio history:
```typescript
// Response type
interface InvestmentHistoryResponse {
  history: Array<{ date: string; value: number }>;
  indices: {
    sp500: IndexPriceData[];   // from market-index-service types
    djia: IndexPriceData[];
  };
}
```

**Acceptance Criteria:**
- Index data aligns with portfolio date range
- Percent change calculation is from the first date in the range
- Missing index data for some dates is handled (forward-fill or skip)
- Response size is reasonable (indices add ~2x data points)

#### T3.2: Create User Preferences API and Service
**File:** `src/lib/user-preferences.ts` (NEW service)
**Also create:** `src/app/api/user/preferences/route.ts` (NEW API endpoint)
**Action:** CRUD service for reading/writing user preferences from `gnucash_web_user_preferences`

**Service functions (`src/lib/user-preferences.ts`):**
```typescript
// Get a single preference (returns parsed JSON value or default)
async function getPreference<T>(userId: number, key: string, defaultValue: T): Promise<T>;

// Get all preferences for a user (returns Record<string, unknown>)
async function getAllPreferences(userId: number): Promise<Record<string, unknown>>;

// Set a single preference (upserts)
async function setPreference(userId: number, key: string, value: unknown): Promise<void>;

// Set multiple preferences at once
async function setPreferences(userId: number, preferences: Record<string, unknown>): Promise<void>;

// Get performance chart defaults specifically
async function getChartDefaults(userId: number): Promise<ChartDefaults>;
```

**ChartDefaults interface:**
```typescript
interface ChartDefaults {
  sp500Enabled: boolean;      // default: false
  djiaEnabled: boolean;       // default: false
  defaultPeriod: string;      // default: "1Y"
  defaultMode: 'dollar' | 'percent';  // default: "dollar"
}
```

**API endpoint (`src/app/api/user/preferences/route.ts`):**
- `GET /api/user/preferences` -- Returns all preferences for current user
- `GET /api/user/preferences?key=performance_chart.*` -- Returns preferences matching key prefix
- `PUT /api/user/preferences` -- Upsert one or more preferences
  ```json
  { "preferences": { "performance_chart.sp500_default": true, "performance_chart.default_period": "6M" } }
  ```

**Acceptance Criteria:**
- Preferences are stored per-user with key-value flexibility
- GET returns parsed JSON values (not raw strings)
- PUT upserts (creates if not exists, updates if exists)
- Default values are returned when no preference is stored
- API requires authentication (uses existing auth middleware)

#### T3.3: Update PerformanceChart with Comparison Lines + Profile Defaults
**File:** `src/components/investments/PerformanceChart.tsx`
**Action:** Add toggleable S&P 500 and DJIA overlay lines with profile-based defaults

**Design:**
- Two toggle buttons: "S&P 500" and "DJIA" (default state loaded from user preferences)
- On first render, fetch defaults from `GET /api/user/preferences?key=performance_chart.*`
- Default time period and mode ($/%) also loaded from preferences
- When toggled on, show as additional Line on the chart
- In `% Change` mode: all three lines start at 0% for easy comparison -- this is the primary comparison mode
- In `$ Value` mode: index lines are **hidden** (index absolute values are not meaningful alongside portfolio dollar values). Show a subtle tooltip hint: "Switch to % mode for index comparison"
- Distinct colors: Portfolio = cyan, S&P 500 = orange, DJIA = purple
- Legend updates to show active lines
- Toggle buttons are disabled/grayed in $ mode with tooltip explaining why

**Acceptance Criteria:**
- Toggle buttons appear next to existing $/% buttons
- Default toggle states loaded from user preferences on mount
- Default time period and mode loaded from user preferences on mount
- If no preferences saved, defaults to: both off, 1Y period, $ mode
- Index lines render correctly aligned with portfolio dates
- % change mode properly normalizes all series to same start point
- Index lines hidden in $ value mode with clear UX indication
- Tooltip shows values for all active lines in % mode

#### T3.4: Build Chart Settings UI
**File:** `src/components/investments/ChartSettingsPanel.tsx` (NEW)
**Action:** Settings panel for configuring performance chart defaults

**Design:**
- Gear icon button in the top-right of the PerformanceChart component
- Clicking gear opens a dropdown/popover panel with settings:
  - **Default Comparison Lines**: Checkboxes for "S&P 500 on by default" and "DJIA on by default"
  - **Default Time Period**: Select dropdown with options: 1M, 3M, 6M, 1Y, 5Y, ALL
  - **Default Display Mode**: Radio buttons for "$ Value" and "% Change"
- "Save" button persists to `PUT /api/user/preferences`
- Settings take effect immediately on the current chart
- Subtle toast confirmation on save

**Implementation:**
- Reads current preferences on mount via `GET /api/user/preferences`
- On save, calls `PUT /api/user/preferences` and updates parent component state
- Parent `PerformanceChart` passes down current settings and an `onSettingsChange` callback

**Acceptance Criteria:**
- Gear icon is visible on the performance chart
- Panel opens/closes cleanly
- All four settings are editable and persist to DB
- Settings apply immediately to the current chart view
- Next page load reflects saved settings
- Settings are per-user (different users see their own defaults)

---

### Phase 4: Fixed Asset Tracking

#### T4.1: Create Fixed Assets Page and Navigation
**File:** `src/app/(main)/assets/page.tsx` (NEW)
**Action:** New page for viewing and managing fixed asset accounts and their depreciation/appreciation transactions

**Also update:** `src/components/Layout.tsx` -- add "Assets" to sidebar navigation

**Navigation update details (CRITICAL -- navigation is NOT in layout.tsx):**
The sidebar navigation lives in `src/components/Layout.tsx`, NOT `src/app/(main)/layout.tsx`. Specifically:

1. **Create a new `IconBuilding` icon component** (lines ~11-97 area) following the existing inline SVG pattern:
```typescript
function IconBuilding({ className = "w-5 h-5" }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
        </svg>
    );
}
```

2. **Add to `iconMap`** (line ~104-112):
```typescript
const iconMap: Record<string, ({ className }: { className?: string }) => ReactElement> = {
    LayoutDashboard: IconLayoutDashboard,
    List: IconList,
    BookOpen: IconBookOpen,
    TrendingUp: IconTrendingUp,
    PiggyBank: IconPiggyBank,
    BarChart3: IconBarChart3,
    ArrowUpDown: IconArrowUpDown,
    Building: IconBuilding,          // NEW
};
```

3. **Add to `navItems`** (line ~118-126), after "Investments":
```typescript
const navItems = [
    { name: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard' },
    { name: 'Account Hierarchy', href: '/accounts', icon: 'List' },
    { name: 'General Ledger', href: '/ledger', icon: 'BookOpen' },
    { name: 'Investments', href: '/investments', icon: 'TrendingUp' },
    { name: 'Assets', href: '/assets', icon: 'Building' },          // NEW
    { name: 'Budgets', href: '/budgets', icon: 'PiggyBank' },
    { name: 'Reports', href: '/reports', icon: 'BarChart3' },
    { name: 'Import/Export', href: '/import-export', icon: 'ArrowUpDown' },
];
```

**Page Design:**
- Header: "Fixed Assets" with "Record Valuation Change" button
- List of tracked fixed asset accounts (GnuCash ASSET accounts that are not investment-related, not bank accounts)
- Each asset card shows:
  - Account name and path
  - **Current balance** (from GnuCash account balance, which reflects all transactions including depreciation/appreciation)
  - Last transaction date
  - Depreciation schedule status (configured/not configured)
  - Trend indicator (up/down based on recent transactions)
- Click through to asset detail view (T4.4)

**API endpoint needed:** `src/app/api/assets/fixed/route.ts` (NEW)
- `GET /api/assets/fixed` -- Returns ASSET-type accounts likely to be fixed assets (excludes investment siblings, bank accounts)
- For each account, includes: current balance (sum of splits), depreciation schedule if configured, last transaction date

**Acceptance Criteria:**
- "Assets" nav item appears in sidebar between "Investments" and "Budgets"
- Nav item has a building icon that follows the existing inline SVG pattern
- Page accessible from sidebar navigation on both desktop and mobile
- Shows ASSET-type accounts that are likely fixed assets (not bank accounts, not investment siblings)
- Each asset shows current balance calculated from GnuCash transactions (NOT from a separate valuations table)
- Shows depreciation schedule status

#### T4.2: Create Depreciation/Appreciation Transaction Service
**File:** `src/lib/asset-transaction-service.ts` (NEW)
**Action:** Service to create depreciation or appreciation transactions in GnuCash for fixed asset accounts

**This is the core architectural change: value changes are real GnuCash transactions, not entries in a separate table.**

**How it works:**
- **Depreciation** (assets losing value, e.g., vehicles):
  - Creates a transaction that CREDITS the fixed asset account (reducing its balance)
  - DEBITS an expense account (e.g., "Expenses:Depreciation")
  - The asset account balance decreases, reflecting the lower value
- **Appreciation** (assets gaining value, e.g., real estate):
  - Creates a transaction that DEBITS the fixed asset account (increasing its balance)
  - CREDITS an income/unrealized gains account (e.g., "Income:Unrealized Gains")
  - The asset account balance increases, reflecting the higher value
- **Manual valuation adjustment**:
  - User specifies the new desired value; service calculates the difference from current balance
  - Creates appropriate depreciation or appreciation transaction for the delta

**Key functions:**
```typescript
// Create a single depreciation/appreciation transaction
async function createValuationTransaction(params: {
  assetAccountGuid: string;       // The fixed asset account
  contraAccountGuid: string;      // Expense (depreciation) or Income (appreciation) account
  amount: number;                 // Positive number = the change amount
  type: 'depreciation' | 'appreciation';
  date: string;                   // YYYY-MM-DD
  description?: string;
  memo?: string;
}): Promise<{ transactionGuid: string }>;

// Adjust asset to a specific target value (calculates delta from current balance)
async function adjustToTargetValue(params: {
  assetAccountGuid: string;
  contraAccountGuid: string;
  targetValue: number;
  date: string;
  description?: string;
}): Promise<{ transactionGuid: string; adjustmentAmount: number; type: 'depreciation' | 'appreciation' }>;

// Auto-generate transactions from depreciation schedule up to a given date
async function processDepreciationSchedule(
  scheduleId: number,
  upToDate?: Date
): Promise<{ transactionsCreated: number; newBalance: number }>;

// Get current balance of an asset account (sum of all splits)
async function getAssetBalance(accountGuid: string): Promise<number>;
```

**Transaction creation pattern (follows existing `POST /api/transactions` pattern):**
```typescript
// Example: Depreciation of $500 on a vehicle
const request: CreateTransactionRequest = {
  currency_guid: currencyGuid,  // USD guid
  post_date: '2026-02-01',
  description: 'Monthly depreciation: Honda Civic',
  splits: [
    {
      account_guid: assetAccountGuid,   // "Assets:Fixed Assets:Honda Civic"
      value_num: -50000,                // -500.00 (credit, reduces asset)
      value_denom: 100,
      memo: 'Straight-line depreciation',
    },
    {
      account_guid: expenseAccountGuid, // "Expenses:Depreciation"
      value_num: 50000,                 // +500.00 (debit, expense)
      value_denom: 100,
      memo: 'Straight-line depreciation',
    },
  ],
};
```

**Also create:** `src/app/api/assets/transactions/route.ts` (NEW)
- `POST /api/assets/transactions` -- Create a depreciation/appreciation transaction
- `POST /api/assets/transactions/adjust` -- Adjust to target value
- `POST /api/assets/transactions/process-schedule` -- Process pending depreciation schedule transactions

**Acceptance Criteria:**
- Creates valid double-entry GnuCash transactions (splits sum to zero)
- Depreciation transaction reduces asset balance and debits expense account
- Appreciation transaction increases asset balance and credits income account
- Target value adjustment calculates correct delta from current balance
- Schedule processing creates transactions for each period since last_transaction_date
- Uses existing `validateTransaction()` and transaction creation pattern
- All transactions are auditable via `logAudit()`
- Generated transactions are visible in GnuCash desktop

#### T4.3: Build Depreciation Schedule Configuration Form
**File:** `src/components/assets/DepreciationScheduleForm.tsx` (NEW)
**Also create:** `src/app/api/assets/schedules/route.ts` (NEW) -- GET/POST/PUT endpoint
**Action:** Form for configuring a depreciation/appreciation schedule on a fixed asset account

**Design:**
- Asset account selector (filtered to ASSET-type accounts)
- Schedule type toggle: "Depreciation" (default) or "Appreciation"
- Purchase price input
- Purchase date picker
- Useful life (years) input
- Salvage value input (defaults to 0)
- Method dropdown: "Straight-Line" or "Declining Balance"
  - If declining balance: additional rate input (defaults to 2/useful life)
- Contra account selector:
  - For depreciation: filtered to EXPENSE-type accounts (e.g., "Expenses:Depreciation")
  - For appreciation: filtered to INCOME-type accounts (e.g., "Income:Unrealized Gains")
- Frequency dropdown: Monthly, Quarterly, Yearly
- Notes field (optional)
- "Save Schedule" button
- "Generate Pending Transactions" button (creates all transactions from purchase date to today based on schedule)

**API endpoints (`src/app/api/assets/schedules/route.ts`):**
- `GET /api/assets/schedules?accountGuid=X` -- Get schedule for an account
- `GET /api/assets/schedules` -- Get all schedules
- `POST /api/assets/schedules` -- Create a new schedule
- `PUT /api/assets/schedules/[id]` -- Update an existing schedule

**Acceptance Criteria:**
- Form validates all required fields
- Contra account type changes based on depreciation vs appreciation
- Schedule is saved to `gnucash_web_depreciation_schedules` table
- Only one schedule per account (upsert behavior)
- "Generate Pending Transactions" creates transactions for all past periods
- Schedule preview shows projected values over time before saving

#### T4.4: Build Fixed Asset Detail View with Transaction History
**File:** `src/app/(main)/assets/[guid]/page.tsx` (NEW)
**Also create:** `src/components/assets/AssetDetailView.tsx` (NEW)
**Action:** Detail page for a single fixed asset showing value history via transaction log

**Design:**
- Header: Asset name, current balance (from account balance), account path
- **Value Chart**: Recharts LineChart showing balance over time
  - X-axis: dates of transactions
  - Y-axis: running balance after each transaction
  - This is effectively the same as an account ledger running balance chart
- **Transaction History Table**: Shows all transactions for this account
  - Columns: Date, Description, Amount, Running Balance, Source (manual/scheduled)
  - Sorted by date descending
  - Each row shows whether it was manually entered or auto-generated from schedule
- **Depreciation Schedule Card** (if schedule configured):
  - Shows current schedule parameters (method, useful life, frequency, etc.)
  - "Edit Schedule" button
  - "Process Pending" button (generates any missing transactions)
  - Next scheduled transaction date and amount
- **Manual Adjustment Section**:
  - "Record Valuation Change" button opens a form:
    - New value OR change amount input
    - Date picker
    - Contra account selector
    - Notes
    - Creates a transaction via T4.2 service

**Acceptance Criteria:**
- Shows current asset value (= account balance from GnuCash splits)
- Value history chart reflects actual transaction history
- Transaction table shows all depreciation/appreciation transactions
- Manual adjustment creates a real GnuCash transaction
- Schedule card shows configuration and allows processing pending transactions
- Navigating here from the asset list works correctly

#### T4.5: Add Generic Depreciation Schedule Calculator Utility
**File:** `src/lib/depreciation.ts` (NEW)
**Action:** Pure calculation utility for depreciation/appreciation schedules (no DB interaction)

**Methods:**
- Straight-line: `(purchasePrice - salvageValue) / usefulLifeYears`
- Declining balance: `currentValue * (depreciationRate)`

**Interface:**
```typescript
interface DepreciationConfig {
  purchasePrice: number;
  purchaseDate: Date;
  salvageValue: number;
  usefulLifeYears: number;
  method: 'straight-line' | 'declining-balance';
  declineRate?: number; // For declining balance, default 2/usefulLife
  frequency: 'monthly' | 'quarterly' | 'yearly';
  isAppreciation?: boolean; // If true, values increase instead of decrease
}

// Calculate value at a specific point in time
function calculateValueAtDate(config: DepreciationConfig, asOfDate?: Date): number;

// Generate full schedule of periodic amounts
function generateSchedule(config: DepreciationConfig): Array<{
  date: Date;
  periodAmount: number;  // Amount for this period (always positive)
  cumulativeAmount: number;  // Total depreciation/appreciation to date
  bookValue: number;  // Asset value after this period
}>;

// Calculate period amount for a specific date
function getPeriodAmount(config: DepreciationConfig, periodDate: Date): number;
```

**Acceptance Criteria:**
- Straight-line depreciation calculates correctly
- Declining balance depreciation calculates correctly
- Value never goes below salvage value (for depreciation)
- Works for any as-of date (past, present, future)
- Frequency correctly determines period boundaries (monthly/quarterly/yearly)
- Appreciation mode (isAppreciation=true) increases values instead of decreasing

---

### Phase 5: Integration & Polish

#### T5.1: Update Investments Page Layout
**File:** `src/app/(main)/investments/page.tsx`
**Action:** Incorporate new components into the page layout

**Layout changes:**
1. Add CashAllocationCard below summary cards (collapsible section) -- includes overall row
2. Replace AllocationChart with a tabbed view: "By Account" (pie) | "By Sector" (bar)
3. Pass `consolidatedHoldings` to HoldingsTable
4. Pass index data to PerformanceChart
5. PerformanceChart loads profile defaults on mount

**Acceptance Criteria:**
- All new components render correctly
- Page layout is not cluttered
- Loading states are smooth
- No layout shift when data loads
- CashAllocationCard shows both per-account and overall rows

#### T5.2: Update Price Fetch to Include Indices
**File:** `src/app/api/prices/fetch/route.ts`
**Action:** Add index price fetching AFTER the main commodity fetch

**Implementation:**
- Import `ensureIndexCommodities` and `fetchIndexPrices` from `@/lib/market-index-service`
- After the existing `fetchAndStorePrices()` call completes, call `fetchIndexPrices()` in a try/catch
- Do NOT modify `getQuotableCommodities()` or `fetchAndStorePrices()` -- keep index logic separate
- If index fetching fails, still return success for the main commodity prices with a warning field

**Also update:** `src/lib/price-service.ts` -- re-export the new market-index-service functions through the facade:
```typescript
// Add to price-service.ts
export {
  ensureIndexCommodities,
  fetchIndexPrices,
  getIndexHistory,
  normalizeToPercent,
} from './market-index-service';

export type {
  IndexPriceData,
  IndexHistoryResult,
} from './market-index-service';
```

**Acceptance Criteria:**
- "Refresh All Prices" button also fetches S&P 500 and DJIA prices
- Index prices are stored with proper deduplication (getExistingPriceDates pattern)
- Failure to fetch index prices does not block regular price updates
- Market index functions are accessible via the price-service facade

#### T5.3: Loading States and Error Handling
**Files:** All new components
**Action:** Ensure all new features have proper loading/error states

**Checklist:**
- [ ] CashAllocationCard: skeleton loader while portfolio loads; overall row loads with per-account data
- [ ] IndustryExposureChart: loading spinner while metadata fetches; "No sector data available" fallback
- [ ] HoldingsTable grouped view: handles empty `consolidatedHoldings` gracefully
- [ ] PerformanceChart index lines: handles missing index data (just don't render the line)
- [ ] PerformanceChart settings: handles preference load failure (falls back to defaults)
- [ ] ChartSettingsPanel: save confirmation toast, error handling on save failure
- [ ] Fixed assets page: handles no assets state, handles no transactions state
- [ ] Depreciation schedule form: disabled submit during save, validation feedback
- [ ] Asset detail view: handles no transactions, handles no schedule
- [ ] Manual valuation adjustment: disabled submit during save, error toast on failure

**Acceptance Criteria:**
- No unhandled errors in console
- All loading states are visible and smooth
- Error states provide actionable information

---

## TypeScript Interfaces Summary

New interfaces to define (in appropriate locations):

| Interface | Location | Purpose |
|-----------|----------|---------|
| `IndexPriceData` | `src/lib/market-index-service.ts` | Single index price data point |
| `IndexHistoryResult` | `src/lib/market-index-service.ts` | Full index history response |
| `DepreciationConfig` | `src/lib/depreciation.ts` | Depreciation/appreciation calculation config |
| `DepreciationSchedule` | `src/lib/types.ts` | DB row from gnucash_web_depreciation_schedules |
| `ChartDefaults` | `src/lib/user-preferences.ts` | Performance chart default settings |
| `InvestmentHistoryResponse` | `src/app/api/investments/history/route.ts` | Extended history API response |
| `CashByAccount` | `src/app/api/investments/portfolio/route.ts` | Per-account cash allocation data |
| `OverallCash` | `src/app/api/investments/portfolio/route.ts` | Portfolio-wide cash totals |
| `SectorExposure` | `src/app/api/investments/portfolio/route.ts` | Sector breakdown data |
| `ConsolidatedHolding` | `src/app/api/investments/portfolio/route.ts` | Deduplicated holding row |
| `CreateValuationTransactionRequest` | `src/lib/asset-transaction-service.ts` | Request to create depreciation/appreciation tx |
| `UserPreference` | `src/lib/user-preferences.ts` | Single preference key-value pair |

---

## API Endpoints Summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/investments/portfolio` | Extended with cash (per-account + overall), sectors, consolidated holdings |
| GET | `/api/investments/history` | Extended with index comparison data |
| POST | `/api/investments/metadata/refresh` | NEW: Trigger commodity metadata refresh |
| GET | `/api/user/preferences` | NEW: Get user preferences (supports key prefix filter) |
| PUT | `/api/user/preferences` | NEW: Upsert user preferences |
| GET | `/api/assets/fixed` | NEW: List fixed asset accounts with balances |
| GET | `/api/assets/schedules` | NEW: Get all depreciation schedules |
| GET | `/api/assets/schedules?accountGuid=X` | NEW: Get schedule for specific account |
| POST | `/api/assets/schedules` | NEW: Create a depreciation schedule |
| PUT | `/api/assets/schedules/[id]` | NEW: Update a depreciation schedule |
| POST | `/api/assets/transactions` | NEW: Create depreciation/appreciation transaction |
| POST | `/api/assets/transactions/adjust` | NEW: Adjust asset to target value |
| POST | `/api/assets/transactions/process-schedule` | NEW: Process pending schedule transactions |

---

## New Files Summary

| File | Type | Purpose |
|------|------|---------|
| `src/lib/commodity-metadata.ts` | Service | Yahoo Finance sector/industry cache |
| `src/lib/market-index-service.ts` | Service | ^GSPC/^DJI commodity + price management |
| `src/lib/depreciation.ts` | Utility | Generic depreciation/appreciation schedule calculator |
| `src/lib/asset-transaction-service.ts` | Service | Create depreciation/appreciation GnuCash transactions |
| `src/lib/user-preferences.ts` | Service | User preference CRUD for chart defaults |
| `src/components/investments/CashAllocationCard.tsx` | Component | Cash % per brokerage + overall total |
| `src/components/investments/IndustryExposureChart.tsx` | Component | Sector bar chart |
| `src/components/investments/ChartSettingsPanel.tsx` | Component | Gear icon settings for performance chart defaults |
| `src/components/assets/DepreciationScheduleForm.tsx` | Component | Depreciation/appreciation schedule config |
| `src/components/assets/AssetDetailView.tsx` | Component | Fixed asset detail with value chart + tx history |
| `src/app/(main)/assets/page.tsx` | Page | Fixed assets dashboard |
| `src/app/(main)/assets/[guid]/page.tsx` | Page | Individual fixed asset detail |
| `src/app/api/investments/metadata/refresh/route.ts` | API | Metadata refresh trigger |
| `src/app/api/user/preferences/route.ts` | API | User preferences CRUD |
| `src/app/api/assets/fixed/route.ts` | API | Fixed asset accounts listing |
| `src/app/api/assets/schedules/route.ts` | API | Depreciation schedule CRUD |
| `src/app/api/assets/transactions/route.ts` | API | Depreciation/appreciation transaction creation |

---

## Modified Files Summary

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add 3 new gnucash_web_* models (commodity_metadata, depreciation_schedules, user_preferences) |
| `src/lib/db-init.ts` | Add CREATE TABLE for gnucash_web_commodity_metadata, gnucash_web_depreciation_schedules, and gnucash_web_user_preferences |
| `src/lib/yahoo-price-service.ts` | Migrate `fetchHistoricalPrices()` from `historical()` to `chart()` endpoint |
| `src/app/api/investments/portfolio/route.ts` | Add cash detection (per-account + overall), sectors, consolidated holdings |
| `src/app/api/investments/history/route.ts` | Add index comparison data |
| `src/app/api/prices/fetch/route.ts` | Add index price fetching after main fetch |
| `src/app/(main)/investments/page.tsx` | New components, tabbed allocation, consolidated holdings, chart settings |
| `src/components/Layout.tsx` | Add IconBuilding component + "Assets" to iconMap + navItems |
| `src/components/investments/HoldingsTable.tsx` | Grouped/expandable rows |
| `src/components/investments/PerformanceChart.tsx` | Index comparison lines + toggles (% mode only) + profile defaults + settings gear |
| `src/lib/price-service.ts` | Re-export market-index-service functions through facade |
| `src/lib/types.ts` | Add DepreciationSchedule and other new interfaces |

---

## Commit Strategy

1. **`fix(prices): migrate Yahoo Finance from deprecated historical() to chart() endpoint`**
   - `src/lib/yahoo-price-service.ts` -- replace `historical()` with `chart()` in `fetchHistoricalPrices()`
   - T1.0

2. **`feat(db): add commodity metadata, depreciation schedules, and user preferences tables`**
   - Prisma schema models + CREATE TABLE in `src/lib/db-init.ts`
   - T1.1, T1.2, T1.3

3. **`feat(investments): add commodity metadata service with Yahoo Finance integration`**
   - `src/lib/commodity-metadata.ts`
   - T1.4

4. **`feat(investments): add market index tracking service`**
   - `src/lib/market-index-service.ts`
   - Update `src/lib/price-service.ts` facade to re-export
   - T1.5

5. **`feat(investments): add cash visibility to portfolio API with overall totals`**
   - Portfolio API changes + CashAllocationCard component (per-account + overall)
   - T2.1, T2.4

6. **`feat(investments): add industry/sector exposure analysis`**
   - Portfolio API sector data + IndustryExposureChart component
   - T2.2, T2.5

7. **`feat(investments): deduplicate holdings by commodity`**
   - Portfolio API consolidation + HoldingsTable grouped view
   - T2.3, T2.6

8. **`feat(investments): add S&P 500 and DJIA comparison to performance chart`**
   - History API index data + PerformanceChart update
   - T3.1, T3.3

9. **`feat(settings): add user preferences service and performance chart profile settings`**
   - User preferences service + API + ChartSettingsPanel component
   - T3.2, T3.4

10. **`feat(assets): add fixed asset page with transaction-based valuation tracking`**
    - Fixed assets page, navigation, asset detail view
    - Asset transaction service, depreciation schedule form
    - Depreciation calculator utility
    - Update `src/components/Layout.tsx` navigation
    - T4.1, T4.2, T4.3, T4.4, T4.5

11. **`feat(investments): integrate all new features into dashboard`**
    - Page layout update, price fetch update, polish
    - T5.1, T5.2, T5.3

---

## Risk Assessment

### High Risk
- **Yahoo Finance rate limiting**: `quoteSummary` calls for sector data could hit rate limits if many commodities. **Mitigation**: Cache aggressively (7-day TTL), batch requests, add retry with backoff.
- **Transaction creation for fixed assets**: Creating transactions changes the app from read-only to read-write for fixed asset accounts. Incorrect transactions could corrupt GnuCash data. **Mitigation**: Use existing `validateTransaction()` for double-entry validation; all transactions go through the same `POST /api/transactions` pattern already proven for investment transactions; audit logging via `logAudit()` for all generated transactions; no direct SQL -- use Prisma $transaction for atomicity.

### Medium Risk
- **Yahoo Finance API changes**: yahoo-finance2 library could break if Yahoo changes their endpoints. The `historical()` endpoint is already deprecated (T1.0 migrates to `chart()`). **Mitigation**: Pin library version, graceful fallback to "Unknown" sector, monitor for `chart()` endpoint changes.
- **Index commodity creation**: Creating commodities in GnuCash's table could confuse the desktop GnuCash app. **Mitigation**: Use `INDEX` namespace which GnuCash desktop ignores; set `quote_flag=0` to prevent GnuCash Finance::Quote from processing them; all required fields populated to avoid null-related issues in desktop app.
- **Prisma migration on GnuCash DB**: New `gnucash_web_*` tables require migration. **Mitigation**: Use `CREATE TABLE IF NOT EXISTS` in `src/lib/db-init.ts` (which runs on app startup) instead of `prisma db push` (which fails on GnuCash DBs due to foreign key constraints). Add the Prisma models for client generation only, run `prisma generate` (not `prisma db push`).
- **Auto-generated depreciation transactions**: If schedule is misconfigured, many incorrect transactions could be created. **Mitigation**: Preview mode before generation; limit batch size; clearly show how many transactions will be created; all transactions are reversible (delete via GnuCash or add offsetting transaction).

### Low Risk
- **User preferences table overhead**: Minimal -- key-value store with small data size. No performance concern.
- **Overall cash calculation accuracy**: Depends on correctly identifying brokerage cash accounts. **Mitigation**: Use same sibling-detection logic as per-account; document expected account structure.

---

## Success Criteria

1. **Yahoo Finance Migration**: `fetchHistoricalPrices()` works reliably using `chart()` endpoint; no more `historical()` deprecation errors
2. **Cash Visibility**: User can see what percentage of each brokerage account is in cash, AND the overall portfolio-wide cash percentage, at a glance
3. **Sector Analysis**: User can see their portfolio's sector allocation in a bar chart, with ETF holdings properly decomposed into constituent sectors
4. **Consolidated View**: Holdings table shows one row per commodity regardless of how many accounts hold it, with drill-down to see per-account distribution
5. **Benchmark Comparison**: User can toggle S&P 500 and/or DJIA lines on the performance chart (in % mode) to compare portfolio returns against market indices
6. **Chart Profile Settings**: User can configure default comparison lines, time period, and display mode via a settings panel; settings persist across sessions
7. **Fixed Asset Tracking**: User can view fixed asset accounts with current balances; configure depreciation/appreciation schedules; create valuation adjustment transactions that are real GnuCash double-entry transactions
8. **Transaction-Based Valuations**: All fixed asset value changes are recorded as standard GnuCash transactions, visible in both the web app and GnuCash desktop
9. **No Regression**: Existing investment dashboard features (summary cards, allocation pie, performance chart, holdings table) continue to work correctly
10. **Performance**: Page load time does not increase significantly (sector data is cached, not fetched on every load; preferences loaded once on mount)
11. **Type Safety**: All new API endpoints have TypeScript interfaces for request/response shapes
