# Dashboard Layout Overhaul + Synced Time Periods — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify the dashboard layout (full-width Sankey, 3 pie charts in a row, remove redundant charts) and replace the DateRangePicker with a shared DashboardPeriodContext that syncs all charts to the same time period, with the default period persisted as a user preference.

**Architecture:** New `DashboardPeriodContext` wraps the dashboard, converting named periods (thisMonth, thisYear, etc.) to `{startDate, endDate}` using existing `DATE_PRESETS` from `src/lib/datePresets.ts`. Each chart calls `useDashboardPeriod()` for the query string. The Cash Flow API is refactored from `?period=6M` to `?startDate=...&endDate=...` to match all other dashboard APIs. Default period is stored via the existing user preferences key-value system.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma ORM

---

### Task 1: Add `dashboardDefaultPeriod` to User Preferences

**Files:**
- Modify: `src/app/api/user/preferences/route.ts:7-11` (add validation constant)
- Modify: `src/app/api/user/preferences/route.ts:52-62` (GET: read preference)
- Modify: `src/app/api/user/preferences/route.ts:79` (PATCH: destructure new field)
- Modify: `src/app/api/user/preferences/route.ts:120-165` (PATCH: save + return)
- Modify: `src/contexts/UserPreferencesContext.tsx:7-18` (add to interface + state)

This task adds the `dashboardDefaultPeriod` field to the existing preferences system, following the exact same pattern as `defaultLedgerMode` and `dateFormat`.

**Step 1: Add validation constant and type to the API route**

In `src/app/api/user/preferences/route.ts`, add after line 11:

```typescript
const VALID_DASHBOARD_PERIODS = ['thisMonth', 'lastMonth', 'thisQuarter', 'thisYear', 'lastYear', 'allTime'] as const;
type DashboardPeriod = typeof VALID_DASHBOARD_PERIODS[number];
```

**Step 2: Add GET support for dashboardDefaultPeriod**

In the default GET handler (around line 56), add after the `dateFormatPref` line:

```typescript
const dashboardPeriodPref = await getPreference(roleResult.user.id, 'dashboard.default_period', 'thisYear');
```

And add to the returned JSON object:

```typescript
dashboardDefaultPeriod: (VALID_DASHBOARD_PERIODS.includes(dashboardPeriodPref as DashboardPeriod) ? dashboardPeriodPref : 'thisYear') as DashboardPeriod,
```

**Step 3: Add PATCH support for dashboardDefaultPeriod**

In the PATCH handler, destructure `dashboardDefaultPeriod` from body (line 79):

```typescript
const { balanceReversal, defaultTaxRate, defaultLedgerMode, dateFormat, dashboardDefaultPeriod } = body;
```

Add validation block after the dateFormat validation (after line 120):

```typescript
if (dashboardDefaultPeriod !== undefined) {
    if (!VALID_DASHBOARD_PERIODS.includes(dashboardDefaultPeriod)) {
        return NextResponse.json(
            { error: `Invalid dashboardDefaultPeriod value. Must be one of: ${VALID_DASHBOARD_PERIODS.join(', ')}` },
            { status: 400 }
        );
    }
}
```

Add persistence block after the dateFormat persistence (after line 149):

```typescript
if (dashboardDefaultPeriod !== undefined) {
    await setPreference(roleResult.user.id, 'dashboard.default_period', dashboardDefaultPeriod);
}
```

Add to the PATCH response object (around line 165):

```typescript
const dashboardPeriodPref = await getPreference(roleResult.user.id, 'dashboard.default_period', 'thisYear');
```

And in the returned JSON:

```typescript
dashboardDefaultPeriod: (VALID_DASHBOARD_PERIODS.includes(dashboardPeriodPref as DashboardPeriod) ? dashboardPeriodPref : 'thisYear') as DashboardPeriod,
```

**Step 4: Add to UserPreferencesContext**

In `src/contexts/UserPreferencesContext.tsx`:

Add the type after line 7:

```typescript
export type DashboardPeriod = 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'thisYear' | 'lastYear' | 'allTime';
```

Add to the interface (after `dateFormat` line):

```typescript
dashboardDefaultPeriod: DashboardPeriod;
setDashboardDefaultPeriod: (period: DashboardPeriod) => Promise<void>;
```

Add state (after `dateFormat` state):

```typescript
const [dashboardDefaultPeriod, setDashboardDefaultPeriodState] = useState<DashboardPeriod>('thisYear');
```

Add to the load function (after dateFormat handling):

