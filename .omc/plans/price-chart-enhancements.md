# Work Plan: Investment Price Chart Enhancements

**Plan ID:** price-chart-enhancements
**Created:** 2026-02-04
**Status:** Ready for execution
**Revision:** 2 (Critic feedback incorporated)

---

## Context

### Original Request
Enhance the investment account price chart with time period selection, zoom capabilities, and fix the date formatting bug.

### Current Implementation Analysis

**Component:** `src/components/InvestmentAccount.tsx`
- Line 3: `import { useState, useEffect, useCallback } from 'react';` - **MISSING: useRef, useMemo**
- Line 6: `import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';`
- Line 240: `priceHistory.slice(-30)` - hardcoded to last 30 points
- Dark theme styling with cyan (#06b6d4) accent color

**API Route:** `src/app/api/accounts/[guid]/valuation/route.ts`
- Line 49: `getPriceHistory(account.commodity_guid, undefined, 90)` - hardcoded 90 days

**Business Logic:** `src/lib/commodities.ts`
- `getPriceHistory(commodityGuid, currencyGuid?, days = 30)` - accepts configurable days parameter

**Bug - Last Price Date Display (line 194):**
```tsx
Last price: {formatCurrency(holdings.latestPrice.value, 'USD')} on {holdings.latestPrice.date}
```
- Date object rendered directly shows ISO format with "T" and "Z" characters

---

## Work Objectives

### Core Objective
Transform the static 30-day price chart into an interactive, zoomable chart with user-controlled time periods and properly formatted dates.

### Deliverables
1. Time period selector (1M, 3M, 6M, 1Y, ALL) with visual toggle buttons
2. Click-and-drag zoom functionality using ReferenceArea
3. Mouse scroll wheel zoom on the chart area
4. Reset zoom button when zoomed in
5. Properly formatted "Last price" date (e.g., "Jan 15, 2025")

### Definition of Done
- [ ] All 5 time period options work correctly
- [ ] Drag-to-zoom highlights selection area and zooms on release
- [ ] Scroll wheel zooms in/out centered on view
- [ ] Reset button appears when zoomed and restores full range
- [ ] Zoom resets automatically when time period changes
- [ ] Last price date displays in human-readable format
- [ ] No TypeScript errors
- [ ] Existing dark theme styling preserved

---

## Guardrails

### Must Have
- Use existing recharts v3.7.0 capabilities (no new dependencies)
- Use correct recharts v3 event API (`CategoricalChartFunc` type)
- Use index-based zoom state (not date strings)
- Proper memoization with primitive dependencies only
- Maintain dark theme consistency (cyan #06b6d4 accent, neutral backgrounds)

### Must NOT Have
- Do NOT add new npm dependencies
- Do NOT use function references in useCallback dependencies
- Do NOT use `activeLabel` (string) - use `activeIndex` (number)
- Do NOT modify database schema
- Do NOT break existing Add Price or New Transaction functionality

---

## Task Breakdown

### Task 1: Fix React Imports

**File:** `src/components/InvestmentAccount.tsx`

**Changes:**
1. Add `useRef` and `useMemo` to React import (line 3)

**Implementation:**

```tsx
// Line 3: Replace existing import
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
```

**Acceptance Criteria:**
- [ ] All required hooks imported

---

### Task 2: Add ReferenceArea and Type Imports

**File:** `src/components/InvestmentAccount.tsx`

**Changes:**
1. Add ReferenceArea to recharts import (line 6)
2. Add CategoricalChartFunc type import

**Implementation:**

```tsx
// Line 6: Replace existing import
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea } from 'recharts';
import type { CategoricalChartFunc } from 'recharts/types/chart/types';
```

**Acceptance Criteria:**
- [ ] ReferenceArea available for zoom selection visual
- [ ] CategoricalChartFunc type available for event handlers

---

### Task 3: Add State Declarations

**File:** `src/components/InvestmentAccount.tsx`

**Changes:**
1. Add state for selected time period
2. Add index-based zoom state
3. Add drag selection state

**Location:** After line 60 (after `showTransactionModal` state)

**Implementation:**

```tsx
// Time period selection
const [selectedPeriod, setSelectedPeriod] = useState<'1M' | '3M' | '6M' | '1Y' | 'ALL'>('3M');

// Index-based zoom state
interface ZoomDomain {
    startIndex: number | null;
    endIndex: number | null;
}
const [zoomDomain, setZoomDomain] = useState<ZoomDomain>({ startIndex: null, endIndex: null });

// Drag selection state
const [isDragging, setIsDragging] = useState(false);
const [dragStart, setDragStart] = useState<number | null>(null);
const [dragEnd, setDragEnd] = useState<number | null>(null);

// Chart container ref for wheel events
const chartContainerRef = useRef<HTMLDivElement>(null);
```

**Acceptance Criteria:**
- [ ] All state uses primitives (numbers, nulls) not objects or functions
- [ ] ZoomDomain interface defined with index-based properties

---

### Task 4: Add Memoized Data Computations

**File:** `src/components/InvestmentAccount.tsx`

**Location:** After state declarations, before useCallback hooks

**Implementation:**

```tsx
// 1. Memoize filtered price history based on period selection
const filteredPriceHistory = useMemo(() => {
    if (!data?.priceHistory) return [];
    const priceHistory = data.priceHistory;
    const now = new Date();
    const cutoffDate = new Date();

    switch (selectedPeriod) {
        case '1M':
            cutoffDate.setMonth(now.getMonth() - 1);
            break;
        case '3M':
            cutoffDate.setMonth(now.getMonth() - 3);
            break;
        case '6M':
            cutoffDate.setMonth(now.getMonth() - 6);
            break;
        case '1Y':
            cutoffDate.setFullYear(now.getFullYear() - 1);
            break;
        case 'ALL':
            return priceHistory;
    }
    return priceHistory.filter(p => new Date(p.date) >= cutoffDate);
}, [data?.priceHistory, selectedPeriod]);

// 2. Memoize chart data (applies zoom to filtered data)
const chartData = useMemo(() => {
    if (!filteredPriceHistory.length) return [];

    // No zoom applied - return all filtered data
    if (zoomDomain.startIndex === null && zoomDomain.endIndex === null) {
        return filteredPriceHistory;
    }

    const start = zoomDomain.startIndex ?? 0;
    const end = zoomDomain.endIndex ?? filteredPriceHistory.length;
    return filteredPriceHistory.slice(start, end + 1);
}, [filteredPriceHistory, zoomDomain.startIndex, zoomDomain.endIndex]);
```

**Acceptance Criteria:**
- [ ] filteredPriceHistory depends only on data?.priceHistory and selectedPeriod
- [ ] chartData depends only on filteredPriceHistory and primitive zoom indices
- [ ] No function references in dependency arrays

---

### Task 5: Add Event Handlers with Correct recharts v3 API

**File:** `src/components/InvestmentAccount.tsx`

**Location:** After useMemo computations, before useEffect hooks

**Implementation:**

```tsx
// Mouse down handler - start drag selection
const handleMouseDown = useCallback<CategoricalChartFunc>((nextState, event) => {
    if (nextState.activeTooltipIndex !== undefined) {
        setIsDragging(true);
        setDragStart(nextState.activeTooltipIndex as number);
        setDragEnd(nextState.activeTooltipIndex as number);
    }
}, []);

// Mouse move handler - update drag selection
const handleMouseMove = useCallback<CategoricalChartFunc>((nextState, event) => {
    if (isDragging && nextState.activeTooltipIndex !== undefined) {
        setDragEnd(nextState.activeTooltipIndex as number);
    }
}, [isDragging]);

// Mouse up handler - apply zoom
const handleMouseUp = useCallback(() => {
    if (isDragging && dragStart !== null && dragEnd !== null && dragStart !== dragEnd) {
        const startIdx = Math.min(dragStart, dragEnd);
        const endIdx = Math.max(dragStart, dragEnd);
        setZoomDomain({ startIndex: startIdx, endIndex: endIdx });
    }
    setIsDragging(false);
    setDragStart(null);
    setDragEnd(null);
}, [isDragging, dragStart, dragEnd]);

// Wheel zoom handler - depends on filteredPriceHistory.length only
const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const dataLength = filteredPriceHistory.length;
    if (dataLength < 2) return;

    // Get current visible range
    const currentStart = zoomDomain.startIndex ?? 0;
    const currentEnd = zoomDomain.endIndex ?? dataLength - 1;
    const currentLength = currentEnd - currentStart + 1;

    // Calculate zoom factor (scroll up = zoom in, scroll down = zoom out)
    const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
    const newLength = Math.max(5, Math.min(dataLength, Math.round(currentLength * zoomFactor)));

    // If zooming out to full range, reset zoom
    if (newLength >= dataLength) {
        setZoomDomain({ startIndex: null, endIndex: null });
        return;
    }

    // Calculate center and new range
    const center = Math.floor((currentStart + currentEnd) / 2);
    const halfNew = Math.floor(newLength / 2);
    const newStart = Math.max(0, Math.min(dataLength - newLength, center - halfNew));
    const newEnd = Math.min(dataLength - 1, newStart + newLength - 1);

    setZoomDomain({ startIndex: newStart, endIndex: newEnd });
}, [filteredPriceHistory.length, zoomDomain.startIndex, zoomDomain.endIndex]);

// Reset zoom handler
const handleZoomReset = useCallback(() => {
    setZoomDomain({ startIndex: null, endIndex: null });
}, []);

// Period change handler - resets zoom
const handlePeriodChange = useCallback((period: '1M' | '3M' | '6M' | '1Y' | 'ALL') => {
    setSelectedPeriod(period);
    setZoomDomain({ startIndex: null, endIndex: null });
}, []);
```

**Acceptance Criteria:**
- [ ] Event handlers typed with CategoricalChartFunc
- [ ] Use nextState.activeTooltipIndex (number) not activeLabel (string)
- [ ] handleWheel depends on filteredPriceHistory.length (primitive)
- [ ] handlePeriodChange resets zoom when period changes

---

### Task 6: Add Period Change Zoom Reset Effect

**File:** `src/components/InvestmentAccount.tsx`

**Location:** After existing useEffect hooks (after line 78)

**Implementation:**

```tsx
// Reset zoom when period changes
useEffect(() => {
    setZoomDomain({ startIndex: null, endIndex: null });
}, [selectedPeriod]);
```

**Note:** This is a safety net in case handlePeriodChange isn't used. The explicit reset in handlePeriodChange is preferred for immediate UX.

**Acceptance Criteria:**
- [ ] Zoom resets whenever selectedPeriod changes
- [ ] Prevents stale zoom state when switching periods

---

### Task 7: Update API to Support Configurable Days

**File:** `src/app/api/accounts/[guid]/valuation/route.ts`

**Changes:**
1. Accept `days` query parameter
2. Pass to `getPriceHistory()`

**Implementation:**

```tsx
// Add after asOfDate parsing (around line 13)
const daysParam = searchParams.get('days');
const days = daysParam ? parseInt(daysParam, 10) : 365;

// Modify getPriceHistory call (around line 49)
const priceHistory = account.commodity_guid
    ? await getPriceHistory(account.commodity_guid, undefined, days)
    : [];
```

**Acceptance Criteria:**
- [ ] API accepts `?days=N` query parameter
- [ ] Without parameter, defaults to 365 days

---

### Task 8: Update Frontend Fetch

**File:** `src/components/InvestmentAccount.tsx`

**Changes:**
1. Modify fetch URL to request 365 days of data (line 65)

**Implementation:**

```tsx
// Line 65: Request full year of data
const res = await fetch(`/api/accounts/${accountGuid}/valuation?days=365`);
```

**Acceptance Criteria:**
- [ ] Frontend requests 365 days of price history

---

### Task 9: Update Chart Section UI

**File:** `src/components/InvestmentAccount.tsx`

**Location:** Replace the entire Price History Chart section (lines 234-281)

**Implementation:**

```tsx
{/* Price History Chart */}
{data?.priceHistory && data.priceHistory.length > 0 && (
    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-neutral-100">Price History</h3>
            <div className="flex items-center gap-2">
                <div className="flex gap-1">
                    {(['1M', '3M', '6M', '1Y', 'ALL'] as const).map(period => (
                        <button
                            key={period}
                            onClick={() => handlePeriodChange(period)}
                            className={`px-3 py-1 text-sm rounded-lg transition-colors ${
                                selectedPeriod === period
                                    ? 'bg-cyan-600 text-white'
                                    : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
                            }`}
                        >
                            {period}
                        </button>
                    ))}
                </div>
                {(zoomDomain.startIndex !== null || zoomDomain.endIndex !== null) && (
                    <button
                        onClick={handleZoomReset}
                        className="px-3 py-1 text-sm bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 rounded-lg transition-colors flex items-center gap-1"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Reset
                    </button>
                )}
            </div>
        </div>
        <div
            ref={chartContainerRef}
            className="h-64"
            onWheel={handleWheel}
        >
            <ResponsiveContainer width="100%" height="100%">
                <LineChart
                    data={chartData}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <XAxis
                        dataKey="date"
                        tick={{ fill: '#737373', fontSize: 12 }}
                        tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        stroke="#404040"
                    />
                    <YAxis
                        tick={{ fill: '#737373', fontSize: 12 }}
                        tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
                        stroke="#404040"
                        domain={['auto', 'auto']}
                        width={70}
                    />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: '#171717',
                            border: '1px solid #404040',
                            borderRadius: '8px'
                        }}
                        labelStyle={{ color: '#a3a3a3' }}
                        formatter={(value: number | undefined) => [`$${Number(value).toFixed(2)}`, 'Price']}
                        labelFormatter={(date) => new Date(date).toLocaleDateString('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                        })}
                    />
                    <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#06b6d4"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: '#06b6d4' }}
                    />
                    {isDragging && dragStart !== null && dragEnd !== null && (
                        <ReferenceArea
                            x1={chartData[Math.min(dragStart, dragEnd)]?.date}
                            x2={chartData[Math.max(dragStart, dragEnd)]?.date}
                            strokeOpacity={0.3}
                            fill="#06b6d4"
                            fillOpacity={0.3}
                        />
                    )}
                </LineChart>
            </ResponsiveContainer>
        </div>
    </div>
)}
```

**Acceptance Criteria:**
- [ ] Period selector buttons visible
- [ ] Reset button appears only when zoomed
- [ ] Drag selection shows cyan ReferenceArea
- [ ] Wheel events handled on container
- [ ] onMouseLeave triggers handleMouseUp for edge cases

---

### Task 10: Fix Last Price Date Formatting

**File:** `src/components/InvestmentAccount.tsx`

**Location:** Line 194

**Implementation:**

```tsx
// Replace line 194
<div className="mt-4 text-neutral-400">
    Last price: {formatCurrency(holdings.latestPrice.value, 'USD')} on{' '}
    {new Date(holdings.latestPrice.date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    })}
</div>
```

**Acceptance Criteria:**
- [ ] Date displays as "Jan 15, 2025" format
- [ ] No "T" and "Z" characters visible

---

## Implementation Order and Dependencies

```
Task 1 (React Imports)        [Start here]
    |
Task 2 (recharts Imports)     [Parallel with Task 1]
    |
    v
Task 3 (State Declarations)   [After imports]
    |
    v
Task 4 (useMemo Computations) [After state]
    |
    v
Task 5 (Event Handlers)       [After useMemo]
    |
    v
Task 6 (useEffect)            [After callbacks]
    |
    v
Task 7 (API Update)           [Independent]
    |
    v
Task 8 (Frontend Fetch)       [Depends on Task 7]
    |
    v
Task 9 (Chart UI)             [After all hooks defined]
    |
    v
Task 10 (Date Fix)            [Independent - can do anytime]
```

**Recommended Execution:**
1. Tasks 1-2: Fix all imports first
2. Tasks 3-6: Add all hooks in correct order (state -> useMemo -> useCallback -> useEffect)
3. Tasks 7-8: API changes
4. Task 9: Chart UI update
5. Task 10: Quick date format fix

---

## Function Order in Component (CRITICAL)

The component must follow this order after the state declarations:

1. **State declarations** (useState)
2. **Refs** (useRef)
3. **Memoized values** (useMemo)
4. **Callbacks** (useCallback)
5. **Effects** (useEffect)

This ensures dependencies are available when needed and follows React best practices.

---

## Verification Steps

### Manual Testing Checklist
1. [ ] Load investment account page - chart renders with 3M data by default
2. [ ] Click each period button (1M, 3M, 6M, 1Y, ALL) - chart updates and zoom resets
3. [ ] Click and drag horizontally - cyan selection area appears
4. [ ] Release drag - chart zooms to selected range
5. [ ] Reset button appears when zoomed - click it - returns to full range
6. [ ] Change period while zoomed - zoom resets automatically
7. [ ] Scroll wheel up on chart - zooms in
8. [ ] Scroll wheel down on chart - zooms out
9. [ ] Check "Last price" date format - should be "Mon DD, YYYY"

### Build Verification
```bash
npm run build  # Should complete without errors
npm run lint   # Should pass
```

---

## Commit Strategy

**Commit 1:** Fix last price date formatting (Task 10)
```
fix: format last price date in human-readable format
```

**Commit 2:** Add time period selector (Tasks 1-4, 6-8)
```
feat: add time period selector to investment price chart

- Add useRef and useMemo to React imports
- Add memoized filtered price history
- Update API to accept configurable days parameter
- Frontend requests 365 days of history
- Add 1M/3M/6M/1Y/ALL period selector buttons
- Reset zoom when period changes
```

**Commit 3:** Implement zoom capabilities (Tasks 2, 5, 9)
```
feat: add drag and scroll zoom to price chart

- Import ReferenceArea and CategoricalChartFunc from recharts
- Use index-based zoom state
- Click and drag to select date range with visual feedback
- Scroll wheel to zoom in/out
- Reset zoom button when zoomed
```

---

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Date format fixed | "Last price" shows "Mon DD, YYYY" format |
| Period selector works | All 5 options filter chart data correctly |
| Zoom resets on period change | Switching periods clears any zoom |
| Drag zoom works | Selection area visible, zoom executes on release |
| Scroll zoom works | Wheel events zoom in/out centered on view |
| Reset works | Button appears when zoomed, resets view |
| No TypeScript errors | All types correct, no any escape hatches |
| Correct recharts v3 API | Uses activeTooltipIndex, CategoricalChartFunc |
| No regressions | Existing Add Price/Transaction modals still work |
| Clean build | `npm run build` succeeds without errors |
