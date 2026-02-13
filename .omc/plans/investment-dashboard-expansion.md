# Investment Dashboard Expansion Plan

## Context

### Original Request
Expand the single-page investment dashboard into multiple sub-pages with sidebar sub-navigation: Holdings (default), Cash Details, and Accounts. Also fix the pie chart expansion bug where expanded pie charts don't fill the modal.

### Interview Summary
This is a mid-sized feature with clear deliverables. The current investments page (`src/app/(main)/investments/page.tsx`) is a monolithic page containing summary cards, cash allocation, allocation chart (pie/sector tabs), performance chart, and holdings table. It needs to be decomposed into three sub-pages with shared data fetching, and the sidebar navigation must be extended to support nested/expandable items.

### Research Findings
- **Sidebar**: Flat `navItems` array in `src/components/Layout.tsx` line 127. No existing support for children/sub-items. Both desktop (collapsible) and mobile sidebars render items independently -- both need updating.
- **Current page**: Single page at `src/app/(main)/investments/page.tsx` fetches from `/api/investments/portfolio` and `/api/investments/history?days=36500`. All data comes in one API call -- no per-account filtering exists in the API.
- **Pie chart bug**: `AllocationChart.tsx` line 41 has `outerRadius={100}` hardcoded. When expanded via `ExpandableChart`, the `ResponsiveContainer` gets `height="100%"` but the pie's `outerRadius` stays at 100px. The modal gives `min-h-[70vh]` but the pie never grows.
- **API**: Portfolio API returns `holdings` (per-account), `consolidatedHoldings` (per-commodity), `allocation` (by category), `cashByAccount`, `overallCash`, `sectorExposure`. History API returns `history` + `indices`. Neither supports account-level filtering.
- **Routing**: No sub-pages exist under `/investments/`. No `layout.tsx` for the investments section. Next.js App Router supports nested routes via directory structure.

---

## Work Objectives

### Core Objective
Transform the monolithic investments page into a multi-page dashboard with sidebar sub-navigation, while fixing the pie chart expansion bug.

### Deliverables
1. **Expandable sidebar navigation** with sub-items support for Investments
2. **Holdings page** (`/investments`) -- restructured main page with enhanced allocation chart tabs
3. **Cash Details page** (`/investments/cash`) -- dedicated cash analysis with sort options
4. **Accounts page** (`/investments/accounts`) -- per-account filtered view with account selector
5. **Pie chart expansion fix** -- responsive outerRadius that fills the modal

### Definition of Done
- [ ] Clicking "Investments" in sidebar navigates to `/investments` and auto-expands sub-items
- [ ] Sub-items (Holdings, Cash, Accounts) appear indented under Investments when expanded
- [ ] Holdings page shows summary cards, allocation chart (Holdings pie / Cash pie / Sector bar tabs), performance chart, holdings table
- [ ] Cash page shows sorted cash breakdown with % and $ sort toggle
- [ ] Accounts page has account selector dropdown and shows filtered holdings/allocation/performance for selected account
- [ ] Expanded pie charts fill the 90vh modal properly
- [ ] Collapsed sidebar shows sub-items in tooltip or auto-expands on hover
- [ ] Mobile sidebar shows sub-items correctly
- [ ] All pages share the same API data (no duplicate fetches within a session)
- [ ] No TypeScript errors, build passes cleanly

---

## Must Have / Must NOT Have (Guardrails)

### Must Have
- Sidebar sub-navigation that works in desktop (collapsed + expanded) and mobile
- Three distinct sub-pages under `/investments/`
- Allocation chart tab for "Cash" pie (% of portfolio that is cash per account)
- Account selector on Accounts page filtering existing data
- Responsive pie chart in expanded modal

### Must NOT Have
- New API endpoints for per-account filtering (filter client-side from existing data)
- Breaking changes to existing API response shapes
- New database queries or schema changes
- Server-side account filtering (all data already comes in one call)

---

## Task Flow and Dependencies

```
T1: Sidebar Sub-Navigation Support
    |
    +--- T2: Shared Investments Layout (data fetching)
    |       |
    |       +--- T3: Holdings Page (restructure)
    |       |
    |       +--- T4: Cash Details Page (new)
    |       |
    |       +--- T5: Accounts Page (new)
    |
    T6: Pie Chart Expansion Fix (independent)
```

