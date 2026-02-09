# Fix 13 Issues for GnuCash Web (Revised v2)

## Context

### Original Request
Fix 13 issues spanning dashboard accuracy (net worth, currency conversion, date filtering), UI improvements (expandable charts, dark mode toggle, chart resizing), data display fixes (investments zero-share holdings, historical price backfill), major feature work (Sankey restructure, budget improvements, Treasurer's Report), export fixes (print/CSV), and book management (name/description fields with editor UI).

### Research Findings

**Currency Conversion Infrastructure**: `src/lib/currency.ts` already has `findExchangeRate()` (line 92, accepts optional `date` param), `convertAmount()`, and `getBaseCurrency()` with support for direct rates, inverse rates, and triangulation via USD/EUR. The KPI and income-expense APIs do NOT use these utilities -- they sum `value_num/value_denom` raw without currency awareness. For the net-worth time series, a bulk-fetch pattern for currency prices (analogous to the investment price pattern at `net-worth/route.ts` lines 128-143) must be used to avoid N+1 queries per date point.

**Account Types - RECEIVABLE/PAYABLE**: Both `RECEIVABLE` and `PAYABLE` are used throughout the codebase:
- `src/components/AccountForm.tsx` lists RECEIVABLE as an Asset type and PAYABLE as a Liability type
- `src/lib/services/account.service.ts` (lines 25-26) includes both
- `src/lib/reports/cash-flow.ts` (lines 23-24) handles both
- `src/components/filters/AccountTypeFilter.tsx` classifies RECEIVABLE as emerald (asset) and PAYABLE as rose (liability)
**Decision**: Add `RECEIVABLE` to `ASSET_TYPES` and `PAYABLE` to `LIABILITY_TYPES` in both `kpis/route.ts` and `net-worth/route.ts`.

**Date Filtering Defaults** (corrected):
- `sankey/route.ts` (line 16): defaults to `new Date(now.getFullYear(), 0, 1)` -- start of CURRENT year
- `income-expense/route.ts` (line 44): defaults to `new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())` -- 1 year ago
- `kpis/route.ts` (line 20): defaults to 1 year ago
- `net-worth/route.ts` (line 40): defaults to 1 year ago
- All four APIs: `endDate` defaults to `new Date()` when `endDateParam` is null. This is intentional and correct -- "All Time" means from earliest data to now.

**ExpandableChart**: Already exists at `src/components/charts/ExpandableChart.tsx`. Uses `Modal` with `size="fullscreen"`. The modal renders `children` in both normal view (line 17) and the expanded modal (line 35) simultaneously. This is acceptable for Recharts because Recharts components are stateless renderers -- they re-render from data props each time without preserving internal state. The dual render means the normal view remains visible behind the modal overlay, which is standard modal behavior.

**Dashboard Charts**: 7 chart components exist on the dashboard page (`src/app/(main)/dashboard/page.tsx` lines 399-421). Each chart component renders its own card wrapper (e.g., `<div className="bg-surface border border-border rounded-xl p-6">`). None are currently wrapped with `ExpandableChart`.

**ThemeContext**: Fully implemented with light/dark/system support and `useTheme()` hook. Profile page has no theme toggle section.

**Investments**: Portfolio API at `src/app/api/investments/portfolio/route.ts` line 119 filters `h.shares !== 0`. The summary calculation (lines 122-139) happens AFTER this filter, so summary only includes active holdings.

**Budget Page**: Already has tree view with expand/collapse, "Show All Accounts" toggle (lines 588-596), and "Add Account" button (lines 507-515). Has expand all/collapse all buttons (lines 580-585). Budget amounts API at `src/app/api/budgets/[guid]/amounts/route.ts` supports PATCH for inline edits and DELETE for removing accounts. Missing: level selector, auto-expand to budgeted, Income/Expense/Transfer/Remaining footer rows, sign inversion for income display.

**Reports**: 5 report types exist in `src/lib/reports/types.ts`. `ReportViewer.tsx` has print CSS at lines 95-111 that uses `visibility: hidden` on `body *` then `visibility: visible` on `.print\:bg-white` descendants. This fails because of CSS spec: when a parent has `visibility: hidden`, child `visibility: visible` works, BUT the `position: absolute` at line 106 combined with the nested component structure causes the report content to not actually appear. The root cause is that `body *` hides everything, and the `.print\:bg-white` selector only matches the wrapper div at line 89, but its child content relies on the cascade which the `body *` rule overrides for non-matching elements. CSV export is a `TODO` stub at line 33.

**Sankey**: Currently flat -- API returns single-level `{ nodes: [], links: [] }` with income categories flowing proportionally to expense categories + Savings. Client receives flat nodes/links and passes directly to D3 SankeyChart.

---

## Work Objectives

### Core Objective
Fix all 13 issues to improve data accuracy, user experience, and feature completeness.

### Definition of Done
- Net worth displays correctly with multi-currency conversion using date-specific exchange rates
- "All Time" filter spans actual data range (earliest transaction to now)
- Income/Expense values converted to base currency
- All dashboard charts expandable and filling modal viewport
- Sankey shows multi-level hierarchy with client-side level selector
- Dark/Light mode toggle in profile settings
- Zero-share investments hidden by default with toggle
- "Refresh All Prices" fetches historical daily closing prices from last stored date to yesterday, fills gaps in last 3 months; never fetches current/real-time quotes
- Budget view improvements: level selector, auto-expand, 4-row footer, sign inversion
- Treasurer's Report fully functional with localStorage config
- Print uses `window.open()` approach; CSV export generates valid files
- Books have editable `name` and `description` fields with a book editor modal accessible from BookSwitcher
- All changes verified via build + visual checks

---

## Must Have / Must NOT Have

### Must Have
- Currency conversion using existing `findExchangeRate()` / `convertAmount()` from `src/lib/currency.ts`
- Date-specific exchange rates for net-worth time series (not a single latest rate)
- `RECEIVABLE` in ASSET_TYPES, `PAYABLE` in LIABILITY_TYPES
- Backward compatibility -- existing features must not regress
- Consistent UI patterns (use existing components like `ExpandableChart`, `Modal`, etc.)
- Proper TypeScript types for all new interfaces

### Must NOT Have
- Breaking changes to externally consumed API response shapes (internal BFF endpoints like `/api/dashboard/sankey` CAN evolve since they have a single internal consumer)
- New npm dependencies unless absolutely required
- Changes to the database schema (except for the books table name/description fields required by Issue 13)
- Changes to authentication/authorization

---

## Task Flow and Dependencies

```
Phase 1 (Quick Fixes - No Dependencies):
  [Issue 2] All Time filter fix
  [Issue 7] Dark/Light mode toggle
  [Issue 8] Zero-share investments toggle
  [Issue 12] Historical closing price backfill for Refresh All Prices (no real-time quotes)
  [Issue 13] Book name/description fields + editor modal

Phase 2 (Currency - Foundation for Accuracy):
  [Issue 1] Net Worth currency conversion  (depends on currency utility understanding)
  [Issue 3] Income/Expense currency conversion

Phase 3 (Dashboard UI):
  [Issue 4] ExpandableChart wrappers for dashboard
  [Issue 6] Charts fill expanded card  (depends on Issue 4)

Phase 4 (Medium Complexity):
  [Issue 11] Print and CSV export fix
  [Issue 9] Budget view improvements

Phase 5 (High Complexity):
  [Issue 5] Sankey multi-level restructure
  [Issue 10] Treasurer's Report
```

---

## Phase 1: Quick Fixes (Parallelizable)

### Task 1.1: Fix "All Time" Filter (Issue 2)

**Files to modify:**
- `src/app/api/dashboard/kpis/route.ts` (lines 18-20)
- `src/app/api/dashboard/net-worth/route.ts` (lines 38-40)
- `src/app/api/dashboard/income-expense/route.ts` (lines 42-44)
- `src/app/api/dashboard/sankey/route.ts` (lines 14-16)

**Current Defaults (corrected):**
- `sankey/route.ts`: defaults to start of CURRENT year (`new Date(now.getFullYear(), 0, 1)`)
- `income-expense/route.ts`: defaults to 1 year ago
- `kpis/route.ts`: defaults to 1 year ago
- `net-worth/route.ts`: defaults to 1 year ago
- All four: `endDate` defaults to `new Date()` when null. This is intentional and correct.

**Implementation:**
1. Create shared helper in `src/lib/date-utils.ts`:
   ```typescript
   import prisma from './prisma';

   export async function getEffectiveStartDate(startDateParam: string | null): Promise<Date> {
     if (startDateParam) return new Date(startDateParam);
     const earliest = await prisma.transactions.findFirst({
       orderBy: { post_date: 'asc' },
       where: { post_date: { not: null } },
       select: { post_date: true },
     });
     return earliest?.post_date || new Date(2000, 0, 1);
   }
   ```
2. Update all 4 routes to use `getEffectiveStartDate(startDateParam)` instead of their current hardcoded defaults.
3. Keep `endDate` defaulting to `new Date()` when `endDateParam` is null -- this is already correct behavior.

**Acceptance Criteria:**
- When "All Time" is selected (startDate=null), data spans from earliest transaction to now
- When specific dates provided, behavior unchanged
- Dashboard shows full history when "All Time" selected

---

### Task 1.2: Dark/Light Mode Toggle (Issue 7)

**Files to modify:**
- `src/app/(main)/profile/page.tsx` (add new section after line 172, before "Help Section")

**Implementation:**
1. Import `useTheme` from `@/contexts/ThemeContext`
2. Add a "Theme" section card between "Balance Display" and "Help Section":
   - Three radio options: Light, Dark, System
   - Use same card/radio pattern as the Balance Reversal section
   - Icon for each option (sun, moon, monitor)
3. Wire `setTheme()` from the hook
4. No API call needed -- ThemeContext already persists to localStorage

**Acceptance Criteria:**
- Theme toggle appears in profile settings
- Selecting Light/Dark/System applies immediately
- Theme persists across page reloads
- System option follows OS preference

---

### Task 1.3: Zero-Share Investments Toggle (Issue 8)

**Files to modify:**
- `src/app/api/investments/portfolio/route.ts` (line 119)
- `src/components/investments/HoldingsTable.tsx` (add toggle, filter logic)

**Decision**: Return ALL holdings from the API (remove the `.filter(h => h.shares !== 0)` at line 119). Filter client-side in HoldingsTable.

**Implementation:**
1. **API**: Remove the filter at line 119 (`.filter(h => h.shares !== 0)`) so API returns ALL holdings including zero-share.
2. **API summary**: The summary calculation at lines 122-139 must continue to compute over ALL holdings returned (which now includes zero-share). This means summary totals reflect the full portfolio including zero-share positions. Since zero-share positions have $0 market value and $0 gain/loss, they contribute nothing to the summary numbers -- so the result is mathematically identical.
3. **Cost basis fix**: In `src/lib/commodities.ts` `getAccountHoldings()`, when shares === 0, set costBasis and marketValue to 0:
   ```typescript
   const marketValue = shares === 0 ? 0 : calculateMarketValue(shares, pricePerShare);
   const effectiveCostBasis = shares === 0 ? 0 : costBasis;
   ```
4. **HoldingsTable**: Add `showZeroShares` state (default `false`)
5. **HoldingsTable**: Add toggle button in the header area: "Show Closed Positions"
6. **HoldingsTable**: Filter displayed holdings by `h.shares !== 0` when toggle is off
7. **Investments page**: Pass all holdings to HoldingsTable (remove any client-side filtering if present)

**Acceptance Criteria:**
- Zero-share stocks hidden by default
- Toggle reveals them with $0 market value and $0 cost basis
- Summary cards always reflect active holdings only (zero-share contributes $0 anyway)
- Toggle is clearly labeled "Show Closed Positions"

---

### Task 1.4: Historical Price Backfill for "Refresh All Prices" (Issue 12)

**Files to modify:**
- `src/lib/yahoo-price-service.ts` (lines 228-317: `fetchAndStorePrices`; add new functions)
- `src/lib/price-service.ts` (re-export new functions and types)
- `src/app/api/prices/fetch/route.ts` (lines 5-23: JSDoc; lines 26-29: schema; lines 56-71: response shape)
- `src/app/(main)/investments/page.tsx` (lines 95-120: `handleFetchAllPrices` response handling)

**Problem**: The "Refresh All Prices" button currently only fetches today's current market quote via `yahooFinance.quote()`. If the user hasn't refreshed in days/weeks, all intermediate daily prices are lost. There is no mechanism to backfill missing historical prices.

**Design Decision**: The Refresh All Prices button must ONLY store historical closing prices. It must NEVER fetch current/real-time quotes. The most recent price stored should always be yesterday's close. This ensures the price database contains only end-of-day settled prices, not intraday snapshots.

**Note on USD currency in `storeFetchedPrice()`**: The existing `storeFetchedPrice` function hardcodes `currency_guid` to USD. This is acceptable and intentional: Yahoo Finance returns USD-denominated prices for US equities, and this is consistent with how GnuCash desktop's `Finance::Quote` module stores prices. No change needed.

**Note on `force` parameter semantics**: `force=true` means "re-fetch the full 3-month historical window and INSERT any missing prices." It does NOT overwrite/upsert existing prices. If a price already exists for a given date, it is simply skipped. The use case is recovering from situations where earlier fetches may have been incomplete.

**Implementation:**

**Step 1: Add `getLastPriceDate()` function** (new function in `yahoo-price-service.ts`):
```typescript
/**
 * Get the most recent stored price date for a commodity
 * @param commodityGuid GUID of the commodity
 * @returns The most recent price date, or null if no prices exist
 */
export async function getLastPriceDate(commodityGuid: string): Promise<Date | null> {
  const { default: prisma } = await import('./prisma');

  const lastPrice = await prisma.prices.findFirst({
    where: { commodity_guid: commodityGuid },
    orderBy: { date: 'desc' },
    select: { date: true },
  });

  return lastPrice?.date ?? null;
}
```

**Step 2: Add `getExistingPriceDates()` helper** (new function in `yahoo-price-service.ts`):

This is the central deduplication mechanism. It fetches all stored price dates for a commodity in a given date range and returns them as a Set of `YYYY-MM-DD` strings. ALL code paths that store prices MUST check against this set before calling `storeFetchedPrice()`.

```typescript
/**
 * Get all existing price dates for a commodity in a date range.
 * Returns a Set of YYYY-MM-DD strings for O(1) dedup lookups.
 * @param commodityGuid GUID of the commodity
 * @param startDate Start of the date range (inclusive)
 * @param endDate End of the date range (inclusive)
 * @returns Set of date strings (YYYY-MM-DD) that already have prices stored
 */
async function getExistingPriceDates(
  commodityGuid: string,
  startDate: Date,
  endDate: Date
): Promise<Set<string>> {
  const { default: prisma } = await import('./prisma');

  const existing = await prisma.prices.findMany({
    where: {
      commodity_guid: commodityGuid,
      date: { gte: startDate, lte: endDate },
    },
    select: { date: true },
  });

  return new Set(existing.map(p => p.date.toISOString().split('T')[0]));
}
```

**Why this is needed**: The `prices` table has NO unique constraint on `(commodity_guid, date)`. `storeFetchedPrice()` does a raw `prisma.prices.create()` with no duplicate check. Without an `existingDates` set, every code path risks creating duplicate price entries for the same commodity on the same date. This helper is cheap (single indexed query) and prevents all duplicates.

**Step 3: Add `fetchHistoricalPrices()` function** (new function in `yahoo-price-service.ts`):

Uses proper `HistoricalRowHistory` type from yahoo-finance2 instead of inline types for filter/map callbacks.

```typescript
import type { HistoricalRowHistory } from 'yahoo-finance2';

/**
 * Fetch historical daily closing prices from Yahoo Finance for a date range
 * @param symbol Stock/commodity symbol
 * @param startDate Start of the date range (inclusive)
 * @param endDate End of the date range (inclusive) -- should be yesterday at latest
 * @returns Array of { date, close } objects, or empty array on failure
 */
export async function fetchHistoricalPrices(
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<Array<{ date: Date; close: number }>> {
  try {
    const yahooFinance = new YahooFinance();
    const result = await yahooFinance.historical(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    return result
      .filter((row: HistoricalRowHistory) => typeof row.close === 'number' && row.close > 0)
      .map((row: HistoricalRowHistory) => ({
        date: row.date,
        close: row.close!,
      }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to fetch historical prices for ${symbol}:`, msg);
    return [];
  }
}
```

**Step 4: Add `detectAndFillGaps()` function** (new function in `yahoo-price-service.ts`):

**Future optimization note**: In the normal (non-force) flow, `detectAndFillGaps` makes a separate Yahoo Finance `historical()` call that overlaps with the backfill call. A future optimization could merge these into a single fetch covering `max(threeMonthsAgo, nextDay)` to `yesterday`, then partition results into "backfill" vs "gap" categories. This is deferred because the current approach is simpler and the extra Yahoo call is cheap for 3-month ranges.

```typescript
/**
 * Detect and fill gaps in stored prices for a commodity over the last N months.
 * Only fills up to yesterday's date (never fetches today's price).
 * @param commodityGuid GUID of the commodity
 * @param symbol Stock symbol for Yahoo Finance lookup
 * @param lookbackMonths Number of months to look back for gaps (default: 3)
 * @returns Number of gap prices stored
 */
