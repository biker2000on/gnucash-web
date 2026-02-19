# Plan: post_date Timezone Safety Audit & Fix (v2 — Critic Feedback Addressed)

## Requirements Summary

Ensure ALL `post_date` handling across the codebase treats dates as plain dates (not datetimes with timezone conversion). GnuCash stores `post_date` as UTC midnight timestamps in PostgreSQL. When displayed or used in aggregations/comparisons, dates must not be shifted by timezone.

## Bug Patterns

| Pattern | Risk | Fix |
|---------|------|-----|
| `new Date(year, month, day)` (no UTC) | Local-tz Date constructor shifts boundary | `new Date(Date.UTC(year, month, day))` |
| `date.getFullYear()` / `date.getMonth()` | Local-tz extraction shifts month keys | `date.getUTCFullYear()` / `date.getUTCMonth()` |
| `date.setMonth()` / `date.setDate()` / `date.setFullYear()` | Local-tz mutation | `date.setUTCMonth()` / `date.setUTCDate()` / `date.setUTCFullYear()` |
| `toLocaleDateString()` without `timeZone: 'UTC'` | Display shifts date | Add `timeZone: 'UTC'` option |

## Acceptance Criteria

1. All 16 unsafe server-side files are fixed
2. No `new Date(year, month, day)` without `Date.UTC()` wrapper in server-side post_date-related code
3. No local-tz getters (`getFullYear`, `getMonth`, `getDate`) on post_date-derived Date objects in server-side code
4. No local-tz setters (`setMonth`, `setDate`, `setFullYear`) on post_date-derived Date objects in server-side code
5. Build passes with zero TypeScript errors
6. All existing behavior preserved (no functional regressions)

## Implementation Steps

### Group 1: Dashboard API Routes (HIGH PRIORITY - affects financial data bucketing)

#### Step 1.1: Fix `src/app/api/dashboard/cash-flow-chart/route.ts`
- Line 19: `new Date(now.getFullYear(), now.getMonth() - 6, 1)` → `new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1))`
- Line 22: `new Date(now.getFullYear() - 2, now.getMonth(), 1)` → `new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1))`
- Line 29: `new Date(now.getFullYear() - 1, now.getMonth(), 1)` → `new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1))`
- Line 126: `postDate.getFullYear()` → `postDate.getUTCFullYear()`, `postDate.getMonth()` → `postDate.getUTCMonth()`
- Line 152: `new Date(startDate.getFullYear(), startDate.getMonth(), 1)` → `new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1))`
- Line 153: `new Date(endDate.getFullYear(), endDate.getMonth(), 1)` → `new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1))`
- Line 156: `current.getFullYear()` → `current.getUTCFullYear()`, `current.getMonth()` → `current.getUTCMonth()`
- Line 168: `current.setMonth(current.getMonth() + 1)` → `current.setUTCMonth(current.getUTCMonth() + 1)`

#### Step 1.2: Fix `src/app/api/dashboard/income-expense/route.ts`
- Line 168: `postDate.getFullYear()` → `postDate.getUTCFullYear()`, `postDate.getMonth()` → `postDate.getUTCMonth()`
- Line 201: `new Date(startDate.getFullYear(), startDate.getMonth(), 1)` → `new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1))`
- Line 202: `new Date(endDate.getFullYear(), endDate.getMonth(), 1)` → `new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1))`
- Line 205: `current.getFullYear()` → `current.getUTCFullYear()`, `current.getMonth()` → `current.getUTCMonth()`
- Line 216: `current.setMonth(current.getMonth() + 1)` → `current.setUTCMonth(current.getUTCMonth() + 1)`

#### Step 1.3: Fix `src/app/api/dashboard/net-worth/route.ts`
- Line 19: `new Date(start.getFullYear(), start.getMonth(), 1)` → `new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))`
- Line 20: `new Date(end.getFullYear(), end.getMonth(), 1)` → `new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))`
- Line 24: `new Date(current.getFullYear(), current.getMonth() + 1, 0, 23, 59, 59, 999)` → `new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0, 23, 59, 59, 999))`
- Line 27: `current.setMonth(current.getMonth() + 1)` → `current.setUTCMonth(current.getUTCMonth() + 1)`

### Group 2: Shared Utilities (MEDIUM PRIORITY - affects multiple consumers)

#### Step 2.1: Fix `src/lib/date-utils.ts`
- Line 15: `new Date(2000, 0, 1)` → `new Date('2000-01-01T00:00:00Z')`
- Line 36: `new Date(2000, 0, 1)` → `new Date('2000-01-01T00:00:00Z')`
- Line 43: `new Date(2000, 0, 1)` → `new Date('2000-01-01T00:00:00Z')`