```typescript
if (parsed.dashboardDefaultPeriod) {
    setDashboardDefaultPeriodState(parsed.dashboardDefaultPeriod);
}
```

And in the API response handler:

```typescript
setDashboardDefaultPeriodState(data.dashboardDefaultPeriod || 'thisYear');
```

Add setter callback (follow the exact pattern of `setDateFormat`):

```typescript
const setDashboardDefaultPeriod = useCallback(async (value: DashboardPeriod) => {
    setDashboardDefaultPeriodState(value);
    const cached = localStorage.getItem(STORAGE_KEY);
    const existing = cached ? JSON.parse(cached) : {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, dashboardDefaultPeriod: value }));
    try {
        const res = await fetch('/api/user/preferences', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dashboardDefaultPeriod: value }),
        });
        if (!res.ok) throw new Error('Failed to save preference');
    } catch (error) {
        console.error('Failed to save dashboardDefaultPeriod preference:', error);
        throw error;
    }
}, []);
```

Add to the `useMemo` value object and its dependency array.

**Step 5: Verify the dev server compiles without errors**

Run: `npm run dev` and check for TypeScript errors in terminal output.

**Step 6: Commit**

```bash
git add src/app/api/user/preferences/route.ts src/contexts/UserPreferencesContext.tsx
git commit -m "feat: add dashboardDefaultPeriod to user preferences"
```

---

### Task 2: Create DashboardPeriodContext

**Files:**
- Create: `src/contexts/DashboardPeriodContext.tsx`

This context converts a named period to `{startDate, endDate, queryString}` using the existing `DATE_PRESETS` from `src/lib/datePresets.ts`, and reads the initial period from `UserPreferencesContext`.

**Step 1: Create the context file**

Create `src/contexts/DashboardPeriodContext.tsx`:

```typescript
"use client";

import { createContext, useContext, useState, useMemo, ReactNode } from 'react';
import { useUserPreferences, DashboardPeriod } from './UserPreferencesContext';
import { DATE_PRESETS } from '@/lib/datePresets';

// Map DashboardPeriod keys to DATE_PRESETS labels
const PERIOD_TO_LABEL: Record<DashboardPeriod, string> = {
    thisMonth: 'This Month',
    lastMonth: 'Last Month',
    thisQuarter: 'This Quarter',
    thisYear: 'This Year',
    lastYear: 'Last Year',
    allTime: 'All Time',
};

export const PERIOD_OPTIONS: { key: DashboardPeriod; label: string }[] = [
    { key: 'thisMonth', label: 'This Month' },
    { key: 'lastMonth', label: 'Last Month' },
    { key: 'thisQuarter', label: 'This Quarter' },
    { key: 'thisYear', label: 'This Year' },
    { key: 'lastYear', label: 'Last Year' },
    { key: 'allTime', label: 'All Time' },
];

function computeDateRange(period: DashboardPeriod): { startDate: string | null; endDate: string | null } {
    const label = PERIOD_TO_LABEL[period];
    const preset = DATE_PRESETS.find(p => p.label === label);
    if (!preset) return { startDate: null, endDate: null };
    return preset.getValue();
}

function buildQueryString(startDate: string | null, endDate: string | null): string {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

interface DashboardPeriodContextType {
    period: DashboardPeriod;
    setPeriod: (p: DashboardPeriod) => void;
    startDate: string | null;
    endDate: string | null;
    queryString: string;
}

const DashboardPeriodContext = createContext<DashboardPeriodContextType | undefined>(undefined);

export function DashboardPeriodProvider({ children }: { children: ReactNode }) {
    const { dashboardDefaultPeriod } = useUserPreferences();
    const [period, setPeriod] = useState<DashboardPeriod>(dashboardDefaultPeriod);

    const { startDate, endDate } = useMemo(() => computeDateRange(period), [period]);
    const queryString = useMemo(() => buildQueryString(startDate, endDate), [startDate, endDate]);

    const value = useMemo<DashboardPeriodContextType>(() => ({
        period,
        setPeriod,
        startDate,
        endDate,
        queryString,
    }), [period, startDate, endDate, queryString]);

    return (
        <DashboardPeriodContext.Provider value={value}>
            {children}
        </DashboardPeriodContext.Provider>
    );
}

export function useDashboardPeriod() {
    const context = useContext(DashboardPeriodContext);
    if (context === undefined) {
        throw new Error('useDashboardPeriod must be used within a DashboardPeriodProvider');
    }
    return context;
}
```

**Step 2: Verify compilation**