export async function detectAndFillGaps(
  commodityGuid: string,
  symbol: string,
  lookbackMonths: number = 3
): Promise<number> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const lookbackStart = new Date(yesterday.getFullYear(), yesterday.getMonth() - lookbackMonths, yesterday.getDate());

  // Fetch all existing price dates in the lookback window for dedup
  const existingDates = await getExistingPriceDates(commodityGuid, lookbackStart, yesterday);

  // Fetch the full historical range up to yesterday and only store missing dates
  const historicalPrices = await fetchHistoricalPrices(symbol, lookbackStart, yesterday);

  let gapsFilled = 0;
  for (const hp of historicalPrices) {
    const dateKey = hp.date.toISOString().split('T')[0];
    if (!existingDates.has(dateKey)) {
      const stored = await storeFetchedPrice(commodityGuid, symbol, hp.close, hp.date);
      if (stored) {
        gapsFilled++;
        existingDates.add(dateKey); // Prevent duplicates within this run
      }
    }
  }

  return gapsFilled;
}
```

**Step 5: Modify `fetchAndStorePrices()` -- historical-only, no real-time quotes** (modify existing function at line 228):

Replace the current flow entirely. Remove all usage of `fetchBatchQuotes`, `hasPriceForToday`, and any real-time quote fetching. The function now ONLY fetches and stores historical closing prices up to yesterday.

**CRITICAL: The `force` flow and the normal flow are mutually exclusive.** When `force=true`, skip normal backfill and gap detection entirely -- just fetch the full 3-month window and insert missing prices. When `force=false`, do normal backfill from `lastDate+1` and then gap detection. This prevents double-counting of `backfilledForSymbol` and avoids redundant Yahoo Finance calls.

```typescript
export interface PriceFetchResult {
  symbol: string;
  pricesStored: number;      // how many daily closing prices stored for this symbol
  dateRange: { from: string; to: string } | null;  // date range fetched, null if nothing fetched
  success: boolean;
  error?: string;
}

export interface FetchAndStoreResult {
  stored: number;        // total historical closing prices stored (backfill + gaps)
  backfilled: number;    // prices from lastDate+1 to yesterday (or full 3-month range on force)
  gapsFilled: number;    // gap prices filled in last 3 months (always 0 when force=true)
  failed: number;        // commodities that failed entirely
  results: PriceFetchResult[];  // per-commodity summary
}