#### Step 2.2: Fix `src/lib/depreciation.ts`
- Line 45: `next.setMonth(next.getMonth() + 1)` → `next.setUTCMonth(next.getUTCMonth() + 1)`
- Line 48: `next.setMonth(next.getMonth() + 3)` → `next.setUTCMonth(next.getUTCMonth() + 3)`
- Line 51: `next.setFullYear(next.getFullYear() + 1)` → `next.setUTCFullYear(next.getUTCFullYear() + 1)`
- Line 201: `a.getFullYear()` → `a.getUTCFullYear()`, `b.getFullYear()` → `b.getUTCFullYear()`, `a.getMonth()` → `a.getUTCMonth()`, `b.getMonth()` → `b.getUTCMonth()`
- Line 203: `a.getFullYear()` → `a.getUTCFullYear()`, `b.getFullYear()` → `b.getUTCFullYear()`, `a.getMonth()` → `a.getUTCMonth()`, `b.getMonth()` → `b.getUTCMonth()`
- Line 205: `a.getFullYear()` → `a.getUTCFullYear()`, `b.getFullYear()` → `b.getUTCFullYear()`

### Group 3: Report Generators (MEDIUM PRIORITY - 7 files, identical fix)

All 7 files have the same bug: fallback `startDate` uses `new Date(now.getFullYear(), 0, 1)` instead of UTC.

**Fix for all 7**: Replace `new Date(now.getFullYear(), 0, 1)` with `new Date(Date.UTC(now.getUTCFullYear(), 0, 1))`

#### Step 3.1: Fix `src/lib/reports/transaction-report.ts` (line 27)
#### Step 3.2: Fix `src/lib/reports/income-statement.ts` (line 48)
#### Step 3.3: Fix `src/lib/reports/equity-statement.ts` (line 14)
- Note: This file uses `new Date(new Date().getFullYear(), 0, 1)` — replace with `new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))`
#### Step 3.4: Fix `src/lib/reports/general-journal.ts` (line 12)
#### Step 3.5: Fix `src/lib/reports/general-ledger.ts` (line 16)
#### Step 3.6: Fix `src/lib/reports/cash-flow.ts` (line 36)
#### Step 3.7: Fix `src/lib/reports/account-summary.ts` (line 11)

### Group 4: Components (MEDIUM PRIORITY)

#### Step 4.1: Fix `src/components/assets/AssetDetailView.tsx` (lines 337-339)
- Replace `d.getMonth()` → `d.getUTCMonth()`, `d.getFullYear()` → `d.getUTCFullYear()` in chart XAxis tickFormatter

### Group 5: Low Priority API Fixes

#### Step 5.1: Fix `src/app/api/investments/history/route.ts` (lines 35-36)
- Replace `startDate.setDate(startDate.getDate() - days)` → `startDate.setUTCDate(startDate.getUTCDate() - days)`

#### Step 5.2: Fix `src/lib/commodities.ts` (line 82)
- Replace `startDate.setDate(startDate.getDate() - days)` → `startDate.setUTCDate(startDate.getUTCDate() - days)`
- Same pattern as Step 5.1, both operate on `new Date()` for price query date ranges

#### Step 5.3: Fix `src/lib/services/budget.service.ts` (line 317)
- Replace `startDate.setMonth(startDate.getMonth() - months)` → `startDate.setUTCMonth(startDate.getUTCMonth() - months)`
- Used in `getHistoricalAverage()` to compute date range for post_date filtering

### Group 6: Verification

#### Step 6.1: Build verification
- Run `npm run build` to ensure zero TypeScript errors
- Run `npm run lint` to check for issues

## Files Already Fixed (this session, uncommitted)

These 5 files were fixed earlier and verified correct by the audit:
- `src/components/TransactionModal.tsx` — added `timeZone: 'UTC'` ✓
- `src/components/TransactionEditModal.tsx` — added `timeZone: 'UTC'` ✓
- `src/components/TransactionJournal.tsx` — added `timeZone: 'UTC'` ✓
- `src/components/AccountLedger.tsx` — added `timeZone: 'UTC'` ✓
- `src/components/TransactionForm.tsx` — string split instead of Date parsing ✓

## Complete File Classification (all 45 files referencing post_date)