Run: `npm run dev` — confirm no TypeScript errors.

**Step 3: Commit**

```bash
git add src/contexts/DashboardPeriodContext.tsx
git commit -m "feat: create DashboardPeriodContext for synced dashboard periods"
```

---

### Task 3: Refactor Cash Flow API to accept startDate/endDate

**Files:**
- Modify: `src/app/api/dashboard/cash-flow-chart/route.ts:9-35` (replace period parsing with date parsing)

**Step 1: Replace period parameter parsing with date parameter parsing**

In `src/app/api/dashboard/cash-flow-chart/route.ts`, replace lines 14-35 (from `const searchParams` through the end of the switch statement) with:

```typescript
const searchParams = request.nextUrl.searchParams;
const startDateParam = searchParams.get('startDate');
const endDateParam = searchParams.get('endDate');

const endDate = endDateParam ? new Date(endDateParam + 'T23:59:59Z') : new Date();

let startDate: Date;
if (startDateParam) {
    startDate = new Date(startDateParam + 'T00:00:00Z');
} else {
    startDate = await getEffectiveStartDate(null);
}
```

This makes the Cash Flow API accept the same `?startDate=...&endDate=...` format as every other dashboard API. When no params are provided (All Time), it uses `getEffectiveStartDate(null)` for the start and `now` for the end — the same behavior the old `ALL` period had.

**Step 2: Verify compilation**

Run: `npm run dev` — confirm no TypeScript errors.

**Step 3: Commit**

```bash
git add src/app/api/dashboard/cash-flow-chart/route.ts
git commit -m "refactor: cash flow API accepts startDate/endDate instead of period"
```

---

### Task 4: Refactor CashFlowChart component to consume context

**Files:**
- Modify: `src/components/charts/CashFlowChart.tsx`

Remove the internal period selector and data fetching. Instead, accept `data` and `loading` as props (same pattern as all other dashboard charts), and the dashboard page will fetch the data and pass it down.

**Step 1: Convert CashFlowChart to accept props instead of self-fetching**

Replace the entire file content with a version that:
- Removes `useState` for `period`, `data`, `loading`
- Removes the `useEffect` data fetch
- Removes the period button UI
- Accepts `data: CashFlowData[]` and `loading: boolean` as props
- Keeps the chart rendering exactly as-is

```typescript
'use client';

import { useContext } from 'react';
import {
    AreaChart,
    Area,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend,
} from 'recharts';
import { ExpandedContext } from './ExpandableChart';

export interface CashFlowData {
    month: string;
    income: number;
    expenses: number;
    netCashFlow: number;
}

// Keep all the existing formatCurrency, formatFullCurrency, formatMonth,
// ChartSkeleton, and CustomTooltip exactly as they are (lines 26-117).
// Only the default export changes.

interface CashFlowChartProps {
    data: CashFlowData[];
    loading: boolean;
}

export default function CashFlowChart({ data, loading }: CashFlowChartProps) {
    const expanded = useContext(ExpandedContext);

    if (loading) return <ChartSkeleton />;

    if (!data || data.length === 0) {
        return (
            <div className={`bg-surface border border-border rounded-xl p-6 ${expanded ? 'h-full' : ''}`}>
                <div className="h-[350px] flex items-center justify-center">
                    <p className="text-foreground-muted text-sm">No cash flow data available for this period.</p>
                </div>
            </div>
        );
    }

    const height = expanded ? 500 : 300;

    // Return the same chart JSX as currently exists (lines 205-261),
    // but without the period button header div.
    // The ExpandableChart wrapper in the dashboard page already provides the title.
}
```

Key changes:
- Export the `CashFlowData` interface (dashboard page needs it for fetching)
- Remove `useState` for `period`, `data`, `loading`
- Remove `useEffect` fetch
- Remove the period buttons and internal title header
- Accept `{ data, loading }` props
- Keep all chart rendering, tooltip, formatting functions unchanged

**Step 2: Verify compilation**

Run: `npm run dev` — expect errors in dashboard page (fixed in Task 5).

**Step 3: Commit**

```bash
git add src/components/charts/CashFlowChart.tsx
git commit -m "refactor: CashFlowChart accepts data/loading props, remove self-fetch"
```

---

### Task 5: Restructure Dashboard Page

**Files:**
- Modify: `src/app/(main)/dashboard/page.tsx` (major rewrite)