export async function fetchAndStorePrices(
  symbols?: string[],
  force: boolean = false
): Promise<FetchAndStoreResult> {
  const commodities = await getQuotableCommodities();

  let targetCommodities = commodities;
  if (symbols && symbols.length > 0) {
    const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
    targetCommodities = commodities.filter(c => symbolSet.has(c.mnemonic.toUpperCase()));
  }

  if (targetCommodities.length === 0) {
    return { stored: 0, backfilled: 0, gapsFilled: 0, failed: 0, results: [] };
  }

  // Use yesterday as the upper bound -- never fetch today's price
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  let totalBackfilled = 0;
  let totalGapsFilled = 0;
  let totalFailed = 0;
  const results: PriceFetchResult[] = [];

  for (const commodity of targetCommodities) {
    try {
      let backfilledForSymbol = 0;
      let gapsForSymbol = 0;
      let fetchedFrom: string | null = null;
      let fetchedTo: string | null = null;

      const lastDate = await getLastPriceDate(commodity.guid);

      if (force) {
        // ── FORCE MODE ──
        // Fetch full 3-month historical range, skip any dates that already exist.
        // This is the ONLY code path when force=true -- no normal backfill or gap
        // detection runs. This prevents double-counting of stored prices.
        const threeMonthsAgo = new Date(yesterday.getFullYear(), yesterday.getMonth() - 3, yesterday.getDate());
        const existingDates = await getExistingPriceDates(commodity.guid, threeMonthsAgo, yesterday);
        const historical = await fetchHistoricalPrices(commodity.mnemonic, threeMonthsAgo, yesterday);

        for (const hp of historical) {
          const dateKey = hp.date.toISOString().split('T')[0];
          if (!existingDates.has(dateKey)) {
            const stored = await storeFetchedPrice(commodity.guid, commodity.mnemonic, hp.close, hp.date);
            if (stored) {
              backfilledForSymbol++;
              existingDates.add(dateKey); // Prevent duplicates within this run
            }
          }
        }
        if (historical.length > 0) {
          fetchedFrom = threeMonthsAgo.toISOString().split('T')[0];
          fetchedTo = yesterday.toISOString().split('T')[0];
        }
      } else if (!lastDate) {
        // ── FIRST-TIME BACKFILL (no stored prices at all) ──
        // Fetch last 3 months of history up to yesterday.
        // Dedup check: even though there are "no stored prices," a concurrent request
        // could have inserted some between getLastPriceDate and here. Use existingDates
        // for safety.
        const threeMonthsAgo = new Date(yesterday.getFullYear(), yesterday.getMonth() - 3, yesterday.getDate());
        const existingDates = await getExistingPriceDates(commodity.guid, threeMonthsAgo, yesterday);
        const historical = await fetchHistoricalPrices(commodity.mnemonic, threeMonthsAgo, yesterday);

        for (const hp of historical) {
          const dateKey = hp.date.toISOString().split('T')[0];
          if (!existingDates.has(dateKey)) {
            const stored = await storeFetchedPrice(commodity.guid, commodity.mnemonic, hp.close, hp.date);
            if (stored) {
              backfilledForSymbol++;
              existingDates.add(dateKey);
            }
          }
        }
        if (historical.length > 0) {
          fetchedFrom = threeMonthsAgo.toISOString().split('T')[0];
          fetchedTo = yesterday.toISOString().split('T')[0];
        }
      } else {
        // ── NORMAL MODE (has stored prices, not force) ──
        // Backfill from lastDate+1 to yesterday, then detect/fill gaps in last 3 months.
        const nextDay = new Date(lastDate);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);

        if (nextDay <= yesterday) {
          // Backfill range starts AFTER lastDate, so no existing prices in this range
          // (by definition). But check anyway for safety against concurrent writes.
          const existingDates = await getExistingPriceDates(commodity.guid, nextDay, yesterday);
          const historical = await fetchHistoricalPrices(commodity.mnemonic, nextDay, yesterday);

          for (const hp of historical) {
            const dateKey = hp.date.toISOString().split('T')[0];
            if (!existingDates.has(dateKey)) {
              const stored = await storeFetchedPrice(commodity.guid, commodity.mnemonic, hp.close, hp.date);
              if (stored) backfilledForSymbol++;
            }
          }
          if (historical.length > 0) {
            fetchedFrom = nextDay.toISOString().split('T')[0];
            fetchedTo = yesterday.toISOString().split('T')[0];
          }
        }

        // Also run gap detection for the last 3 months (uses yesterday as upper bound
        // internally and has its own existingDates check via getExistingPriceDates)
        const gapsFilled = await detectAndFillGaps(commodity.guid, commodity.mnemonic, 3);
        gapsForSymbol = gapsFilled;
      }

      totalBackfilled += backfilledForSymbol;
      totalGapsFilled += gapsForSymbol;

      results.push({
        symbol: commodity.mnemonic,
        pricesStored: backfilledForSymbol + gapsForSymbol,
        dateRange: fetchedFrom && fetchedTo ? { from: fetchedFrom, to: fetchedTo } : null,
        success: true,
      });
    } catch (error) {
      totalFailed++;
      results.push({
        symbol: commodity.mnemonic,
        pricesStored: 0,
        dateRange: null,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return {
    stored: totalBackfilled + totalGapsFilled,
    backfilled: totalBackfilled,
    gapsFilled: totalGapsFilled,
    failed: totalFailed,
    results,
  };
}
```

**Step 6: Update `price-service.ts` facade** to re-export new functions and update the type exports block (keep `fetchBatchQuotes` for potential standalone use, but it is no longer called by `fetchAndStorePrices`):
```typescript
export {
  fetchBatchQuotes,
  fetchAndStorePrices,
  fetchHistoricalPrices,
  getQuotableCommodities,
  getLastPriceDate,
  detectAndFillGaps,
  storeFetchedPrice,
} from './yahoo-price-service';

export type {
  PriceFetchResult,
  QuotableCommodity,
  FetchAndStoreResult,
} from './yahoo-price-service';
```

**Note**: The `PriceFetchResult` and `FetchAndStoreResult` types have changed shape (new fields: `pricesStored`, `dateRange`; removed fields: `price`, `previousClose`, `change`, `changePercent`, `timestamp`, `fetched`, `skipped`). The `export type {}` block must be kept in sync. Since the types are re-exported from `yahoo-price-service.ts`, the facade just needs to export them -- the shape change is handled at the source.

**Note on `fetchBatchQuotes`**: This function is no longer called by `fetchAndStorePrices`. Check if it is used elsewhere in the codebase. If it is only used in the removed real-time quote logic, it can remain exported as a utility but is effectively unused. Do NOT delete it -- it may be useful for other features in the future.

**Step 7: Update API route JSDoc and response** (`src/app/api/prices/fetch/route.ts`):

Update the JSDoc comment block to reflect the new historical-only behavior and response shape:
```typescript
/**
 * POST /api/prices/fetch
 *
 * Trigger historical price backfill from Yahoo Finance.
 * Fetches daily closing prices from the last stored date to yesterday.
 * Never fetches current/real-time quotes.
 *
 * Request body (optional):
 * {
 *   symbols?: string[]  // Specific symbols to fetch (default: all quotable commodities)
 *   force?: boolean     // Re-fetch full 3-month window, inserting only missing dates (default: false)
 * }
 *
 * Response:
 * {
 *   stored: number,      // Total historical closing prices stored
 *   backfilled: number,  // Prices backfilled from lastDate+1 to yesterday
 *   gapsFilled: number,  // Gap prices filled in last 3 months
 *   failed: number,      // Number of commodities that failed
 *   results: [{          // Per-commodity detail
 *     symbol: string,
 *     pricesStored: number,
 *     dateRange: { from: string, to: string } | null,
 *     success: boolean,
 *     error?: string
 *   }]
 * }
 */
```

Replace the response shape at line 56 to match the new historical-only result:
```typescript
return NextResponse.json({
  stored: result.stored,
  backfilled: result.backfilled,
  gapsFilled: result.gapsFilled,
  failed: result.failed,
  results: result.results.map(r => ({
    symbol: r.symbol,
    pricesStored: r.pricesStored,
    dateRange: r.dateRange,
    success: r.success,
    error: r.error,
  })),
});
```

**Step 8: Update investments page response handling** (`src/app/(main)/investments/page.tsx` lines 106-114):
```typescript
if (data.stored > 0) {
  const parts: string[] = [];
  if (data.backfilled > 0) parts.push(`${data.backfilled} historical prices backfilled`);
  if (data.gapsFilled > 0) parts.push(`${data.gapsFilled} gap prices filled`);
  success(`Updated: ${parts.join(', ')} (${data.stored} total)`);
  fetchPortfolio();
  fetchHistory();
} else if (data.failed > 0) {
  warning(`Failed to fetch prices for ${data.failed} commodities`);
} else {
  warning('All historical prices are up to date');
}
```

**Performance Consideration**: The historical backfill makes sequential API calls to Yahoo Finance per commodity. For N commodities with gaps, this results in N `historical()` calls plus potentially N more for gap detection (in normal mode). To mitigate:
- The `getExistingPriceDates` query is cheap (single indexed query per commodity, returning only date columns)
- `storeFetchedPrice` is called per-day per-commodity, which is acceptable for typical portfolios (5-20 commodities)
- In force mode, only ONE Yahoo call per commodity (no separate gap detection)
- For very large portfolios, consider batching the `storeFetchedPrice` calls into bulk inserts in a future optimization
- **Future optimization**: In normal mode, `detectAndFillGaps` makes a separate Yahoo `historical()` call that may overlap with the backfill range. These could be merged into a single fetch covering `max(threeMonthsAgo, nextDay)` to `yesterday`, then partitioning results into "backfill" vs "gap" categories. Deferred for simplicity.

**Acceptance Criteria:**
- Clicking "Refresh All Prices" fetches daily closing prices from the last stored price date to yesterday for each commodity
- Only historical closing prices are stored; the most recent price is always yesterday's close (never today's intraday price)
- No real-time or current market quotes are fetched by this button
- If no stored prices exist for a commodity, the last 3 months of daily closing history are fetched (up to yesterday)
- Gaps in the last 3 months are detected and filled (skipping weekends/market holidays since Yahoo only returns trading days)
- Duplicate prices are never created: ALL code paths (first-time backfill, normal backfill, force, gap detection) check `existingDates` set before inserting
- Toast notification shows count of historical prices stored and gaps filled
- API response includes `stored`, `backfilled`, `gapsFilled`, and per-commodity `results`
- `force` parameter re-fetches the full 3-month historical window and inserts only missing prices (does NOT overwrite existing); normal backfill and gap detection are skipped when `force=true`
- `storeFetchedPrice()` correctly uses USD as currency_guid (consistent with Yahoo Finance USD-denominated prices and GnuCash desktop Finance::Quote behavior)

---

### Task 1.5: Book Name and Description Fields + Editor Modal (Issue 13)

**Files to modify:**
- `prisma/schema.prisma` (lines 161-165: books model)
- `src/app/api/books/route.ts` (GET and POST handlers)
- `src/app/api/books/[guid]/route.ts` (GET and PUT handlers)
- `src/app/api/books/default/route.ts` (POST handler)
- `src/contexts/BookContext.tsx` (Book interface and fetch logic)
- `src/components/BookSwitcher.tsx` (add edit button, show description)
- New: `src/components/BookEditorModal.tsx` (book editor modal)

**Problem**: The `books` table in Prisma only has 3 fields (`guid`, `root_account_guid`, `root_template_guid`). There is no `name` or `description` column. The book "name" is currently derived from the root account's name via a JOIN in the API. Users cannot set a custom book name or add a description. The `PUT /api/books/[guid]` endpoint exists but only renames the root account -- there is no UI connected to it.

**Schema Change Justification**: This is the only schema change in the entire plan. Both fields are nullable so existing books without these fields continue to work. The name display uses a fallback: `books.name ?? rootAccount.name`.

**Implementation:**

**Step 1: Update Prisma schema** (`prisma/schema.prisma`):
```prisma
model books {
  guid               String  @id @db.VarChar(32)
  root_account_guid  String  @db.VarChar(32)
  root_template_guid String  @db.VarChar(32)
  name               String? @db.VarChar(255)
  description        String? @db.Text
}
```

**Step 2: Run schema migration:**
Since this project uses an external GnuCash PostgreSQL database, use `npx prisma db push` to sync the schema without creating a migration file. Alternatively, if the project uses Prisma migrations, run `npx prisma migrate dev --name add-book-name-description`. The executor should check for the presence of a `prisma/migrations` directory to decide.

If neither approach is suitable (e.g., database is managed externally), the raw SQL is:
```sql
ALTER TABLE books ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE books ADD COLUMN IF NOT EXISTS description TEXT;
```

**Step 3: Update `GET /api/books` route** (`src/app/api/books/route.ts`):
Currently the GET handler derives book name from the root account. Update to return `books.name` if set, falling back to root account name:
```typescript
// In the books query, include the new fields
const books = await prisma.books.findMany({
  select: {
    guid: true,
    root_account_guid: true,
    root_template_guid: true,
    name: true,
    description: true,
  },
});

// When building response, use book.name ?? rootAccount.name
for (const book of books) {
  const rootAccount = await prisma.accounts.findUnique({
    where: { guid: book.root_account_guid },
    select: { name: true },
  });

  result.push({
    guid: book.guid,
    name: book.name ?? rootAccount?.name ?? 'Unnamed Book',
    description: book.description ?? null,
    accountCount: /* existing count logic */,
  });
}
```

**Step 4: Update `POST /api/books` route** (`src/app/api/books/route.ts`):
Accept optional `name` and `description` in the request body. When creating the book, store these fields:
```typescript
const { name, description } = await request.json();
// ... existing book creation logic ...
await prisma.books.create({
  data: {
    guid: newGuid,
    root_account_guid: rootAccountGuid,
    root_template_guid: rootTemplateGuid,
    name: name || null,
    description: description || null,
  },
});
```

**Step 5: Update `GET /api/books/[guid]` route** (`src/app/api/books/[guid]/route.ts`):
Include `name` and `description` in the response, with fallback for name:
```typescript
const book = await prisma.books.findUnique({
  where: { guid: params.guid },
  select: {
    guid: true,
    root_account_guid: true,
    root_template_guid: true,
    name: true,
    description: true,
  },
});
// Return book.name ?? rootAccount.name for display name
```

**Step 6: Update `PUT /api/books/[guid]` route** (`src/app/api/books/[guid]/route.ts`):
Currently only renames the root account. Update to also save `name` and `description` on the books record itself:
```typescript
const { name, description } = await request.json();

// Update the books table name and description
await prisma.books.update({
  where: { guid: params.guid },
  data: {
    name: name !== undefined ? name : undefined,
    description: description !== undefined ? description : undefined,
  },
});

// ALSO update root account name if name is provided (maintain backward compat)
if (name) {
  await prisma.accounts.update({
    where: { guid: book.root_account_guid },
    data: { name },
  });
}
```

**Step 7: Update `POST /api/books/default` route** (`src/app/api/books/default/route.ts`):
Accept optional `name` and `description`. Pass `name` to `createDefaultBook()` (existing behavior). Also store `description` on the books record after creation.

**Step 8: Update BookContext** (`src/contexts/BookContext.tsx`):
Add `description` to the `Book` interface:
```typescript
interface Book {
  guid: string;
  name: string;
  description?: string | null;
  accountCount?: number;
}
```
Update the fetch response parsing to include `description`.

**Step 9: Create BookEditorModal** (`src/components/BookEditorModal.tsx`):
```tsx
interface BookEditorModalProps {
  book: Book;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;  // callback to refresh book list
}

export function BookEditorModal({ book, isOpen, onClose, onSaved }: BookEditorModalProps) {
  const [name, setName] = useState(book.name);
  const [description, setDescription] = useState(book.description ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/books/${book.guid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      });
      onSaved();
      onClose();
    } catch (error) {
      console.error('Failed to save book:', error);
    } finally {
      setSaving(false);
    }
  };

  // Render:
  // - Use existing Modal component from the codebase
  // - Name field: text input, required
  // - Description field: textarea, optional
  // - Save and Cancel buttons
  // - Loading state while saving
}
```

**Step 10: Update BookSwitcher** (`src/components/BookSwitcher.tsx`):
1. Add a pencil/edit icon button next to each book in the dropdown list
2. Clicking the edit icon opens `BookEditorModal` for that book
3. Show `book.description` as a subtitle line under the book name in the dropdown (truncated to ~50 chars)
4. Import and render `BookEditorModal` with state management:
   ```tsx
   const [editingBook, setEditingBook] = useState<Book | null>(null);

   // In the book list item:
   <button onClick={() => setEditingBook(book)} className="...">
     <PencilIcon className="w-3.5 h-3.5" />
   </button>

   // At bottom of component:
   {editingBook && (
     <BookEditorModal
       book={editingBook}
       isOpen={!!editingBook}
       onClose={() => setEditingBook(null)}
       onSaved={() => { fetchBooks(); setEditingBook(null); }}
     />
   )}
   ```
5. Optionally add a "Manage Books" link at the bottom of the dropdown that opens the editor for the active book

**Acceptance Criteria:**
- `books` table has nullable `name` and `description` columns
- Existing books without name/description continue to work (fallback to root account name)
- `GET /api/books` returns `name` (with fallback) and `description` for each book
- `PUT /api/books/[guid]` saves `name` and `description` to the books table
- `POST /api/books` and `POST /api/books/default` accept optional `name` and `description`
- BookContext `Book` interface includes `description` field
- BookSwitcher shows an edit icon per book and displays description subtitle
- BookEditorModal opens with current book name/description, allows editing, and saves via PUT
- After saving in the modal, the BookSwitcher refreshes to show updated values
- Build passes with zero TypeScript errors

---

## Phase 2: Currency Conversion (Sequential dependency)

### Task 2.1: Net Worth Currency Conversion (Issue 1)

**Files to modify:**
- `src/app/api/dashboard/kpis/route.ts` (lines 6-8: type arrays; lines 155-189: `computeNetWorthAtDate`)
- `src/app/api/dashboard/net-worth/route.ts` (lines 6-8: type arrays; lines 182-233: time series computation)

**Implementation:**

**Step 1: Fix Account Type Arrays (both files):**
```typescript
const ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'RECEIVABLE'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];
```

**Step 2: Bulk-fetch currency price records for cash accounts:**

For `kpis/route.ts` (single-point computation at startDate and endDate):
```typescript
import { getBaseCurrency, findExchangeRate } from '@/lib/currency';