**Parallelizable groups:**
- T1 and T6 can run in parallel (independent)
- T3, T4, T5 can run in parallel after T2 is complete
- T2 depends on T1 being at least structurally in place (routes exist)

---

## Detailed TODOs

### T1: Sidebar Sub-Navigation Support
**Files:** `src/components/Layout.tsx`
**Estimated effort:** Medium

#### T1.1: Extend navItems type to support children
**File:** `src/components/Layout.tsx`

Add an optional `children` array to the nav item type and update the Investments entry:

```typescript
interface NavItem {
  name: string;
  href: string;
  icon: string;
  children?: Array<{
    name: string;
    href: string;
  }>;
}

const navItems: NavItem[] = [
  { name: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard' },
  { name: 'Account Hierarchy', href: '/accounts', icon: 'List' },
  { name: 'General Ledger', href: '/ledger', icon: 'BookOpen' },
  {
    name: 'Investments',
    href: '/investments',
    icon: 'TrendingUp',
    children: [
      { name: 'Holdings', href: '/investments' },
      { name: 'Cash', href: '/investments/cash' },
      { name: 'Accounts', href: '/investments/accounts' },
    ],
  },
  { name: 'Assets', href: '/assets', icon: 'Building' },
  { name: 'Budgets', href: '/budgets', icon: 'PiggyBank' },
  { name: 'Reports', href: '/reports', icon: 'BarChart3' },
  { name: 'Import/Export', href: '/import-export', icon: 'ArrowUpDown' },
];
```

**Acceptance criteria:**
- Type definition supports optional children array
- Investments nav item has three children defined

#### T1.2: Update desktop sidebar renderNavItem for expandable items
**File:** `src/components/Layout.tsx`

The `renderNavItem()` function (line 196) must be updated:
- If item has `children`, clicking the parent navigates to `item.href` AND expands sub-items
- Sub-items auto-expand when any child route is active (`pathname?.startsWith('/investments')`)
- Add state for expanded sections: `const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());`
- Auto-expand on mount if pathname matches any child
- Sub-items render indented below parent with smaller text
- When sidebar is collapsed: show parent icon only. On hover, show tooltip with sub-item links. OR: clicking the collapsed icon navigates to default href.
- Add a small chevron icon (down/right) to indicate expandability

Desktop expanded rendering (within `renderNavItem`):
```tsx
// After the parent Link, if item.children exists and section is expanded:
{item.children && isExpanded && !collapsed && (
  <div className="ml-8 mt-1 space-y-0.5">
    {item.children.map(child => {
      const isChildActive = pathname === child.href;
      return (
        <Link
          key={child.href}
          href={child.href}
          className={`block px-3 py-1.5 text-sm rounded-lg transition-colors ${
            isChildActive
              ? 'text-sidebar-text-active bg-sidebar-active-bg/50'
              : 'text-foreground-muted hover:text-foreground-secondary hover:bg-sidebar-hover/50'
          }`}
        >
          {child.name}
        </Link>
      );
    })}
  </div>
)}
```

**Acceptance criteria:**
- Parent item click navigates to `/investments` and expands sub-items
- Sub-items appear indented below parent
- Active child is highlighted
- Section auto-expands when navigating to any child route
- Collapsed sidebar: parent icon shown, tooltip shows sub-items or simply navigates

#### T1.3: Update mobile sidebar for expandable items
**File:** `src/components/Layout.tsx`

The mobile sidebar renders items separately (line 317). Update the mobile rendering loop to handle children similarly:
- Show children indented under parent
- Auto-expand if any child is active
- Tapping a child closes the mobile sidebar (already handled by `onClick={() => setMobileOpen(false)}` on Links)

**Acceptance criteria:**
- Mobile sidebar shows sub-items under Investments
- Sub-items are indented and styled consistently with desktop
- Active child highlighted on mobile

---

### T2: Shared Investments Layout with Data Context
**Files:** New `src/app/(main)/investments/layout.tsx`, new `src/contexts/InvestmentDataContext.tsx`
**Estimated effort:** Medium

#### T2.1: Create InvestmentDataContext for shared data fetching
**File:** `src/contexts/InvestmentDataContext.tsx` (NEW)

Create a React context that fetches portfolio and history data once and shares it across all investment sub-pages:

```typescript
'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

// Re-use existing interfaces from the investments page (extract to shared types)
interface InvestmentData {
  portfolio: PortfolioData | null;
  history: HistoryData['history'];
  indices: IndicesData;
  loading: boolean;
  apiConfigured: boolean;
  fetchingPrices: boolean;
  fetchPortfolio: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  handleFetchAllPrices: () => Promise<void>;
}

const InvestmentDataContext = createContext<InvestmentData | null>(null);

export function InvestmentDataProvider({ children }: { children: ReactNode }) {
  // Move ALL data fetching from current page.tsx here
  // portfolio, history, indices, loading, fetchingPrices, apiConfigured state
  // fetchPortfolio, fetchHistory, handleFetchAllPrices functions
  // ...
  return (
    <InvestmentDataContext.Provider value={...}>
      {children}
    </InvestmentDataContext.Provider>
  );
}

export function useInvestmentData() {
  const ctx = useContext(InvestmentDataContext);
  if (!ctx) throw new Error('useInvestmentData must be used within InvestmentDataProvider');
  return ctx;
}
```

**Acceptance criteria:**
- Context provides portfolio, history, indices, loading states
- Data fetched once when provider mounts, shared across sub-pages
- `handleFetchAllPrices` available for the Refresh button
- No duplicate API calls when switching between sub-pages

#### T2.2: Create investments layout wrapper
**File:** `src/app/(main)/investments/layout.tsx` (NEW)

```typescript
import { InvestmentDataProvider } from '@/contexts/InvestmentDataContext';

export default function InvestmentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <InvestmentDataProvider>
      {children}
    </InvestmentDataProvider>
  );
}
```

**Acceptance criteria:**
- Layout wraps all investment sub-pages with the data provider
- Sub-pages can access shared data via `useInvestmentData()`

#### T2.3: Extract shared TypeScript interfaces
**File:** `src/types/investments.ts` (NEW)

Extract all investment-related interfaces currently duplicated in `page.tsx` and components:
- `PortfolioData`, `HistoryData`, `IndicesData`
- `CashByAccount`, `OverallCash`, `SectorExposure`, `ConsolidatedHolding`
- `IndexDataPoint`

This prevents duplication across the new pages and context.

**Acceptance criteria:**
- All investment interfaces in one shared file
- Existing components import from shared file
- No duplicate interface definitions

---

### T3: Holdings Page (Restructure)
**Files:** `src/app/(main)/investments/page.tsx` (MODIFY)
**Estimated effort:** Medium

#### T3.1: Refactor page to use InvestmentDataContext
**File:** `src/app/(main)/investments/page.tsx`

Remove all data fetching logic (moved to context). Replace with `useInvestmentData()` hook:

```typescript
'use client';

import { useInvestmentData } from '@/contexts/InvestmentDataContext';
// ... component imports

export default function HoldingsPage() {
  const {
    portfolio, history, indices, loading, fetchingPrices,
    apiConfigured, handleFetchAllPrices
  } = useInvestmentData();

  // Loading / empty states remain the same
  // Render: header, summary cards, allocation chart, performance chart, holdings table
}
```

**Acceptance criteria:**
- Page no longer fetches data directly
- All data comes from `useInvestmentData()`
- Same visual appearance as current page (minus CashAllocationCard which moves to Cash page)

#### T3.2: Enhance allocation chart tabs
**File:** `src/app/(main)/investments/page.tsx`

Change the allocation tab selector from `['account', 'sector']` to `['holdings', 'cash', 'sector']`:

- **Holdings** tab: existing `AllocationChart` with portfolio allocation data (current "By Account" tab)
- **Cash** tab: new pie chart showing cash as a percentage of portfolio per account. Uses `cashByAccount` data to build pie slices: each account's cash balance as a proportion.
- **Sector** tab: existing `IndustryExposureChart` (current "By Sector" tab)

For the Cash pie chart, transform `cashByAccount` data into allocation format:
```typescript
const cashPieData = portfolio.cashByAccount.map(a => ({
  category: a.parentName,
  value: a.cashBalance,
  percent: (a.cashBalance / portfolio.overallCash.totalCashBalance) * 100,
}));
```

**Acceptance criteria:**
- Three tabs: Holdings, Cash, Sector
- Holdings tab shows existing allocation pie
- Cash tab shows new cash allocation pie (% of total cash each account holds)
- Sector tab shows existing sector bar chart
- Tab labels are clear and consistent

#### T3.3: Remove CashAllocationCard from Holdings page
**File:** `src/app/(main)/investments/page.tsx`

