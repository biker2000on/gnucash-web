# Work Plan: Investment Dashboard Fixes

## Context

### Original Request
Fix 6 issues with the Investment Dashboard related to API endpoints, data filtering, UI improvements, and price refresh logic.

### Research Findings

**Files Analyzed:**
- `src/lib/price-service.ts` - FMP API integration for fetching prices
- `src/app/api/investments/portfolio/route.ts` - Portfolio data API
- `src/app/api/prices/fetch/route.ts` - Price fetch trigger API
- `src/components/investments/HoldingsTable.tsx` - Holdings display table
- `src/components/investments/AllocationChart.tsx` - Pie chart for allocation
- `src/app/(main)/investments/page.tsx` - Main investments page
- `src/lib/commodities.ts` - Commodity utilities and price lookup

**Current State:**
1. FMP API uses incorrect `/stable/batch-quote?symbol=` endpoint (should be `/api/v3/quote/{symbols}`)
2. Zero-share holdings are included in table and portfolio calculations
3. Holdings table shows account name but no tooltip for full account path
4. Pie chart has inline labels that clutter the display; tooltip styling is dark-on-dark
5. Price refresh has no "once per day" logic - fetches on every button click
6. Portfolio value may be low due to missing prices (need to verify fetch/store flow)

---

## Work Objectives

### Core Objective
Fix all 6 identified issues to improve data accuracy, API reliability, and UI readability of the Investment Dashboard.

### Deliverables
1. Working FMP API integration using correct free-tier endpoint
2. Zero-share holdings filtered from display and calculations
3. Holdings table with tooltip showing full account path on hover
4. Clean allocation pie chart with readable tooltip styling
5. Price refresh logic that skips commodities already updated today
6. Verified price storage flow

### Definition of Done
- [ ] FMP API endpoint corrected and tested
- [ ] Holdings with shares=0 excluded from table and portfolio totals
- [ ] Hovering commodity in holdings table shows parent account path tooltip
- [ ] Pie chart labels removed, tooltip shows all info with light background
- [ ] `FetchAndStoreResult` interface updated with `skipped` field
- [ ] Price fetch skips symbols that already have today's price in database
- [ ] `force` parameter allows manual override of daily skip logic
- [ ] API route response includes `skipped` count
- [ ] All changes tested manually in browser
- [ ] TypeScript compiles without errors

---

## Guardrails

### Must Have
- Backward compatible API response structure
- Filter applied to both display AND portfolio calculations
- Tooltip must be accessible (not just CSS :hover)
- Price refresh must still work when forced

### Must NOT Have
- Breaking changes to existing API contracts
- Removal of any functionality (like manual refresh capability)
- Changes to GnuCash database schema
- Introduction of new external dependencies

---

## Task Flow

```
[Task 1: FMP API Fix]
       |
       v
[Task 2: Zero-Share Filter]
       |
       v
[Task 3: Holdings Tooltip]
       |
       v
[Task 4: Pie Chart Cleanup]
       |
       v
[Task 5: Daily Price Logic]
       |
       v
[Task 6: Verification]
```

All tasks are sequential as they build on a working foundation. Tasks 3 and 4 could technically run in parallel.

---

## Detailed Tasks