// After fetching accounts, build account-to-currency map
const accountCurrencyMap = new Map<string, string>();
for (const a of accounts) {
  if (a.commodity_guid) accountCurrencyMap.set(a.guid, a.commodity_guid);
}

const baseCurrency = await getBaseCurrency();

// Get unique non-base currency GUIDs from cash/liability accounts
const nonBaseCurrencyGuids = new Set(
  accounts
    .filter(a => [...ASSET_TYPES, ...LIABILITY_TYPES].includes(a.account_type))
    .filter(a => a.commodity_guid && a.commodity_guid !== baseCurrency?.guid)
    .map(a => a.commodity_guid!)
);

// For KPIs, we need rates at endDate (current NW) and startDate (comparison NW)
const endDateRates = new Map<string, number>();
const startDateRates = new Map<string, number>();
for (const currGuid of nonBaseCurrencyGuids) {
  const endRate = await findExchangeRate(currGuid, baseCurrency!.guid, endDate);
  if (endRate) endDateRates.set(currGuid, endRate.rate);
  const startRate = await findExchangeRate(currGuid, baseCurrency!.guid, startDate);
  if (startRate) startDateRates.set(currGuid, startRate.rate);
}
```

Then in `computeNetWorthAtDate()` (lines 155-189), accept a rates map parameter:
```typescript
function computeNetWorthAtDate(
  asOf: Date,
  ratesForDate: Map<string, number>
): { assets: number; liabilities: number; investmentValue: number } {
  // ... existing split iteration ...
  for (const split of cashSplits) {
    const postDate = split.transaction.post_date;
    if (!postDate || postDate > asOf) continue;
    const rawValue = parseFloat(toDecimal(split.value_num, split.value_denom));
    const accountCurrGuid = accountCurrencyMap.get(split.account_guid);
    const rate = (accountCurrGuid && accountCurrGuid !== baseCurrency?.guid)
      ? (ratesForDate.get(accountCurrGuid) || 1)
      : 1;
    const value = rawValue * rate;
    // ... rest of accumulation
  }
  // ... investment calculation unchanged (already uses price from priceMap)
}

const endNW = computeNetWorthAtDate(endDate, endDateRates);
const startNW = computeNetWorthAtDate(startDate, startDateRates);
```

**Step 3: For `net-worth/route.ts` time series -- bulk-fetch ALL currency price records:**

Use the same pattern as investment prices (lines 128-143). Fetch all price records for non-base currencies and build an in-memory sorted map:

```typescript
import { getBaseCurrency } from '@/lib/currency';

const baseCurrency = await getBaseCurrency();

// Build account-to-currency map for cash/liability accounts
const accountCurrencyMap = new Map<string, string>();
for (const a of accounts) {
  if (a.commodity_guid) accountCurrencyMap.set(a.guid, a.commodity_guid);
}

const nonBaseCurrencyGuids = [
  ...new Set(
    accounts
      .filter(a => [...ASSET_TYPES, ...LIABILITY_TYPES].includes(a.account_type))
      .filter(a => a.commodity_guid && a.commodity_guid !== baseCurrency?.guid)
      .map(a => a.commodity_guid!)
  ),
];

// Bulk-fetch ALL price records for non-base currencies (same pattern as investment prices)
const currencyPrices = await prisma.prices.findMany({
  where: {
    commodity_guid: { in: nonBaseCurrencyGuids },
    currency_guid: baseCurrency!.guid,
  },
  select: {
    commodity_guid: true,
    date: true,
    value_num: true,
    value_denom: true,
  },
  orderBy: { date: 'desc' },
});

// Build sorted map: currency_guid -> [{date, rate}] sorted desc
const currencyRateMap = new Map<string, Array<{ date: Date; rate: number }>>();
for (const p of currencyPrices) {
  const arr = currencyRateMap.get(p.commodity_guid) || [];
  arr.push({
    date: p.date,
    rate: parseFloat(toDecimal(p.value_num, p.value_denom)),
  });
  currencyRateMap.set(p.commodity_guid, arr);
}