This is the largest task. The dashboard page needs to:
1. Remove `DateRangePicker` import and usage
2. Remove `IncomeExpenseBarChart` and `NetProfitChart` imports and usage
3. Remove `monthlyData` / `monthlyLoading` state and `fetchIncomeExpense`
4. Wrap content in `DashboardPeriodProvider`
5. Extract chart content into an inner component that calls `useDashboardPeriod()`
6. Add cash flow data fetching (moved from CashFlowChart component)
7. Restructure the grid layout

**Step 1: Update imports**

Remove:
```typescript
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { DateRange } from '@/lib/datePresets';
import IncomeExpenseBarChart from '@/components/dashboard/IncomeExpenseBarChart';
import NetProfitChart from '@/components/dashboard/NetProfitChart';
```

Add:
```typescript
import { DashboardPeriodProvider, useDashboardPeriod, PERIOD_OPTIONS } from '@/contexts/DashboardPeriodContext';
import { useUserPreferences, DashboardPeriod } from '@/contexts/UserPreferencesContext';
import { CashFlowData } from '@/components/charts/CashFlowChart';
```

**Step 2: Split into wrapper + inner component**

The outer `DashboardPage` handles the book-checking logic and wraps with `DashboardPeriodProvider`. The inner `DashboardContent` uses `useDashboardPeriod()`.

```typescript
export default function DashboardPage() {
    // Keep book-checking state and logic (lines 139-142, 225-295)
    // ...

    if (checkingBooks) { /* same loading UI */ }
    if (!hasBooks) { /* same welcome UI */ }

    return (
        <DashboardPeriodProvider>
            <DashboardContent />
        </DashboardPeriodProvider>
    );
}
```

**Step 3: Create DashboardContent inner component**

Move all data fetching into `DashboardContent`. Replace the old `dateRange` state and `queryString` memo with:

```typescript
function DashboardContent() {
    const { period, setPeriod, queryString } = useDashboardPeriod();
    const { dashboardDefaultPeriod, setDashboardDefaultPeriod } = useUserPreferences();

    // Keep: kpiData, netWorthData, sankeyData states + loading states
    // Add: cashFlowData + cashFlowLoading states
    // Remove: monthlyData, monthlyLoading, fetchIncomeExpense
    // Remove: dateRange state, handleDateChange, buildQueryString helper, getYearToDateRange helper
```

Add cash flow fetching (moved from CashFlowChart):

```typescript
const [cashFlowData, setCashFlowData] = useState<CashFlowData[]>([]);
const [cashFlowLoading, setCashFlowLoading] = useState(true);

const fetchCashFlow = useCallback(async (qs: string) => {
    setCashFlowLoading(true);
    try {
        const res = await fetch(`/api/dashboard/cash-flow-chart${qs}`);
        if (res.ok) {
            const result = await res.json();
            const chartData: CashFlowData[] = result.months.map((month: string, index: number) => ({
                month,
                income: result.income[index],
                expenses: result.expenses[index],
                netCashFlow: result.netCashFlow[index],
            }));
            setCashFlowData(chartData);
        }
    } catch {
        // silently fail
    } finally {
        setCashFlowLoading(false);
    }
}, []);
```

Update the data-fetching useEffect to include `fetchCashFlow` and remove `fetchIncomeExpense`:

```typescript
useEffect(() => {
    fetchKpis(queryString);
    fetchNetWorth(queryString);
    fetchSankey(queryString);
    fetchCashFlow(queryString);
}, [queryString, fetchKpis, fetchNetWorth, fetchSankey, fetchCashFlow]);
```

**Step 4: Add period selector + save-default button to header**

Replace the `DateRangePicker` in the header with:

```typescript
<div className="flex items-center gap-2">
    <div className="flex gap-1">
        {PERIOD_OPTIONS.map((opt) => (
            <button
                key={opt.key}
                onClick={() => setPeriod(opt.key)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                    period === opt.key
                        ? 'bg-primary text-white'
                        : 'bg-surface-hover text-foreground-secondary hover:bg-background-secondary'
                }`}
            >
                {opt.label}
            </button>
        ))}
    </div>
    {period !== dashboardDefaultPeriod && (
        <button
            onClick={() => setDashboardDefaultPeriod(period)}
            title="Save as default period"
            className="p-1.5 rounded-md text-foreground-secondary hover:text-amber-500 hover:bg-surface-hover transition-colors"
        >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
            </svg>
        </button>
    )}
</div>
```

The star button only shows when the current period differs from the saved default.

**Step 5: Restructure the grid layout**

Replace the chart section (lines 371-413) with the new layout:

```tsx
{/* KPI Cards */}
<KPIGrid data={kpiData} loading={kpiLoading} />