### Task 1: Fix FMP API Endpoint
**File:** `src/lib/price-service.ts`
**Priority:** HIGH (blocking - API won't work without this)

**Changes:**
```typescript
// Line 77 - CHANGE FROM:
const url = `${config.fmpBaseUrl}/stable/batch-quote?symbol=${encodeURIComponent(symbolList)}&apikey=${config.fmpApiKey}`;

// TO:
const url = `${config.fmpBaseUrl}/api/v3/quote/${symbolList}?apikey=${config.fmpApiKey}`;
```

**Notes:**
- Remove `encodeURIComponent` wrapping since symbols go in path
- Response format is the same array of quote objects
- Free tier endpoint confirmed working

**Acceptance Criteria:**
- [ ] API endpoint URL updated
- [ ] Price fetch returns successful results for valid symbols

---

### Task 2: Filter Zero-Share Holdings
**File:** `src/app/api/investments/portfolio/route.ts`
**Priority:** HIGH (affects data accuracy)

**Changes:**
After line 114 where `holdings` is built, add filter:
```typescript
const holdings = (await Promise.all(holdingsPromises)).filter(h => h.shares !== 0);
```

Or modify the existing line 114 to chain the filter.

**Impact Areas:**
- Holdings array in response (filtered)
- Summary calculations (use filtered array)
- Allocation calculations (use filtered array)

Since `summary` and `allocation` are calculated FROM the holdings array, filtering it first will automatically fix the calculations.

**Acceptance Criteria:**
- [ ] Holdings with shares=0 excluded from API response
- [ ] Portfolio totals exclude zero-share holdings
- [ ] Allocation percentages reflect only non-zero holdings

---

### Task 3: Add Holdings Table Tooltip
**File:** `src/components/investments/HoldingsTable.tsx`
**Priority:** MEDIUM (UX improvement)

**Changes:**
1. Ensure `accountPath` is passed in Holding interface (already present as optional)
2. Add tooltip to the commodity/symbol cell showing accountPath

**Implementation approach - use native HTML title attribute for simplicity:**
```tsx
<td className="px-4 py-3">
  <div className="font-medium text-neutral-100" title={holding.accountPath}>
    {holding.symbol}
  </div>
  <div className="text-sm text-neutral-500">{holding.accountName}</div>
</td>
```

**Alternative (better UX) - custom tooltip component:**
Could wrap in a tooltip component, but native `title` is simplest and accessible.

**Acceptance Criteria:**
- [ ] Hovering over commodity symbol shows full account path
- [ ] Tooltip works on both desktop and mobile (long-press)

---

### Task 4: Clean Up Allocation Pie Chart
**File:** `src/components/investments/AllocationChart.tsx`
**Priority:** MEDIUM (UX improvement)

**Changes:**

1. **Remove inline labels** (lines 38-39):
```tsx
// REMOVE these props from Pie:
label={(entry: any) => `${entry.category} (${entry.percent.toFixed(1)}%)`}
labelLine={false}
```

2. **Fix tooltip styling** (lines 45-48):
```tsx
<Tooltip
  contentStyle={{
    backgroundColor: '#f5f5f5',  // Light background
    border: '1px solid #d4d4d4',
    borderRadius: '8px',
    color: '#262626'             // Dark text
  }}
  labelStyle={{ color: '#262626' }}  // Dark label
  formatter={(value: number | undefined, name: string, entry: any) => [
    `${formatCurrency(value ?? 0)} (${entry.payload.percent.toFixed(1)}%)`,
    entry.payload.category
  ]}
/>
```

3. **Enhance Legend** to show percentages (optional but recommended since removing labels):
```tsx
<Legend
  formatter={(value, entry: any) => (
    <span style={{ color: '#d4d4d4' }}>
      {value} ({entry.payload.percent.toFixed(1)}%)
    </span>
  )}
/>
```

**Acceptance Criteria:**
- [ ] No inline labels on pie chart segments
- [ ] Tooltip has light background with dark text (readable)
- [ ] Tooltip shows category name, value, and percentage
- [ ] Legend is still visible

---

### Task 5: Implement Daily Price Refresh Logic
**Files:**
- `src/lib/price-service.ts` (interface + logic)
- `src/app/api/prices/fetch/route.ts` (API response)

**Priority:** HIGH (API quota protection)

**Changes:**

#### 5a. Update FetchAndStoreResult Interface
**File:** `src/lib/price-service.ts` (lines 54-59)

Add `skipped` field to the interface:
```typescript
export interface FetchAndStoreResult {
  fetched: number;
  stored: number;
  failed: number;
  skipped: number;  // NEW: commodities skipped due to existing today's price
  results: PriceFetchResult[];
}
```

#### 5b. Add Helper Function for Daily Check
**File:** `src/lib/price-service.ts`

Add helper function to check if price exists for today:
```typescript
/**
 * Check if a price record exists for the given commodity for today
 */
async function hasPriceForToday(commodityGuid: string): Promise<boolean> {
  const { default: prisma } = await import('./prisma');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const existingPrice = await prisma.prices.findFirst({
    where: {
      commodity_guid: commodityGuid,
      date: {
        gte: today,
        lt: tomorrow,
      },
    },
  });

  return existingPrice !== null;
}
```

#### 5c. Add Force Parameter and Daily Skip Logic
**File:** `src/lib/price-service.ts`

**DECISION: YES - Implement `force` parameter** to allow manual override when needed.

Update function signature:
```typescript
export async function fetchAndStorePrices(
  symbols?: string[],
  force: boolean = false
): Promise<FetchAndStoreResult>
```

Add filtering logic after `targetCommodities` is determined:
```typescript
// Filter out commodities that already have today's price (unless force=true)
let commoditiesToFetch = targetCommodities;
let skippedCount = 0;

if (!force) {
  commoditiesToFetch = [];
  for (const commodity of targetCommodities) {
    const hasToday = await hasPriceForToday(commodity.guid);
    if (!hasToday) {
      commoditiesToFetch.push(commodity);
    } else {
      skippedCount++;
    }
  }

  if (commoditiesToFetch.length === 0) {
    return {
      fetched: 0,
      stored: 0,
      failed: 0,
      skipped: skippedCount,
      results: [],
    };
  }
}
```

Update final return statement to include `skipped`:
```typescript
return {
  fetched: fetchResults.filter(r => r.success && r.price > 0).length,
  stored,
  failed,
  skipped: skippedCount,  // ADD THIS
  results: fetchResults,
};
```

Also update the early return (line 242-247) to include `skipped: 0`.

#### 5d. Update API Route Response
**File:** `src/app/api/prices/fetch/route.ts`

Update request schema to accept `force` parameter:
```typescript
const FetchPricesSchema = z.object({
  symbols: z.array(z.string()).optional(),
  force: z.boolean().optional().default(false),  // ADD THIS
});
```

Update the call to `fetchAndStorePrices`:
```typescript
const result = await fetchAndStorePrices(symbols, parseResult.data.force);
```

Update response to include `skipped` field (line 60-74):
```typescript
return NextResponse.json({
  fetched: result.fetched,
  stored: result.stored,
  failed: result.failed,
  skipped: result.skipped,  // ADD THIS
  results: result.results.map(r => ({
    symbol: r.symbol,
    price: r.price,
    previousClose: r.previousClose,
    change: r.change,
    changePercent: r.changePercent,
    timestamp: r.timestamp.toISOString(),
    success: r.success,
    error: r.error,
  })),
});
```

**Acceptance Criteria:**
- [ ] `FetchAndStoreResult` interface includes `skipped` field
- [ ] `fetchAndStorePrices` accepts optional `force` parameter (default: false)
- [ ] Commodities with price from today are skipped (unless force=true)
- [ ] API call not made if all commodities already have today's price
- [ ] API route accepts `force` in request body
- [ ] API response includes `skipped` count
- [ ] Manual refresh works with `force: true`

---

### Task 6: Verification and Testing
**Priority:** HIGH (quality gate)

**Manual Testing Checklist:**
1. Trigger price refresh - verify FMP API succeeds
2. Check holdings table - no zero-share entries
3. Hover over symbols - see account path tooltip
4. View pie chart - no inline labels, tooltip readable
5. Refresh prices again - should skip (already have today's price), response shows `skipped` count
6. Refresh with `force: true` - should fetch even if already have today's price
7. Check portfolio totals reflect only non-zero holdings

**TypeScript Verification:**
- Run `npx tsc --noEmit` to ensure no type errors from interface changes

**Acceptance Criteria:**
- [ ] All 5 previous tasks verified working
- [ ] `FetchAndStoreResult` interface compiles without errors
- [ ] API response includes `skipped` field
- [ ] `force` parameter works correctly
- [ ] No console errors
- [ ] No TypeScript errors

---

## Commit Strategy

### Recommended Commits
1. `fix(investments): correct FMP API endpoint for free tier` - Task 1
2. `fix(investments): filter zero-share holdings from portfolio` - Task 2
3. `feat(investments): add account path tooltip to holdings table` - Task 3
4. `fix(investments): improve pie chart readability` - Task 4
5. `feat(investments): implement daily price refresh with force option` - Task 5 (includes interface update, API route update, and force parameter)

Or combine into single commit:
`fix(investments): correct API endpoint, filter zero holdings, improve UI, add daily price logic`

---

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| API works | Price fetch returns data successfully |
| Data accuracy | Zero-share holdings excluded from all calculations |
| UI readability | Pie chart has no label clutter, tooltip is legible |
| API efficiency | Second price refresh in same day returns skipped count |
| User experience | Tooltip shows full account path on hover |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| FMP API response format differs | Low | High | Test with real API call first |
| Zero-share filter affects intended data | Low | Medium | Only filter shares === 0, not < 0 |
| Tooltip not working on touch devices | Medium | Low | Native title attribute handles this |
| Price date comparison timezone issues | Medium | Medium | Use local timezone, set hours to 0 |

---

## Notes

- The FMP free tier has rate limits (250 calls/day). Daily refresh logic helps stay within quota.
- Account path is already available in the portfolio API response (`accountPath` field).
- Consider adding a "Last Updated" indicator to show when prices were last fetched.