// Helper: find latest currency rate on or before a date
function getCurrencyRateAsOf(currencyGuid: string, asOf: Date): number {
  const rates = currencyRateMap.get(currencyGuid);
  if (!rates || rates.length === 0) return 1; // fallback to 1:1
  for (const r of rates) {
    if (r.date <= asOf) return r.rate;
  }
  return rates[rates.length - 1].rate; // use oldest if no rate before date
}
```

Then in the `datePoints.map()` at line 182, apply conversion:
```typescript
const timeSeries = datePoints.map(datePoint => {
  let assetTotal = 0;
  let liabilityTotal = 0;

  for (const split of cashSplits) {
    const postDate = split.transaction.post_date;
    if (!postDate || postDate > datePoint) continue;

    const rawValue = parseFloat(toDecimal(split.value_num, split.value_denom));
    const accountCurrGuid = accountCurrencyMap.get(split.account_guid);
    const rate = (accountCurrGuid && accountCurrGuid !== baseCurrency?.guid)
      ? getCurrencyRateAsOf(accountCurrGuid, datePoint)
      : 1;
    const value = rawValue * rate;

    if (assetSet.has(split.account_guid)) {
      assetTotal += value;
    } else if (liabilitySet.has(split.account_guid)) {
      liabilityTotal += value;
    }
  }

  // ... investment calculation unchanged ...
});
```

**Note on `findExchangeRate` triangulation**: The bulk-fetch above only queries direct `commodity_guid -> baseCurrency.guid` prices. If a currency pair requires triangulation (e.g., CRC->EUR->USD), the bulk approach will miss it. Handle this by: after building `currencyRateMap`, check which `nonBaseCurrencyGuids` have empty or no entries. For those, fall back to `findExchangeRate()` at the per-datePoint level (these should be rare).

**Acceptance Criteria:**
- Net worth KPI shows ~$1.4MM instead of ~$1.1MM
- Net worth chart reflects converted values at each month using the exchange rate closest to that month
- RECEIVABLE accounts included in assets, PAYABLE in liabilities
- Accounts in CRC are converted to USD using date-specific exchange rates from GnuCash price database
- No change for single-currency users

---

### Task 2.2: Income/Expense Currency Conversion (Issue 3)

**Files to modify:**
- `src/app/api/dashboard/kpis/route.ts` (lines 232-268: income/expense splits)
- `src/app/api/dashboard/income-expense/route.ts` (lines 90-143: monthly grouping)
- `src/app/api/dashboard/sankey/route.ts` (lines 131-158: split totals)

**Implementation:**

All three routes follow the same pattern:

1. Fetch accounts with `commodity_guid` included in the select
2. Build `accountCurrencyMap: Map<string, string>` (account_guid -> commodity_guid)
3. Get base currency via `getBaseCurrency()`
4. For income/expense splits within a date range, a single exchange rate per currency is acceptable (use the latest rate up to `endDate`) since these are flow values not point-in-time balances
5. Pre-fetch rates for non-base currencies:
   ```typescript
   const nonBaseCurrencyGuids = new Set(
     relevantAccounts
       .filter(a => a.commodity_guid && a.commodity_guid !== baseCurrency?.guid)
       .map(a => a.commodity_guid!)
   );
   const exchangeRates = new Map<string, number>();
   for (const currGuid of nonBaseCurrencyGuids) {
     const rate = await findExchangeRate(currGuid, baseCurrency!.guid, endDate);
     if (rate) exchangeRates.set(currGuid, rate.rate);
   }
   ```
6. In each split processing loop, multiply value by rate:
   ```typescript
   const rawValue = parseFloat(toDecimal(split.value_num, split.value_denom));
   const accountCurrGuid = accountCurrencyMap.get(split.account_guid);
   const rate = (accountCurrGuid && accountCurrGuid !== baseCurrency?.guid)
     ? (exchangeRates.get(accountCurrGuid) || 1) : 1;
   const value = rawValue * rate;
   ```

**For kpis/route.ts** (line 257): Apply rate in the `for (const split of iesplits)` loop.

**For income-expense/route.ts** (line 128): Apply rate before accumulating into monthly totals. Note: This route also needs `commodity_guid` added to the account select query and the account map.

**For sankey/route.ts** (line 153): Apply rate before accumulating into `splitTotalsByAccount`. Note: The sankey route fetches accounts differently (via `getActiveBookRootGuid`), so the account query must be updated to include `commodity_guid`.

**Acceptance Criteria:**
- Income - Expenses for 2025 shows ~$0 (CRC expenses converted to USD)
- Monthly income/expense bars reflect converted values
- Sankey diagram reflects converted values
- Savings rate calculation correct

---

## Phase 3: Dashboard UI (Parallelizable within phase)

### Task 3.1: Wrap Dashboard Charts with ExpandableChart (Issue 4)

**Files to modify:**
- `src/app/(main)/dashboard/page.tsx` (lines 399-421: chart rendering)
- Each chart component (to handle card-within-card nesting)

**Card-Within-Card Problem**: Each dashboard chart component renders its own card wrapper (e.g., SankeyDiagram line 47: `<div className="bg-surface border border-border rounded-xl p-6">`). Wrapping with `ExpandableChart` creates `ExpandableChart > div.relative.group > ChartComponent > div.bg-surface.border...` -- a card inside a positioned wrapper. This is acceptable because `ExpandableChart` does NOT render its own card; it only adds a `relative group` wrapper and an absolutely-positioned expand button. The visual result is the chart card with an expand button overlaid on hover.

**Implementation:**
1. Import `ExpandableChart` from `@/components/charts/ExpandableChart`
2. Wrap each chart component in the dashboard page:
   ```tsx
   <ExpandableChart title="Net Worth Over Time">
     <NetWorthChart data={netWorthData} loading={netWorthLoading} />
   </ExpandableChart>
   ```
3. Wrap all 7 chart components:
   - `NetWorthChart` (line 399)
   - `SankeyDiagram` (line 403)
   - `ExpensePieChart` (line 408)
   - `IncomePieChart` (line 409)
   - `IncomeExpenseBarChart` (line 413)
   - `NetProfitChart` (line 416)
   - `TaxPieChart` (line 420)

**Acceptance Criteria:**
- Hover on any chart card shows expand button
- Clicking expand opens fullscreen modal with chart
- All 7 dashboard charts have expand capability
- KPIGrid does NOT get expand (it's not a chart)
- No visual double-card nesting issue

---

### Task 3.2: Charts Fill Expanded Card (Issue 6)

**Files to modify:**
- `src/components/charts/ExpandableChart.tsx` (lines 14-41)
- `src/components/dashboard/NetWorthChart.tsx`
- `src/components/dashboard/SankeyDiagram.tsx`
- `src/components/dashboard/ExpensePieChart.tsx`
- `src/components/dashboard/IncomePieChart.tsx`
- `src/components/dashboard/TaxPieChart.tsx`
- `src/components/dashboard/IncomeExpenseBarChart.tsx`
- `src/components/dashboard/NetProfitChart.tsx`
- `src/components/charts/SankeyChart.tsx`
- `src/components/investments/PerformanceChart.tsx`
- `src/components/investments/AllocationChart.tsx`

**Implementation: Context-based approach**

1. Create `ExpandedContext` in `ExpandableChart.tsx`:
   ```tsx
   import { createContext } from 'react';
   export const ExpandedContext = createContext(false);
   ```

2. Modify `ExpandableChart` to wrap children with context:
   ```tsx
   {/* Normal view */}
   <ExpandedContext.Provider value={false}>
     {children}
   </ExpandedContext.Provider>

   {/* Expanded modal */}
   <Modal ...>
     <div className="w-full h-full min-h-[70vh] p-4">
       <ExpandedContext.Provider value={true}>
         {children}
       </ExpandedContext.Provider>
     </div>
   </Modal>
   ```

3. **Why dual rendering is acceptable**: `ExpandableChart` renders `children` in both the normal view and the modal simultaneously when expanded. This is acceptable for Recharts components because they are stateless renderers -- each instance independently renders from its data props without shared mutable state. The normal view remains visible behind the modal's backdrop overlay, which is standard modal UX. The D3-based SankeyChart is also safe because it computes its layout in a `useMemo` from props.

4. Each chart component uses `useContext(ExpandedContext)` to set height:
   ```tsx
   import { useContext } from 'react';
   import { ExpandedContext } from '@/components/charts/ExpandableChart';

   const expanded = useContext(ExpandedContext);
   // For Recharts:
   <ResponsiveContainer width="100%" height={expanded ? "100%" : 350}>
   ```

5. For SankeyDiagram/SankeyChart:
   - `SankeyDiagram` passes `height={expanded ? undefined : 500}` to `SankeyChart`
   - When `height` is undefined, `SankeyChart` uses its container height via `ResizeObserver` (which it already does for width). Modify `SankeyChart` to also observe height when `propHeight` is undefined:
     ```typescript
     const [dimensions, setDimensions] = useState({
       width: propWidth || 800,
       height: propHeight || 600,
     });
     // In ResizeObserver callback:
     setDimensions({
       width,
       height: propHeight || entry.contentRect.height || 600,
     });
     ```

6. For chart components that render their own card wrapper: when `expanded` is true, the card wrapper's fixed height should be overridden. Add to each chart's card div:
   ```tsx
   <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
   ```

**Acceptance Criteria:**
- Expanded charts fill the modal viewport (not stuck at 300/350/500px)
- Normal view charts maintain their current fixed sizes
- Works for both Recharts components and custom SankeyChart
- Investment page charts also benefit (PerformanceChart, AllocationChart)

---

## Phase 4: Medium Complexity

### Task 4.1: Fix Print and CSV Export (Issue 11)

**Files to modify:**
- `src/components/reports/ReportViewer.tsx` (lines 28-35: handlePrint/handleExport, lines 95-111: print styles)
- New file: `src/lib/reports/csv-export.ts` (CSV generation utility)

**Root Cause of Print Failure**: The current CSS at lines 97-110 uses `body * { visibility: hidden }` and then `visibility: visible` on `.print\:bg-white` descendants. Per CSS specification, `visibility: hidden` on a parent does allow children to be `visibility: visible`. However, the issue is that `body *` matches ALL descendant elements individually (not just body's direct children), so every nested element gets `visibility: hidden` applied directly. The `.print\:bg-white` selector only matches the container div at line 89, and while it sets `visibility: visible`, the `body *` rule ALSO directly targets its child elements, overriding inheritance. Combined with `position: absolute`, this creates a broken layout.

**Print Fix -- window.open() approach (Architect Decision B):**

1. Replace `handlePrint` in `ReportViewer.tsx`:
   ```typescript
   const reportContentRef = useRef<HTMLDivElement>(null);

   const handlePrint = () => {
     if (!reportContentRef.current) return;

     const printWindow = window.open('', '_blank', 'width=800,height=600');
     if (!printWindow) return;

     const content = reportContentRef.current.innerHTML;

     printWindow.document.write(`
       <!DOCTYPE html>
       <html>
       <head>
         <title>${title}</title>
         <style>
           /* Print-specific CSS (~80 lines) */
           body {
             font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             color: #000;
             background: #fff;
             margin: 20px;
             line-height: 1.5;
           }
           h1, h2, h3 { margin: 0.5em 0; }
           h1 { font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 8px; }
           h2 { font-size: 18px; color: #444; }
           h3 { font-size: 14px; color: #666; }
           table {
             width: 100%;
             border-collapse: collapse;
             margin: 12px 0;
             font-size: 12px;
           }
           th, td {
             border: 1px solid #ddd;
             padding: 6px 10px;
             text-align: left;
           }
           th {
             background: #f5f5f5;
             font-weight: 600;
           }
           tr:nth-child(even) { background: #fafafa; }
           .text-right, [class*="text-right"] { text-align: right; }
           .font-bold, [class*="font-bold"] { font-weight: 700; }
           .font-semibold, [class*="font-semibold"] { font-weight: 600; }
           /* Hide interactive elements */
           button, [role="button"], .no-print { display: none !important; }
           /* Remove dark theme colors */
           * {
             color: #000 !important;
             background-color: transparent !important;
             border-color: #ddd !important;
           }
           @media print {
             body { margin: 0; }
             @page { margin: 1.5cm; }
           }
         </style>
       </head>
       <body>
         <h1>${title}</h1>
         ${content}
       </body>
       </html>
     `);

     printWindow.document.close();
     printWindow.focus();
     printWindow.print();
     printWindow.close();
   };
   ```

2. Add `ref={reportContentRef}` to the content wrapper div at line 89:
   ```tsx
   <div ref={reportContentRef} className="bg-background-secondary/30 ...">
     {children}
   </div>
   ```

3. Remove the old `<style jsx global>` block at lines 95-111 entirely.

**CSV Export:**
1. Create `src/lib/reports/csv-export.ts`:
   ```typescript
   import { ReportSection, ReportData } from './types';

   export function generateCSV(data: ReportData): string {
     const rows: string[] = [];
     const hasCompare = data.sections.some(s => s.previousTotal !== undefined);

     // Header
     rows.push(hasCompare ? 'Section,Item,Current Amount,Previous Amount' : 'Section,Item,Amount');

     for (const section of data.sections) {
       // Section header
       rows.push(`"${section.title}",,`);

       for (const item of section.items) {
         const name = item.depth ? '  '.repeat(item.depth) + item.name : item.name;
         if (hasCompare) {
           rows.push(`,"${name}",${item.amount},${item.previousAmount ?? ''}`);
         } else {
           rows.push(`,"${name}",${item.amount}`);
         }
       }

       // Section total
       if (hasCompare) {
         rows.push(`,"TOTAL: ${section.title}",${section.total},${section.previousTotal ?? ''}`);
       } else {
         rows.push(`,"TOTAL: ${section.title}",${section.total}`);
       }
       rows.push(''); // blank line between sections
     }

     // Grand total
     if (data.grandTotal !== undefined) {
       if (hasCompare) {
         rows.push(`,"GRAND TOTAL",${data.grandTotal},${data.previousGrandTotal ?? ''}`);
       } else {
         rows.push(`,"GRAND TOTAL",${data.grandTotal}`);
       }
     }

     return rows.join('\n');
   }

   export function downloadCSV(content: string, filename: string): void {
     const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
     const link = document.createElement('a');
     link.href = URL.createObjectURL(blob);
     link.download = filename;
     link.click();
     URL.revokeObjectURL(link.href);
   }
   ```

2. Add `reportData?: ReportData` prop to `ReportViewerProps` and wire `handleExport`:
   ```typescript
   const handleExport = (format: 'csv' | 'excel') => {
     if (format === 'csv' && reportData) {
       const csv = generateCSV(reportData);
       downloadCSV(csv, `${title.replace(/\s+/g, '_')}_report.csv`);
     }
   };
   ```

3. Each report page that uses `ReportViewer` passes its `reportData` prop.

**Acceptance Criteria:**
- Print opens new window with clean document, renders correctly in black on white
- Print output is readable with proper table formatting
- CSV download produces valid CSV file with all sections and totals
- CSV contains proper headers and is importable into Excel/Sheets
- Interactive elements (buttons, filters) hidden in print output

---

### Task 4.2: Budget View Improvements (Issue 9)

**Files to modify:**
- `src/app/(main)/budgets/[guid]/page.tsx` (extensive changes)
- `src/components/budget/InlineAmountEditor.tsx` (sign display changes)

**Implementation:**

**a) Level Selector:**
1. Add level selector dropdown next to the existing Expand All/Collapse All buttons (after line 585):
   ```tsx
   <select
     value={expandLevel}
     onChange={(e) => handleLevelChange(parseInt(e.target.value))}
     className="text-xs bg-surface text-foreground-secondary border border-border rounded px-2 py-1"
   >
     <option value="0">Collapse All</option>
     <option value="1">Level 1</option>
     <option value="2">Level 2</option>
     <option value="3">Level 3</option>
     <option value="99">Expand All</option>
   </select>
   ```
2. `handleLevelChange(level)`: Traverse the tree, expand nodes up to the selected depth:
   ```typescript
   const handleLevelChange = (level: number) => {
     setExpandLevel(level);
     const toExpand = new Set<string>();
     const traverse = (nodes: AccountNode[], depth: number) => {
       for (const node of nodes) {
         if (depth < level && node.children.length > 0) {
           toExpand.add(node.guid);
           traverse(node.children, depth + 1);
         }
       }
     };
     traverse(treeData, 0);
     setExpandedNodes(toExpand);
   };
   ```

**b) Auto-expand to budgeted accounts:**
1. Add "Auto-expand" button next to "Expand All" / "Collapse All":
   ```tsx
   <button onClick={autoExpandBudgeted} className="text-xs ...">
     Auto-expand
   </button>
   ```
2. Logic: traverse tree, find all nodes with `hasOwnBudget === true`, expand all their ancestors:
   ```typescript
   const autoExpandBudgeted = useCallback(() => {
     const toExpand = new Set<string>();
     const findBudgeted = (nodes: AccountNode[], ancestors: string[]) => {
       for (const node of nodes) {
         if (node.hasOwnBudget) {
           ancestors.forEach(a => toExpand.add(a));
         }
         if (node.children.length > 0) {
           findBudgeted(node.children, [...ancestors, node.guid]);
         }
       }
     };
     findBudgeted(treeData, []);
     setExpandedNodes(toExpand);
   }, [treeData]);
   ```

**c) Total footer with 4 rows:**
Replace the single total row (lines 747-759) with 4 rows:
- **Income**: Sum of all root-level INCOME accounts' `rolledUpPeriods`
- **Expense**: Sum of all root-level EXPENSE accounts' `rolledUpPeriods`
- **Transfers**: Sum of ASSET + LIABILITY root accounts' `rolledUpPeriods`
- **Remaining to Budget**: Income - Expense - Transfers

Compute from `treeData` roots by filtering on `type`:
```typescript
const incomeRoots = treeData.filter(n => n.type === 'INCOME');
const expenseRoots = treeData.filter(n => n.type === 'EXPENSE');
const transferRoots = treeData.filter(n => ['ASSET', 'LIABILITY', 'BANK', 'CASH'].includes(n.type));