{/* Net Worth Chart - full width */}
<ExpandableChart title="Net Worth Over Time">
    <NetWorthChart data={netWorthData} loading={netWorthLoading} />
</ExpandableChart>

{/* Sankey - full width (was 1/3) */}
<ExpandableChart title="Income Flow">
    <SankeyDiagram data={sankeyData} loading={sankeyLoading} />
</ExpandableChart>

{/* 3 Pie Charts - same row */}
<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <ExpandableChart title="Income by Category">
        <IncomePieChart data={incomeCategories} loading={sankeyLoading} />
    </ExpandableChart>
    <ExpandableChart title="Expenses by Category">
        <ExpensePieChart data={expenseCategories} loading={sankeyLoading} />
    </ExpandableChart>
    <ExpandableChart title="Taxes by Category">
        <TaxPieChart data={taxCategories} loading={sankeyLoading} />
    </ExpandableChart>
</div>

{/* Cash Flow - full width */}
<ExpandableChart title="Cash Flow">
    <CashFlowChart data={cashFlowData} loading={cashFlowLoading} />
</ExpandableChart>
```

**Step 6: Clean up removed code**

- Remove `MonthlyData` interface (lines 41-47) — no longer needed
- Remove `getYearToDateRange` function (lines 58-65) — replaced by context
- Remove `buildQueryString` function (lines 67-73) — moved to context
- Remove `dateRange` state, `handleDateChange` callback
- Remove `monthlyData`, `monthlyLoading` states
- Remove `fetchIncomeExpense` callback

**Step 7: Verify compilation and visual check**

Run: `npm run dev` and open `http://localhost:3000/dashboard`. Verify:
- Period buttons appear in header
- All charts re-render when period changes
- Sankey is full-width
- 3 pie charts are in a row
- Cash Flow chart has no internal period buttons
- Income vs Expenses and Net Profit charts are gone

**Step 8: Commit**

```bash
git add src/app/(main)/dashboard/page.tsx
git commit -m "feat: restructure dashboard layout with synced period selector"
```

---

### Task 6: Delete Unused Components

**Files:**
- Delete: `src/components/dashboard/IncomeExpenseBarChart.tsx`
- Delete: `src/components/dashboard/NetProfitChart.tsx`

**Step 1: Delete the files**

```bash
rm src/components/dashboard/IncomeExpenseBarChart.tsx
rm src/components/dashboard/NetProfitChart.tsx
```

**Step 2: Verify no other imports reference them**

Search for any remaining imports of these components. They should only have been used in the dashboard page (already updated in Task 5).

**Step 3: Verify compilation**

Run: `npm run dev` — confirm no TypeScript errors.

**Step 4: Commit**

```bash
git add -u src/components/dashboard/IncomeExpenseBarChart.tsx src/components/dashboard/NetProfitChart.tsx
git commit -m "chore: remove unused IncomeExpenseBarChart and NetProfitChart"
```

---

### Task 7: Final Verification

**Step 1: Run lint**

```bash
npm run lint
```

Fix any lint errors.

**Step 2: Run production build**

```bash
npm run build
```

Confirm zero errors.

**Step 3: Manual smoke test**

Open `http://localhost:3000/dashboard` and verify:
- [ ] Period buttons render in header (This Month | Last Month | This Quarter | This Year | Last Year | All Time)
- [ ] Default period is "This Year" on first load
- [ ] Clicking a period button updates ALL charts (KPIs, Net Worth, Sankey, Pies, Cash Flow)
- [ ] Star button appears when period differs from default
- [ ] Clicking star saves the default (reload page to verify it persists)
- [ ] Sankey diagram is full-width
- [ ] 3 pie charts (Income, Expense, Tax) are on the same row
- [ ] No Income vs Expenses or Net Profit charts visible
- [ ] Cash Flow chart has no internal period buttons
- [ ] ExpandableChart expand/collapse still works for all charts
- [ ] DateRangePicker still works on Ledger and Account pages (not broken)

**Step 4: Commit any fixes, then final commit message if needed**

```bash
git add -A
git commit -m "feat: dashboard layout overhaul with synced time periods

- Sankey diagram full-width
- 3 pie charts (income, expense, tax) on same row
- Shared period selector replaces DateRangePicker
- All charts sync to selected period via DashboardPeriodContext
- Default period persisted as user preference
- Removed redundant Income vs Expenses and Net Profit charts
- Cash Flow API refactored to accept startDate/endDate"
```