### NEEDS FIX (16 server-side files):
1. `src/app/api/dashboard/cash-flow-chart/route.ts` — local-tz month keys + Date constructors
2. `src/app/api/dashboard/income-expense/route.ts` — local-tz month keys + Date constructors
3. `src/app/api/dashboard/net-worth/route.ts` — local-tz generateMonthlyDatePoints
4. `src/lib/date-utils.ts` — local-tz fallback dates
5. `src/lib/depreciation.ts` — local-tz setMonth/setFullYear in advanceDate()
6. `src/lib/reports/transaction-report.ts` — local-tz fallback startDate
7. `src/lib/reports/income-statement.ts` — local-tz fallback startDate
8. `src/lib/reports/equity-statement.ts` — local-tz fallback startDate
9. `src/lib/reports/general-journal.ts` — local-tz fallback startDate
10. `src/lib/reports/general-ledger.ts` — local-tz fallback startDate
11. `src/lib/reports/cash-flow.ts` — local-tz fallback startDate
12. `src/lib/reports/account-summary.ts` — local-tz fallback startDate
13. `src/components/assets/AssetDetailView.tsx` — local-tz getMonth/getFullYear in chart formatter
14. `src/app/api/investments/history/route.ts` — local-tz setDate/getDate
15. `src/lib/commodities.ts` — local-tz setDate/getDate
16. `src/lib/services/budget.service.ts` — local-tz setMonth/getMonth

### ALREADY FIXED (5 files, this session, uncommitted):
17. `src/components/TransactionModal.tsx` — timeZone: 'UTC' added
18. `src/components/TransactionEditModal.tsx` — timeZone: 'UTC' added
19. `src/components/TransactionJournal.tsx` — timeZone: 'UTC' added
20. `src/components/AccountLedger.tsx` — timeZone: 'UTC' added
21. `src/components/TransactionForm.tsx` — string split for date parsing

### CONFIRMED SAFE (server-side, no changes needed):
22. `src/lib/services/transaction.service.ts` — receives YYYY-MM-DD strings, `new Date("YYYY-MM-DD")` is UTC per JS spec
23. `src/lib/services/__tests__/transaction.service.test.ts` — test data uses string dates, assertions use toISOString
24. `src/lib/asset-transaction-service.ts` — uses `T12:00:00Z` noon UTC pattern, `.toISOString().split('T')[0]`
25. `src/lib/market-index-service.ts` — all UTC methods (setUTCHours, toISOString)
26. `src/lib/gnucash-xml/exporter.ts` — `.toISOString()` formatting (always UTC)
27. `src/lib/gnucash-xml/importer.ts` — parses GnuCash dates with +0000 UTC offset
28. `src/lib/validation.ts` — validation only, no display or storage
29. `src/lib/types.ts` — type definitions only
30. `src/lib/db-init.ts` — DDL/indexes only
31. `src/app/api/transactions/route.ts` — `new Date("YYYY-MM-DD")` is UTC per JS spec
32. `src/app/api/transactions/[guid]/route.ts` — passthrough + `new Date("YYYY-MM-DD")` is UTC
33. `src/app/api/transactions/descriptions/route.ts` — `.toISOString()` response formatting
34. `src/app/api/dashboard/sankey/route.ts` — UTC-pinned with `T23:59:59Z`, uses getEffectiveStartDate (fixed in Step 2.1)
35. `src/app/api/dashboard/kpis/route.ts` — no local-tz extraction, Date comparisons only
36. `src/app/api/reports/treasurer/route.ts` — `.toISOString()` formatting, UTC-pinned endDate
37. `src/app/api/accounts/route.ts` — `new Date("YYYY-MM-DD")` from query params (UTC)
38. `src/app/api/accounts/[guid]/valuation/route.ts` — `new Date("YYYY-MM-DD")` + `.toISOString()`
39. `src/app/api/accounts/balances/route.ts` — SQL `::date` cast, UTC fallback dates
40. `src/app/api/accounts/[guid]/transactions/route.ts` — `new Date("YYYY-MM-DD")` from query params
41. `src/app/api/assets/fixed/route.ts` — SQL `MAX(post_date)` + `.toISOString().split('T')[0]`
42. `src/lib/reports/trial-balance.ts` — endDate only, no startDate fallback
43. `src/lib/reports/investment-portfolio.ts` — endDate only, no startDate fallback
44. `src/lib/reports/reconciliation.ts` — startDate fallback is `null` (not a local Date)
45. `src/lib/reports/balance-sheet.ts` — endDate only, no startDate fallback

### CLIENT-SIDE SAFE (use local timezone intentionally for user-facing date presets):
- `src/lib/datePresets.ts` — client-side date range presets; local-tz is correct because it represents the user's "today"/"this month"
- `src/components/reports/ReportFilters.tsx` — client-side UI preset generation
- `src/app/(main)/dashboard/page.tsx` — client-side default date range
- `src/components/InvestmentAccount.tsx` — client-side chart time range
- `src/components/investments/PerformanceChart.tsx` — client-side chart time range
- `src/components/InvestmentTransactionForm.tsx` — client-side form default date

## Risk Assessment

- **Low risk**: All fixes are mechanical replacements of local-tz methods with UTC equivalents
- **No behavioral change** when server runs in UTC (Docker default)
- **Correctness improvement** for non-UTC server timezones
- **No API contract changes** — all response formats unchanged

## Total: 16 files to fix, ~36 individual line changes