const sumPeriods = (nodes: AccountNode[]) => {
  const sums = new Array(budget.num_periods).fill(0);
  for (const node of nodes) {
    for (let i = 0; i < budget.num_periods; i++) {
      sums[i] += node.rolledUpPeriods?.[i] || 0;
    }
  }
  return sums;
};

const incomePeriods = sumPeriods(incomeRoots);
const expensePeriods = sumPeriods(expenseRoots);
const transferPeriods = sumPeriods(transferRoots);
const remainingPeriods = incomePeriods.map((inc, i) =>
  inc - expensePeriods[i] - transferPeriods[i]
);
```

**d) Income displayed as positive:**
In the budget table rendering, when account type is `INCOME`, negate the displayed value (GnuCash stores income as negative).
- In `InlineAmountEditor`, add an `invertDisplay` prop. When true, display `-value` but store the original sign when saving.
- Apply to both cell display and footer totals.

**e) Liabilities displayed as negative:**
When type is `LIABILITY`, display as negative (representing deductions from available funds).

**f) KPI summary cards adjustments:**
The summary cards at top (lines 520-546):
- "Total Budget" should show Income total (displayed as positive) since it represents available budget
- "Average per Period" should reflect corrected total

**g) Keep "Add Account" button AND add inline editing:**
(Architect Decision C) Keep the "Add Account" button at lines 507-515 for bulk account addition. Additionally, make empty cells in non-budgeted account rows clickable to create budget entries inline:
- When clicking an empty cell on a non-budgeted account, call the budget amounts API `PATCH /api/budgets/[guid]/amounts` with the account_guid, period_num, and amount (defaulting to 0, opening the inline editor)
- This uses the existing `BudgetService.setAmount()` via the PATCH endpoint at `src/app/api/budgets/[guid]/amounts/route.ts`

**h) Action buttons for all rows:**
Currently action buttons (batch edit, estimate, delete) at lines 710-741 only show for `hasOwnBudget` accounts. Extend:
- For `hasOwnBudget` accounts: show existing actions (batch edit, estimate, delete)
- For non-budgeted accounts: show "Add to Budget" action that creates the budget entry via the amounts PATCH endpoint

**Acceptance Criteria:**
- Level selector controls tree expand depth
- Auto-expand reveals exactly the accounts with budget values
- Footer shows Income, Expense, Transfers, Remaining to Budget rows
- Income values display as positive throughout the budget view
- Clicking empty cells on non-budgeted accounts opens inline editor and creates budget entries
- Each row shows contextually appropriate actions
- "Add Account" button remains for bulk addition

---

## Phase 5: High Complexity

### Task 5.1: Sankey Multi-Level Restructure (Issue 5)

**Files to modify:**
- `src/app/api/dashboard/sankey/route.ts` (significant rewrite of response shape)
- `src/components/dashboard/SankeyDiagram.tsx` (add level selector, flatten algorithm)
- `src/components/charts/SankeyChart.tsx` (handle multi-column layout -- minimal changes)

**API Change**: This is an internal BFF endpoint with a single consumer (`SankeyDiagram.tsx`). Changing the response shape is acceptable. Both API and client are updated in the same commit.

**New API Response Shape:**
```typescript
interface SankeyHierarchyNode {
  guid: string;
  name: string;
  value: number;     // sum of all descendant splits (absolute, positive)
  depth: number;     // 0 = top category, 1 = subcategory, etc.
  children: SankeyHierarchyNode[];
}

