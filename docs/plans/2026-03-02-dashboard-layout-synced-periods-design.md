# Dashboard Layout Overhaul + Synced Time Periods

**Date:** 2026-03-02
**Status:** Approved

## Summary

Simplify the dashboard layout, make the Sankey diagram full-width, group all 3 pie charts on one row, add a shared period selector that syncs all charts, and persist the user's default period as a preference.

## New Layout

```
┌─────────────────────────────────────────────────────┐
│  Dashboard                    [This Month ▾] [★]    │  period buttons + save default
├─────────────────────────────────────────────────────┤
│  Net Worth │ Income │ Expenses │ Savings │ Invest   │  KPI cards (unchanged)
├─────────────────────────────────────────────────────┤
│              Net Worth Over Time                    │  full width
├─────────────────────────────────────────────────────┤
│               Income Flow (Sankey)                  │  full width (was 1/3)
├────────────────┬────────────────┬───────────────────┤
│   Income by    │  Expenses by   │   Taxes by        │  3 pie charts in a row
│   Category     │  Category      │   Category        │
├─────────────────────────────────────────────────────┤
│                  Cash Flow                          │  full width
└─────────────────────────────────────────────────────┘
```

**Removed charts:** Income vs Expenses bar chart, Net Profit by Month chart (redundant with Cash Flow).

## DashboardPeriodContext

New context at `src/contexts/DashboardPeriodContext.tsx`.

```typescript
type DashboardPeriod = 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'thisYear' | 'lastYear' | 'allTime';

interface DashboardPeriodContextType {
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
  startDate: string | null;    // computed ISO date, null = all time
  endDate: string | null;      // computed ISO date, null = all time
  queryString: string;         // precomputed '?startDate=...&endDate=...'
}
```

- Provider wraps dashboard page content in `src/app/(main)/dashboard/page.tsx`
- Period options: This Month | Last Month | This Quarter | This Year | Last Year | All Time
- Default on load: reads `dashboardDefaultPeriod` from UserPreferencesContext, falls back to `thisYear`
- Period-to-date conversion happens client-side in the context provider

## Period Selector UI

- Replaces the existing DateRangePicker in the dashboard header
- Button group showing the 6 period options (styled like Cash Flow's current period buttons)
- Star/pin button to save the current period as the user's default
- Toast confirmation on save

## API Changes

### Cash Flow API Refactor
- **Before:** `/api/dashboard/cash-flow-chart?period=6M` (server computes dates)
- **After:** `/api/dashboard/cash-flow-chart?startDate=...&endDate=...` (same as all other APIs)
- Period-to-date logic moves to client-side context

### Data Fetching
- Each chart component calls `useDashboardPeriod()` to get `queryString`
- Charts re-fetch when `queryString` changes
- KPIs and pie charts also consume the context

## Preference Persistence

- Storage key: `dashboard.default_period` in `gnucash_web_user_preferences` table
- Follows existing `performance_chart.*` pattern
- New field `dashboardDefaultPeriod` added to `UserPreferencesContext`
- Load: context reads initial value from UserPreferencesContext on mount
- Save: star button calls `PATCH /api/user/preferences` with `{ dashboardDefaultPeriod: period }`

## Files Changed

- `src/contexts/DashboardPeriodContext.tsx` — new file
- `src/app/(main)/dashboard/page.tsx` — layout restructure, remove DateRangePicker, add provider
- `src/components/charts/CashFlowChart.tsx` — remove internal period selector, consume context
- `src/app/api/dashboard/cash-flow-chart/route.ts` — accept startDate/endDate instead of period
- `src/contexts/UserPreferencesContext.tsx` — add dashboardDefaultPeriod field
- `src/app/api/user/preferences/route.ts` — handle dashboardDefaultPeriod
- `src/components/ui/DateRangePicker.tsx` — no longer used by dashboard (may still be used elsewhere)