The `CashAllocationCard` (per-account cash bars) is moved to the dedicated Cash page. Remove it from the holdings page. The "Cash" tab in the allocation chart gives a summary pie view instead.

**Acceptance criteria:**
- No `CashAllocationCard` component on the holdings page
- Cash data still available via allocation chart's Cash tab

---

### T4: Cash Details Page
**Files:** `src/app/(main)/investments/cash/page.tsx` (NEW)
**Estimated effort:** Low-Medium

#### T4.1: Create Cash Details page
**File:** `src/app/(main)/investments/cash/page.tsx` (NEW)

New page that shows detailed cash analysis:

```typescript
'use client';

import { useState } from 'react';
import { useInvestmentData } from '@/contexts/InvestmentDataContext';
import { CashAllocationCard } from '@/components/investments/CashAllocationCard';

type SortMode = 'percent' | 'amount';

export default function CashDetailsPage() {
  const { portfolio, loading } = useInvestmentData();
  const [sortMode, setSortMode] = useState<SortMode>('percent');

  if (loading || !portfolio) { /* loading skeleton */ }

  // Sort cashByAccount based on sort mode
  const sortedCash = [...portfolio.cashByAccount].sort((a, b) =>
    sortMode === 'percent'
      ? b.cashPercent - a.cashPercent
      : b.cashBalance - a.cashBalance
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Cash Details</h1>
          <p className="text-foreground-muted mt-1">Cash allocation across investment accounts</p>
        </div>
        {/* Sort toggle */}
        <div className="flex gap-1">
          <button onClick={() => setSortMode('percent')} className={...}>
            Sort by %
          </button>
          <button onClick={() => setSortMode('amount')} className={...}>
            Sort by $
          </button>
        </div>
      </header>

      <CashAllocationCard
        cashByAccount={sortedCash}
        overallCash={portfolio.overallCash}
      />
    </div>
  );
}
```

**Acceptance criteria:**
- Page renders at `/investments/cash`
- Shows `CashAllocationCard` with sorted data
- Default sort: by % cash (descending)
- Toggle to sort by $ amount (descending)
- Sort toggle buttons styled consistently with existing tabs
- Loading skeleton shown while data loads
- Empty state if no cash data

#### T4.2: Update CashAllocationCard to accept pre-sorted data
**File:** `src/components/investments/CashAllocationCard.tsx`

The component currently renders `cashByAccount` in the order received. It should respect the order passed in (already does implicitly via `.map()`). No changes needed if sorting is done in the page. However, consider adding a sort indicator or visual cue for the current sort.

**Acceptance criteria:**
- Component renders accounts in the order they're passed
- No internal re-sorting that would override parent's sort

---

### T5: Accounts Page
**Files:** `src/app/(main)/investments/accounts/page.tsx` (NEW)
**Estimated effort:** Medium

#### T5.1: Create Accounts page with account selector
**File:** `src/app/(main)/investments/accounts/page.tsx` (NEW)

New page that shows per-account investment view:

```typescript
'use client';

import { useState, useMemo } from 'react';
import { useInvestmentData } from '@/contexts/InvestmentDataContext';
import { AllocationChart } from '@/components/investments/AllocationChart';
import { PerformanceChart } from '@/components/investments/PerformanceChart';
import { HoldingsTable } from '@/components/investments/HoldingsTable';
import { PortfolioSummaryCards } from '@/components/investments/PortfolioSummaryCards';
import ExpandableChart from '@/components/charts/ExpandableChart';

export default function AccountsPage() {
  const { portfolio, history, indices, loading } = useInvestmentData();
  const [selectedAccount, setSelectedAccount] = useState<string>('');

  // Build unique parent accounts list from holdings
  const parentAccounts = useMemo(() => {
    if (!portfolio) return [];
    const parents = new Map<string, string>();
    portfolio.holdings.forEach(h => {
      // Extract parent from accountPath (second-to-last segment)
      const parts = h.accountPath.split(':');
      const parentName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      const parentKey = parentName; // Use parent name as key
      if (!parents.has(parentKey)) {
        parents.set(parentKey, parentName);
      }
    });
    return Array.from(parents.entries()).map(([key, name]) => ({ key, name }));
  }, [portfolio]);

  // Auto-select first account on load
  // ...

  // Filter holdings for selected account
  const filteredHoldings = useMemo(() => {
    if (!portfolio || !selectedAccount) return [];
    return portfolio.holdings.filter(h => {
      const parts = h.accountPath.split(':');
      const parentName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      return parentName === selectedAccount;
    });
  }, [portfolio, selectedAccount]);

  // Calculate filtered summary, allocation, etc.
  // ...

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Account View</h1>
          <p className="text-foreground-muted mt-1">Per-account investment breakdown</p>
        </div>
        {/* Account selector dropdown */}
        <select
          value={selectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
          className="px-4 py-2 bg-background-secondary border border-border rounded-lg text-foreground"
        >
          {parentAccounts.map(a => (
            <option key={a.key} value={a.key}>{a.name}</option>
          ))}
        </select>
      </header>

      {/* Filtered summary cards */}
      <PortfolioSummaryCards {...filteredSummary} />

      {/* Charts */}
      <div className="grid md:grid-cols-2 gap-6 items-stretch">
        <ExpandableChart title="Account Allocation">
          <AllocationChart data={filteredAllocation} />
        </ExpandableChart>
        <ExpandableChart title="Portfolio Performance">
          <PerformanceChart data={history} indices={indices} />
        </ExpandableChart>
      </div>

      {/* Filtered holdings table */}
      <HoldingsTable holdings={filteredHoldings} />
    </div>
  );
}
```