interface SankeyResponse {
  income: SankeyHierarchyNode[];    // top-level income categories with nested children
  expense: SankeyHierarchyNode[];   // top-level expense categories with nested children
  totalIncome: number;
  totalExpenses: number;
  savings: number;
  maxDepth: number;                 // maximum depth found in the tree
}
```

**API Implementation** (`sankey/route.ts`):
1. Keep existing logic for fetching accounts and splits (lines 27-158)
2. Instead of building flat nodes/links, build recursive tree:
   ```typescript
   function buildHierarchy(
     parentGuid: string,
     depth: number,
     isIncome: boolean
   ): SankeyHierarchyNode[] {
     const children = categoryAccounts.filter(a => a.parent_guid === parentGuid);
     return children
       .map(child => {
         const descendants = getDescendants(child.guid);
         const rawTotal = getCategoryTotal(descendants);
         const value = isIncome ? -rawTotal : rawTotal; // negate income
         const subChildren = buildHierarchy(child.guid, depth + 1, isIncome);
         return {
           guid: child.guid,
           name: child.name,
           value: Math.round(value * 100) / 100,
           depth,
           children: subChildren,
         };
       })
       .filter(n => n.value > 0); // exclude zero/negative
   }

   const incomeTree = buildHierarchy(incomeParent.guid, 0, true);
   const expenseTree = buildHierarchy(expenseParent.guid, 0, false);
   ```
3. Compute `maxDepth` by traversing the tree
4. Apply currency conversion from Phase 2

**Client-Side Flatten Algorithm** (`SankeyDiagram.tsx`):

This is the core algorithm for converting the hierarchical tree into flat `nodes[]` and `links[]` for the D3 sankey layout at different level depths.

```typescript
function flattenToSankey(
  incomeTree: SankeyHierarchyNode[],
  expenseTree: SankeyHierarchyNode[],
  totalIncome: number,
  totalExpenses: number,
  savings: number,
  displayLevels: number  // 1, 2, or 3
): { nodes: { name: string }[]; links: { source: number; target: number; value: number }[] } {
  const nodes: { name: string }[] = [];
  const links: { source: number; target: number; value: number }[] = [];

  // --- Step 1: Build income-side nodes (left of center) ---
  // At displayLevels=1: [Income Categories] -> [Total Income]
  // At displayLevels=2: [Subcategories] -> [Income Categories] -> [Total Income]
  // At displayLevels=3: [Sub-sub] -> [Subcategories] -> [Income Categories] -> [Total Income]

  // Collect income nodes by level, deepest first (leftmost in diagram)
  const incomeLevelNodes: Map<number, { name: string; value: number; parentName: string | null }[]> = new Map();

  function collectIncomeNodes(
    tree: SankeyHierarchyNode[],
    parentName: string | null,
    currentDepth: number,
    maxDisplayDepth: number
  ) {
    for (const node of tree) {
      if (currentDepth < maxDisplayDepth) {
        // This level is displayed as a node
        const level = incomeLevelNodes.get(currentDepth) || [];
        level.push({ name: `${node.name}`, value: node.value, parentName });
        incomeLevelNodes.set(currentDepth, level);

        if (currentDepth + 1 < maxDisplayDepth && node.children.length > 0) {
          collectIncomeNodes(node.children, node.name, currentDepth + 1, maxDisplayDepth);
        }
      }
    }
  }

  collectIncomeNodes(incomeTree, null, 0, displayLevels);

  // --- Step 2: Add nodes to flat array ---
  // Order: deepest income levels first (leftmost), then "Total Income",
  //        then "Total Expenses + Savings", then shallowest expense levels (rightmost deepest last)

  // Duplicate name handling: prefix with parent name if collision
  const usedNames = new Set<string>();
  function uniqueName(name: string, side: 'income' | 'expense'): string {
    const candidate = `${name}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    // Disambiguate: add (Income) or (Expense) suffix
    const disambiguated = `${name} (${side === 'income' ? 'Inc' : 'Exp'})`;
    usedNames.add(disambiguated);
    return disambiguated;
  }

  // Income levels: add from deepest to shallowest
  const incomeNodeIndices: Map<string, number> = new Map(); // "level:name" -> node index
  for (let level = displayLevels - 1; level >= 0; level--) {
    const levelNodes = incomeLevelNodes.get(level) || [];
    for (const ln of levelNodes) {
      const name = uniqueName(ln.name, 'income');
      const idx = nodes.length;
      nodes.push({ name });
      incomeNodeIndices.set(`${level}:${ln.name}`, idx);
    }
  }

  // Central nodes
  const totalIncomeIdx = nodes.length;
  nodes.push({ name: 'Total Income' });
  const totalExpSavingsIdx = nodes.length;
  nodes.push({ name: 'Total Expenses + Savings' });

  // Expense levels: add from shallowest to deepest
  const expenseLevelNodes: Map<number, { name: string; value: number; parentName: string | null }[]> = new Map();

  function collectExpenseNodes(
    tree: SankeyHierarchyNode[],
    parentName: string | null,
    currentDepth: number,
    maxDisplayDepth: number
  ) {
    for (const node of tree) {
      if (currentDepth < maxDisplayDepth) {
        const level = expenseLevelNodes.get(currentDepth) || [];
        level.push({ name: node.name, value: node.value, parentName });
        expenseLevelNodes.set(currentDepth, level);

        if (currentDepth + 1 < maxDisplayDepth && node.children.length > 0) {
          collectExpenseNodes(node.children, node.name, currentDepth + 1, maxDisplayDepth);
        }
      }
    }
  }

  collectExpenseNodes(expenseTree, null, 0, displayLevels);

  const expenseNodeIndices: Map<string, number> = new Map();
  for (let level = 0; level < displayLevels; level++) {
    const levelNodes = expenseLevelNodes.get(level) || [];
    for (const ln of levelNodes) {
      const name = uniqueName(ln.name, 'expense');
      const idx = nodes.length;
      nodes.push({ name });
      expenseNodeIndices.set(`${level}:${ln.name}`, idx);
    }
  }

  // Add Savings node if positive
  let savingsIdx = -1;
  if (savings > 0) {
    savingsIdx = nodes.length;
    nodes.push({ name: 'Savings' });
  }

  // --- Step 3: Build links ---

  // Income side: deeper levels link to their parent level
  for (let level = displayLevels - 1; level > 0; level--) {
    const levelNodes = incomeLevelNodes.get(level) || [];
    for (const ln of levelNodes) {
      const sourceIdx = incomeNodeIndices.get(`${level}:${ln.name}`);
      const targetIdx = incomeNodeIndices.get(`${level - 1}:${ln.parentName}`);
      if (sourceIdx !== undefined && targetIdx !== undefined && ln.value > 0) {
        links.push({ source: sourceIdx, target: targetIdx, value: ln.value });
      }
    }
  }

  // Shallowest income level (level 0) links to Total Income
  const level0Income = incomeLevelNodes.get(0) || [];
  for (const ln of level0Income) {
    const sourceIdx = incomeNodeIndices.get(`0:${ln.name}`);
    if (sourceIdx !== undefined && ln.value > 0) {
      links.push({ source: sourceIdx, target: totalIncomeIdx, value: ln.value });
    }
  }

  // Total Income links to Total Expenses + Savings
  if (totalIncome > 0) {
    links.push({ source: totalIncomeIdx, target: totalExpSavingsIdx, value: totalIncome });
  }

  // Total Expenses + Savings links to shallowest expense level (level 0) and savings
  const level0Expense = expenseLevelNodes.get(0) || [];
  for (const ln of level0Expense) {
    const targetIdx = expenseNodeIndices.get(`0:${ln.name}`);
    if (targetIdx !== undefined && ln.value > 0) {
      links.push({ source: totalExpSavingsIdx, target: targetIdx, value: ln.value });
    }
  }
  if (savings > 0 && savingsIdx >= 0) {
    links.push({ source: totalExpSavingsIdx, target: savingsIdx, value: savings });
  }

  // Expense side: shallower levels link to deeper levels
  for (let level = 0; level < displayLevels - 1; level++) {
    const nextLevelNodes = expenseLevelNodes.get(level + 1) || [];
    for (const ln of nextLevelNodes) {
      const sourceIdx = expenseNodeIndices.get(`${level}:${ln.parentName}`);
      const targetIdx = expenseNodeIndices.get(`${level + 1}:${ln.name}`);
      if (sourceIdx !== undefined && targetIdx !== undefined && ln.value > 0) {
        links.push({ source: sourceIdx, target: targetIdx, value: ln.value });
      }
    }
  }

  return { nodes, links };
}
```

**Node layout visual at each level:**
```
Level 1 (default):
  [Salary] ─────────── [Total Income] ── [Total Exp+Sav] ─────── [Housing]
  [Freelance] ────────/                                   \────── [Food]
                                                           \───── [Savings]

Level 2:
  [Consulting] ── [Freelance] ─── [Total Income] ── [Total Exp+Sav] ── [Housing] ── [Rent]
  [Projects]  ──/  [Salary] ───/                                  \── [Food]   ── [Groceries]
                                                                   \── [Savings]   [Restaurants]

Level 3: (adds another layer on each side)
```

**SankeyDiagram.tsx changes:**
1. Add level selector dropdown:
   ```tsx
   const [displayLevel, setDisplayLevel] = useState(1);
   // ...
   <select value={displayLevel} onChange={(e) => setDisplayLevel(parseInt(e.target.value))}>
     {Array.from({ length: maxDepth }, (_, i) => (
       <option key={i + 1} value={i + 1}>Level {i + 1}</option>
     ))}
   </select>
   ```
2. Compute flat nodes/links from hierarchy using `flattenToSankey()` in a `useMemo`
3. Pass computed `nodes`/`links` to `SankeyChart`
4. Changing levels re-renders client-side only (no new API call)

**SankeyChart.tsx changes:**
- Minimal changes needed. The D3 sankey layout already handles multi-column flows via `sankeyJustify` alignment.
- For 3+ levels with many nodes, increase minimum chart height: `Math.max(propHeight, nodes.length * 25)`

**Acceptance Criteria:**
- Default view shows Level 1 with central Total Income / Total Expenses + Savings nodes
- Level selector allows 1 to maxDepth levels
- Changing levels re-renders client-side (no API call)
- Flows are proportional and readable
- Duplicate names across income/expense are disambiguated with (Inc)/(Exp) suffix
- Small categories (below 1% of total) are grouped into "Other" or hidden

---

### Task 5.2: Treasurer's Report (Issue 10)

**Files to modify:**
- `src/lib/reports/types.ts` (add new report type enum and config entry)
- New: `src/app/api/reports/treasurer/route.ts`
- New: `src/app/(main)/reports/treasurer/page.tsx`
- New: `src/components/reports/TreasurerReport.tsx`

**Config Storage**: (Architect Decision D) Form fields on the report page with localStorage defaults.
- localStorage key: `treasurer-report-config`
- Fields: Organization Name (string), Role Title (default "Treasurer"), Person Name (string)
- Collapsible "Report Header" section at the top of the report page

**Implementation:**

**1. Report Type Registration** (`src/lib/reports/types.ts`):
```typescript
export enum ReportType {
  // ... existing
  TREASURER = 'treasurer',
}

// Add to REPORTS array:
{
  type: ReportType.TREASURER,
  name: "Treasurer's Report",
  description: 'Monthly treasurer report with opening/closing balances, income and expense detail',
  icon: 'account',
  category: 'financial',
}
```

**2. TreasurerReportData Type** -- this is a DIFFERENT type from `ReportData`:
```typescript
// In a new file: src/lib/reports/treasurer-types.ts
// OR added to types.ts

export interface TreasurerReportData {
  header: {
    organization: string;
    roleName: string;
    personName: string;
    reportDate: string;
    periodStart: string;
    periodEnd: string;
  };
  openingBalance: {
    accounts: Array<{ name: string; balance: number }>;
    total: number;
  };
  incomeSummary: {
    transactions: Array<{
      date: string;
      description: string;
      category: string;
      amount: number;
    }>;
    total: number;
  };
  expenseSummary: {
    transactions: Array<{
      date: string;
      description: string;
      category: string;
      amount: number;
    }>;
    total: number;
  };
  closingBalance: {
    accounts: Array<{ name: string; balance: number }>;
    total: number;
  };
}
```

**3. ReportViewer compatibility**: `ReportViewer` is generic -- it takes `children: ReactNode` and renders them inside a card wrapper. The `reportData?: ReportData` prop added in Task 4.1 is for CSV export of standard reports. For the Treasurer's Report:
- Use `ReportViewer` for layout (filters, header, print button)
- Do NOT pass `reportData` (since `TreasurerReportData` is a different shape)
- Instead, implement a separate `handleExportCSV` inside the Treasurer page that generates CSV from `TreasurerReportData`:
  ```typescript
  function treasurerReportToCSV(data: TreasurerReportData): string {
    // Custom CSV format for treasurer report:
    // Opening Balance section, Income transactions, Expense transactions, Closing Balance
  }
  ```
- The print functionality via `window.open()` works generically via the `reportContentRef` (it captures innerHTML of children), so no special handling needed.

**4. API Endpoint** (`src/app/api/reports/treasurer/route.ts`):
- Opening Balance: Sum splits for ASSET/BANK/CASH accounts up to period start date
- Income Summary: All transactions with income account splits in period, with description from `transactions.description`, income account name as category, date, and amount (negated to positive)
- Expense Summary: Same for expense account splits (already positive in GnuCash)
- Closing Balance: Sum splits for ASSET/BANK/CASH accounts up to period end date
- Apply currency conversion for multi-currency accounts (using pattern from Phase 2)

**5. Report Page** (`src/app/(main)/reports/treasurer/page.tsx`):
- Use `ReportViewer` wrapper with date filters
- Collapsible "Report Header" section with fields:
  ```tsx
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('treasurer-report-config');
    return saved ? JSON.parse(saved) : {
      organization: '',
      roleName: 'Treasurer',
      personName: '',
    };
  });
  ```
- Auto-save to localStorage on change
- Pass config as query params to API (or include in request)

**6. Report Component** (`src/components/reports/TreasurerReport.tsx`):
- Styled tables:
  - Header section: "Treasurer's Report for [Organization]", "Prepared by [Person], [Role]", "Period: [start] to [end]"
  - Opening Balance table: Account Name | Balance
  - Income Summary table: Date | Description | Category | Amount
  - Expense Summary table: Date | Description | Category | Amount
  - Closing Balance table: Account Name | Balance
  - Verification line: Opening Balance + Income - Expenses = Closing Balance
- Print-friendly (handled by window.open() approach from Task 4.1)

**Acceptance Criteria:**
- Report appears in Reports page listing
- Config fields persist in localStorage
- Selecting date range generates correct data
- Opening balance matches sum of asset accounts at period start
- Closing balance matches sum of asset accounts at period end
- Closing Balance = Opening Balance + Income - Expenses (verified on report)
- Income and expense transactions are itemized with descriptions
- Report is printable via window.open() and exportable to CSV

---

## Commit Strategy

```
Phase 1 (5 parallel commits):
  commit 1: "fix(dashboard): use earliest transaction date for All Time filter"
  commit 2: "feat(profile): add dark/light/system theme toggle"
  commit 3: "feat(investments): add toggle to show/hide zero-share holdings"
  commit 4: "feat(investments): replace real-time quotes with historical closing price backfill in Refresh All Prices"
  commit 5: "feat(books): add name and description fields with editor modal"

Phase 2 (2 sequential commits):
  commit 6: "fix(dashboard): convert multi-currency accounts to base currency for net worth"
    - includes RECEIVABLE/PAYABLE type additions
    - includes date-specific exchange rates for time series
  commit 7: "fix(dashboard): convert income/expense/sankey values to base currency"

Phase 3 (2 commits):
  commit 8: "feat(dashboard): wrap all chart cards with ExpandableChart"
  commit 9: "fix(charts): make charts fill expanded modal viewport via ExpandedContext"

Phase 4 (2 commits):
  commit 10: "fix(reports): fix print via window.open() and implement CSV export"
  commit 11: "feat(budget): add level selector, auto-expand, 4-row footer, sign inversion, inline editing"

Phase 5 (2 commits):
  commit 12: "feat(dashboard): restructure Sankey with hierarchical API and multi-level client rendering"
  commit 13: "feat(reports): add Treasurer's Report with localStorage config and transaction detail"
```

---

## Risk Identification

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Currency exchange rates missing in DB for some currency pairs | Medium | High | Fallback to rate=1 with console warning; `findExchangeRate` already has triangulation via USD and EUR |
| Bulk currency price fetch misses triangulated pairs | Medium | Medium | Detect missing currencies after bulk fetch, fall back to `findExchangeRate()` per-datePoint for those specific currencies |
| Sankey D3 layout breaks with too many multi-level nodes | Medium | Medium | Cap displayed levels at 3; collapse small values (<1% of total) into "Other" |
| Print CSS in window.open() doesn't match Tailwind utility classes | Low | Medium | Use generic CSS rules in print window; strip Tailwind-specific attributes |
| Budget sign inversion breaks existing saved values | Low | High | Only change display layer, never modify stored values |
| ExpandableChart context causes unnecessary re-renders | Low | Low | Context only changes between false/true on expand; children memoize via useMemo where needed |
| Treasurer Report performance with large transaction sets | Medium | Medium | Paginate transactions in API; limit to period date range |
| window.open() blocked by popup blockers | Low | Medium | Show fallback message "Please allow popups for printing" if window.open returns null |
| Yahoo Finance `historical()` rate-limited for many commodities | Medium | Medium | Sequential calls with natural delay from DB writes; add try/catch per symbol so one failure doesn't block others |
| Historical backfill slow for large portfolios (20+ commodities x 3 months) | Medium | Low | Acceptable for one-time backfill; subsequent refreshes only fetch from last date to yesterday (few days typically) |
| Duplicate price entries from concurrent backfill runs | Low | Medium | All code paths use `getExistingPriceDates()` set check before each insert; note that DB has NO unique constraint on `(commodity_guid, date)`, so the set check is the ONLY dedup mechanism |
| Prisma db push fails on external GnuCash database | Medium | Medium | Provide raw SQL fallback (`ALTER TABLE books ADD COLUMN IF NOT EXISTS...`); executor checks for `prisma/migrations` directory to decide approach |
| Existing books missing name/description after schema change | Low | Low | Both columns are nullable; GET API falls back to root account name when `books.name` is null |
| BookEditorModal save fails silently | Low | Low | Add error handling with user-visible toast/error message; wrap fetch in try/catch |

---

## Verification Steps

### Per-Issue Verification

| Issue | Verification |
|-------|-------------|
| 1 - Net Worth | Check KPI shows ~$1.4MM instead of ~$1.1MM; net worth chart shows converted values per month |
| 2 - All Time | Select "All Time", verify chart spans full history (earliest transaction to now) |
| 3 - Income/Expense | Check YTD income-expense is ~$0 for 2025 (CRC expenses properly converted) |
| 4 - Expandable | Hover each of 7 chart cards, click expand, verify modal opens |
| 5 - Sankey | Select levels 1/2/3, verify node layout changes; central Total Income/Expenses nodes present |
| 6 - Chart Fill | Expand any chart, verify it fills the modal area (not stuck at 300-500px) |
| 7 - Theme Toggle | Toggle Light/Dark/System in profile, verify immediate effect and persistence |
| 8 - Zero-Share | Toggle "Show Closed Positions", verify 0-share stocks appear/disappear |
| 12 - Price Backfill | Click "Refresh All Prices", verify toast shows backfilled count and gap fills; check DB has daily closing prices from last stored date to yesterday (NOT today); verify no real-time/current quote is fetched; re-click and verify "up to date" (no duplicates) |
| 13 - Book Editor | Click edit icon on a book in BookSwitcher, verify modal opens with current name; change name and add description, save; verify BookSwitcher shows updated name and description subtitle; create new book with name/description; verify existing books without name/description still display correctly |
| 9 - Budget | Verify 4-row footer, level selector, income positive display, inline editing of empty cells |
| 10 - Treasurer | Generate report for a month, verify opening + income - expenses = closing |
| 11 - Print/CSV | Print any report (new window, not blank), download CSV (valid, importable) |

### Cross-Cutting Verification
- Run `npm run build` -- zero TypeScript errors
- Run `npm run lint` -- no new warnings
- Test on both light and dark themes
- Test with "All Time" and specific date ranges

---

## Success Criteria

1. All 13 issues resolved with no regressions
2. Net worth accuracy matches GnuCash desktop (~$1.4MM) using date-specific exchange rates
3. All dashboard charts expandable and filling modal viewport
4. Multi-currency values correctly converted across all dashboard APIs
5. Budget view provides clear income/expense/transfer/remaining visibility with sign-corrected display
6. Treasurer's Report generates correct financial data with localStorage-persisted config
7. Print uses window.open() for reliable rendering; CSV downloads valid file
8. "Refresh All Prices" backfills historical daily closing prices from last stored date to yesterday and fills gaps in last 3 months; never fetches current/real-time quotes
9. Books have editable name and description fields via BookEditorModal, with proper fallback for existing books
10. Build passes with zero errors