**Note on performance chart**: The history API currently returns portfolio-wide history, not per-account. For phase 1, the performance chart on the Accounts page can show the overall portfolio performance (with a note that it's portfolio-wide). Per-account history would require API changes that are out of scope.

**Acceptance criteria:**
- Page renders at `/investments/accounts`
- Account selector dropdown populated from unique parent accounts in holdings data
- First account auto-selected on load
- Summary cards show filtered totals for selected account
- Allocation chart shows allocation within selected account only
- Holdings table shows only holdings under selected account
- Performance chart shows overall portfolio (not per-account -- note this limitation)
- Changing account selector immediately updates all displayed data (client-side filter)
- Loading skeleton while data loads

#### T5.2: Build per-account allocation from filtered holdings
**File:** `src/app/(main)/investments/accounts/page.tsx`

Compute allocation data from filtered holdings:

```typescript
const filteredAllocation = useMemo(() => {
  if (filteredHoldings.length === 0) return [];
  const totalValue = filteredHoldings.reduce((sum, h) => sum + h.marketValue, 0);
  return filteredHoldings.map(h => ({
    category: h.symbol,
    value: h.marketValue,
    percent: totalValue > 0 ? (h.marketValue / totalValue) * 100 : 0,
  }));
}, [filteredHoldings]);
```

**Acceptance criteria:**
- Allocation pie shows individual holdings as slices (by symbol)
- Percentages sum to ~100% within the selected account

---

### T6: Pie Chart Expansion Fix
**Files:** `src/components/investments/AllocationChart.tsx`
**Estimated effort:** Low

#### T6.1: Make outerRadius responsive
**File:** `src/components/investments/AllocationChart.tsx`

**Root cause:** Line 41 has `outerRadius={100}` hardcoded. When the modal provides a large container (90vh), the `ResponsiveContainer` grows but the pie stays at 100px radius.

**Fix:** Use a percentage-based outerRadius or dynamically calculate it. Recharts `Pie` supports percentage strings for `outerRadius`.

```typescript
// BEFORE (line 41):
outerRadius={100}

// AFTER:
outerRadius={expanded ? "75%" : 100}
```

When expanded, `outerRadius="75%"` tells Recharts to use 75% of the available container dimension (min of width/height divided by 2), which will scale with the modal.

Also fix the container structure. Currently the `h-full` inner div with `ResponsiveContainer height="100%"` needs the parent to have a defined height in the expanded modal. The `ExpandableChart` modal wrapper gives `min-h-[70vh]` which should work, but the inner content div may need `flex-1` and `h-full`:

```typescript
// In AllocationChart, the outer div:
<div className={`bg-background-secondary rounded-lg p-6 border border-border ${expanded ? 'h-full flex flex-col' : ''}`}>
  <h3 className="text-lg font-semibold text-foreground mb-4">Portfolio Allocation</h3>
  <div className={expanded ? 'flex-1 min-h-0' : ''}>
    <ResponsiveContainer width="100%" height={expanded ? "100%" : 300}>
```

Additionally, when expanded, the Legend may overflow. Add `wrapperStyle` to constrain it:

```typescript
{expanded && (
  <Legend
    wrapperStyle={{ maxHeight: '120px', overflowY: 'auto' }}
    formatter={(value, entry: any) => (
      <span style={{ color: '#d4d4d4' }}>
        {value} ({entry.payload.percent.toFixed(1)}%)
      </span>
    )}
  />
)}
```

**Acceptance criteria:**
- Expanded pie chart fills the modal (not stuck at 100px radius)
- Non-expanded pie chart remains the same size (100px radius)
- Legend visible but constrained (scrollable if many items)
- No overflow/clipping of legend below modal boundary

#### T6.2: Verify other pie chart instances
**File:** Search for any other `outerRadius` hardcoded values

Ensure the new "Cash" pie chart (from T3.2) also uses the responsive pattern.

**Acceptance criteria:**
- All pie charts in the investment dashboard use responsive outerRadius when expanded

---

## Modified / New Files Summary

### Modified Files
| File | Changes |
|------|---------|
| `src/components/Layout.tsx` | Add NavItem type with children, expandable sub-items in desktop + mobile sidebar |
| `src/app/(main)/investments/page.tsx` | Remove data fetching (use context), add Cash tab to allocation, remove CashAllocationCard |
| `src/components/investments/AllocationChart.tsx` | Fix outerRadius to be responsive, fix legend overflow |

### New Files
| File | Purpose |
|------|---------|
| `src/types/investments.ts` | Shared TypeScript interfaces for investment data |
| `src/contexts/InvestmentDataContext.tsx` | Shared data fetching context for all investment pages |
| `src/app/(main)/investments/layout.tsx` | Investments layout wrapping pages with data provider |
| `src/app/(main)/investments/cash/page.tsx` | Cash Details page with sort toggle |
| `src/app/(main)/investments/accounts/page.tsx` | Per-account view with account selector |

---

## Commit Strategy

### Commit 1: T6 - Fix pie chart expansion bug
```
fix: make pie chart responsive in expanded modal view

Change hardcoded outerRadius from 100px to percentage-based value
when expanded. Constrain legend overflow in modal view.
```

### Commit 2: T1 - Sidebar sub-navigation support
```
feat: add expandable sub-items to sidebar navigation

Extend navItems to support children arrays. Add expand/collapse
behavior for desktop and mobile sidebars. Investments shows
Holdings, Cash, Accounts sub-items.
```

### Commit 3: T2 - Shared data context and layout
```
feat: add InvestmentDataContext for shared data fetching

Extract investment data fetching into a shared context provider.
Create investments layout.tsx to wrap sub-pages. Extract shared
TypeScript interfaces.
```

### Commit 4: T3 - Holdings page restructure
```
refactor: restructure investments page as Holdings sub-page

Remove direct data fetching (use context). Add Cash tab to
allocation chart. Remove CashAllocationCard (moved to Cash page).
```

### Commit 5: T4 + T5 - Cash and Accounts pages
```
feat: add Cash Details and Accounts investment sub-pages

Cash page shows per-account cash breakdown with sort by % or $.
Accounts page provides per-account filtered view with selector.
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sidebar sub-items break collapsed sidebar UX | Medium | Medium | Keep collapsed behavior simple: click navigates to parent, tooltip shows sub-items |
| Context re-renders all pages on data change | Low | Low | Data only fetched once on mount; React context is efficient for this use case |
| Performance chart not per-account on Accounts page | N/A | Low | Acceptable limitation for phase 1; add note/badge indicating portfolio-wide data |
| Recharts `outerRadius` percentage not rendering correctly | Low | Medium | Test with "75%" string; fallback to calculating pixel value from container ref |
| Mobile sidebar sub-items clutter small screens | Low | Medium | Keep sub-items compact (small text, tight padding); auto-collapse other sections |
| Account selector relies on path parsing | Medium | Low | Consistently uses `accountPath.split(':')` which matches existing pattern throughout codebase |

---

## Success Criteria

1. User clicks "Investments" in sidebar -> navigates to `/investments` with Holdings shown and sub-items expanded
2. User clicks "Cash" sub-item -> navigates to `/investments/cash` showing cash breakdown sortable by % or $
3. User clicks "Accounts" sub-item -> navigates to `/investments/accounts` with account selector and filtered data
4. Expanding any pie chart -> pie fills the modal (not stuck at 100px)
5. Sidebar sub-items work correctly in desktop expanded, desktop collapsed, and mobile views
6. No additional API calls when switching between investment sub-pages
7. Build passes with zero TypeScript errors
