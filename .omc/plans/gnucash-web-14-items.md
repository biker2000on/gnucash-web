# GnuCash Web - 14 Items Implementation Plan

## Requirements Traceability Matrix

| Item # | Original Requirement Text | Task(s) |
|--------|--------------------------|---------|
| 1 | Sidebar menu needs to be mobile responsive and also collapsible on the desktop | Task 2.2 |
| 2 | Investment search should also find accounts of type "Mutual" | Task 1.1 |
| 3 | Create a dashboard page with: net worth KPI, net worth graph, sankey diagram, expense/income/tax pie charts, income vs expense bar chart, net profit chart, other KPIs and graphs | Tasks 4.1, 4.2 |
| 4 | Switch the graphing library to one that can make Sankey diagrams | Task 3.1 |
| 5 | Switch to use yahoo finance and their javascript library for querying it to fetch investment and crypto prices | Task 6.1 |
| 6 | Profile settings should include dark/light mode and update all areas of app to work with dark and light modes | Task 2.1 |
| 7 | Login screen was white with a dark login block in the middle | Task 1.3 |
| 8 | Budgets should show the full account hierarchy in expandable tree format with subtotal vs explicit value distinction | Task 7.1 |
| 9 | Graphs on all pages should have an expand button in top right to pop out in a modal taking the entire screen; ESC and X to close | Task 5.1 |
| 10 | Remove "read only mode" from sidebar menu | Task 1.2 |
| 11 | Allow import and export of gnucash files (*.gnucash XML) | Task 8.1 |
| 12 | Allow the app to host multiple sets of books | Task 8.2 |
| 13 | Set a default set of books on first load if you don't have a book; add new book from web interface without importing from gnucash | Task 8.3 |
| 14 | Security research: read-only, edit, admin users per book; admin can approve/add users; research only, do not implement | Task 9.1 |

---

## Context

### Original Request
Implement 14 feature items for the GnuCash Web application covering sidebar improvements, dashboard creation, charting library migration, price provider switch, theming fixes, budgets hierarchy, graph expansion, import/export, multiple books support, and security research.

### Technology Stack
- Next.js 16.1.1 / React 19.2.3 / TypeScript 5
- Tailwind CSS 4 with CSS variable theming system
- Prisma 7.3 with PostgreSQL (GnuCash schema)
- recharts 3.7 (current charting library)
- iron-session 8 + bcrypt 6 (authentication)
- @tanstack/react-query 5 (data fetching)

### Codebase Summary
- **51 component files** with ~570 hardcoded neutral-* color class usages
- **38 API routes** under `src/app/api/`
- **15 page files** under `src/app/(main)/`
- ThemeContext with light/dark/system support exists but components use hardcoded dark-mode classes
- Modal component exists (`src/components/ui/Modal.tsx`) with ESC/backdrop close, focus trap
- Sidebar is fixed `w-64` with no responsive behavior
- Home page redirects to `/accounts` (no dashboard)
- Portfolio API filters only `account_type: 'STOCK'`, excludes 'MUTUAL'
- History API also filters only `account_type: 'STOCK'`, excludes 'MUTUAL'
- FMP price service at `src/lib/price-service.ts` + `src/lib/config.ts`, stores prices with `source: 'fmp'`
- Books table exists in Prisma schema but is unused by the application
- Balance sheet report exists at `src/lib/reports/balance-sheet.ts` (already uses theme classes -- checked)

---

## Work Objectives

### Core Objective
Deliver all 14 items in a phased approach, ordered by dependencies and risk, transforming GnuCash Web from a basic accounting viewer into a full-featured financial dashboard application.

### Definition of Done
- All 14 items implemented and verified
- Application builds without errors (`npm run build`)
- Existing functionality not broken by changes
- Dark and light themes work correctly across all pages
- New features are responsive on mobile and desktop

---

## Must Have / Must NOT Have (Guardrails)

### Must Have
- Backward compatibility with existing GnuCash PostgreSQL schema
- All new UI uses CSS variable theming (no hardcoded color classes)
- Responsive design for all new pages/components
- Type safety (TypeScript strict mode compliance)
- API error handling with proper HTTP status codes

### Must NOT Have
- **Item 14**: NO implementation of security/roles -- research and documentation only
- Breaking changes to existing GnuCash database tables
- Removal of existing authentication system
- Server-side rendering for dashboard charts (client-only)

---

## Phased Implementation Plan

### PHASE 1: Quick Wins and Foundation (Items 2, 10, 7)
*Low-risk, isolated changes that establish patterns for later phases*

---

#### Task 1.1: Investment Search - Include "MUTUAL" Type (Item 2)
**Complexity: LOW**

**Problem:** Two API routes filter only `account_type: 'STOCK'`, excluding mutual fund accounts (type 'MUTUAL') from portfolio and history results:
- `src/app/api/investments/portfolio/route.ts` line 76
- `src/app/api/investments/history/route.ts` line 26

**Files to Modify:**
- `src/app/api/investments/portfolio/route.ts` - Change `account_type: 'STOCK'` to `account_type: { in: ['STOCK', 'MUTUAL'] }`
- `src/app/api/investments/history/route.ts` - Change `account_type: 'STOCK'` to `account_type: { in: ['STOCK', 'MUTUAL'] }`

**Acceptance Criteria:**
- [ ] Portfolio API returns accounts with `account_type` of both 'STOCK' and 'MUTUAL'
- [ ] History API returns historical values for both 'STOCK' and 'MUTUAL' accounts
- [ ] Mutual fund accounts appear in the holdings table on `/investments`
- [ ] Allocation chart includes mutual fund values
- [ ] Portfolio summary totals include mutual fund positions
- [ ] Historical portfolio value chart includes mutual fund positions

**Commit:** `fix(investments): include MUTUAL account type in portfolio and history queries`

---

#### Task 1.2: Remove "Read-only Mode" from Sidebar (Item 10)
**Complexity: LOW**

**Problem:** `src/components/Layout.tsx` lines 51-57 show a "Read-only Mode" status indicator in the sidebar footer that is no longer relevant.

**What to remove:** Remove the entire footer `<div>` element -- the `<div className="p-6 border-t border-neutral-800">` and all its children (the "Status" label, the green dot, and "Read-only Mode" text). This is the `<div>` immediately before `</aside>`.

**Files to Modify:**
- `src/components/Layout.tsx` - Remove the entire footer div element (lines 51-57)

**Acceptance Criteria:**
- [ ] "Read-only Mode" text no longer appears in the sidebar
- [ ] "Status" label no longer appears in the sidebar
- [ ] The `<div className="p-6 border-t border-neutral-800">` element is completely removed
- [ ] No orphaned closing tags or empty containers remain
- [ ] Sidebar ends cleanly after the `</nav>` element

**Commit:** `fix(layout): remove obsolete read-only mode indicator from sidebar`

---

#### Task 1.3: Fix Login Screen Styling (Item 7)
**Complexity: LOW**

**Problem:** `src/app/login/page.tsx` and `src/components/LoginForm.tsx` use hardcoded dark classes (`bg-neutral-950`, `bg-neutral-900/50`, `text-neutral-200`, etc.) that break in light theme. The login page background should respect the current theme.

**Files to Modify:**
- `src/app/login/page.tsx` - Replace the radial gradient background `from-neutral-900 via-neutral-950 to-neutral-950` with theme-aware gradient using CSS variables (e.g., `from-background-secondary via-background to-background`)
- `src/components/LoginForm.tsx` - Replace all hardcoded color classes with CSS variable equivalents (`bg-surface`, `border-border`, `text-foreground`, `bg-input-bg`, `border-input-border`, etc.)

**Acceptance Criteria:**
- [ ] Login page background matches the active theme (light or dark)
- [ ] Login form card uses theme surface/border colors
- [ ] Input fields use theme input colors
- [ ] Text is readable in both light and dark modes
- [ ] Gradient branding (emerald-to-cyan) is preserved in both themes
- [ ] Password strength indicator works in both themes
- [ ] `disabled:from-neutral-700 disabled:to-neutral-700` on submit button replaced with `disabled:bg-foreground-muted`

**Commit:** `fix(auth): make login screen respect light/dark theme`

---

### PHASE 2: Theme and Responsiveness (Items 6, 1)
*Foundation changes that affect all subsequent work*

---

#### Task 2.1: Dark/Light Mode - Fix All Hardcoded Colors (Item 6)
**Complexity: HIGH**

**Problem:** 51 component files contain ~570 instances of hardcoded `neutral-*` color classes (bg-neutral-900, text-neutral-400, border-neutral-800, etc.) that bypass the CSS variable theming system. The ThemeContext and CSS variables are properly set up but components don't use them.

**Strategy:** Systematic replacement across all components. Replace hardcoded Tailwind color classes with the CSS variable-based semantic classes defined in `globals.css`.

**Color Mapping Reference (Complete):**

*Background classes:*
| Hardcoded Class | Semantic Replacement | When to Use |
|---|---|---|
| `bg-neutral-950` | `bg-background` | Page-level backgrounds, outermost containers |
| `bg-neutral-900` | `bg-background-secondary` | Section-level backgrounds, secondary areas |
| `bg-neutral-800` | `bg-background-tertiary` | Tertiary panels, nested containers |
| `bg-neutral-900/30` | `bg-surface/30` | Glassmorphism cards with backdrop-blur (keep the opacity modifier) |
| `bg-neutral-900/50` | `bg-surface/50` | Semi-transparent overlays, table headers |
| `bg-neutral-950/50` | `bg-input-bg` | Input fields, form controls |
| `bg-neutral-950/30` | `bg-background/30` | Subtle background tints (summary sections) |
| `bg-neutral-950/90` | `bg-background/90` | Sticky cells with near-opaque background |

*Gradient patterns:*
| Hardcoded Class | Semantic Replacement | When to Use |
|---|---|---|
| `from-neutral-900 via-neutral-950 to-neutral-950` | `from-background-secondary via-background to-background` | Page-level radial gradients |
| `bg-gradient-to-r from-neutral-800/50 to-transparent` | `bg-gradient-to-r from-background-tertiary/50 to-transparent` | Section header gradients |
| `bg-gradient-to-r from-neutral-800 to-neutral-800/50` | `bg-gradient-to-r from-background-tertiary to-background-tertiary/50` | Report total row gradients |

*Border classes:*
| Hardcoded Class | Semantic Replacement |
|---|---|
| `border-neutral-800` | `border-border` |
| `border-neutral-700` | `border-border-hover` |
| `border-neutral-600` | `border-border-hover` (use same, slightly stronger) |

*Text classes:*
| Hardcoded Class | Semantic Replacement |
|---|---|
| `text-neutral-100` | `text-foreground` |
| `text-neutral-200` | `text-foreground` |
| `text-neutral-300` | `text-foreground-secondary` |
| `text-neutral-400` | `text-foreground-secondary` |
| `text-neutral-500` | `text-foreground-muted` |
| `text-neutral-600` | `text-foreground-muted` |
| `placeholder-neutral-600` | `placeholder-foreground-muted` |

*Interactive states:*
| Hardcoded Class | Semantic Replacement |
|---|---|
| `hover:bg-neutral-800` | `hover:bg-surface-hover` |
| `hover:bg-neutral-900` | `hover:bg-surface-hover` |
| `hover:bg-neutral-900/50` | `hover:bg-surface-hover/50` |
| `hover:text-neutral-200` | `hover:text-foreground` |
| `hover:border-neutral-700` | `hover:border-border-hover` |

*Decision rules for ambiguous cases:*
- `bg-background` vs `bg-background-secondary`: Use `bg-background` for the outermost/page level; use `bg-background-secondary` for sections within a page
- `bg-background-secondary` vs `bg-surface`: Use `bg-surface` when the element is a card/panel that sits on top of a background; use `bg-background-secondary` when it IS the background of a section
- `bg-surface` vs `bg-surface-elevated`: Use `bg-surface-elevated` for elements that visually "float" above other surfaces (dropdowns, popovers, modals)
- When an opacity modifier is present (e.g., `/30`, `/50`, `/90`), keep the opacity modifier and apply it to the semantic class
- `disabled:from-neutral-700 disabled:to-neutral-700` -> `disabled:opacity-50` (simpler, theme-agnostic approach)

**Files to Modify (all 51 files with hardcoded colors):**

*High-priority (layout/navigation):*
- `src/components/Layout.tsx` - Sidebar and main content area
- `src/components/UserMenu.tsx` - User dropdown menu

*Components:*
- `src/components/AccountHierarchy.tsx` (29 occurrences)
- `src/components/AccountForm.tsx` (22)
- `src/components/AccountLedger.tsx` (12)
- `src/components/TransactionJournal.tsx` (15)
- `src/components/TransactionModal.tsx` (19)
- `src/components/TransactionEditModal.tsx` (20)
- `src/components/TransactionForm.tsx` (19)
- `src/components/TransactionFormModal.tsx` (1)
- `src/components/SplitRow.tsx` (5)
- `src/components/ReconciliationPanel.tsx` (15)
- `src/components/CurrencyConverter.tsx` (19)
- `src/components/InvestmentAccount.tsx` (37)
- `src/components/InvestmentTransactionForm.tsx` (36)
- `src/components/BudgetList.tsx` (12)
- `src/components/BudgetForm.tsx` (11)
- `src/components/ThemeToggle.tsx` (6)

*Investment sub-components:*
- `src/components/investments/PortfolioSummaryCards.tsx` (10)
- `src/components/investments/HoldingsTable.tsx` (13)
- `src/components/investments/AllocationChart.tsx` (5)
- `src/components/investments/PerformanceChart.tsx` (6)

*Budget sub-components:*
- `src/components/budget/AccountPickerModal.tsx` (7)
- `src/components/budget/InlineAmountEditor.tsx` (1)
- `src/components/budget/BatchEditModal.tsx` (6)

*Filter components:*
- `src/components/filters/FilterPanel.tsx` (4)
- `src/components/filters/AmountFilter.tsx` (6)
- `src/components/filters/ReconcileFilter.tsx` (5)
- `src/components/filters/AccountTypeFilter.tsx` (2)

*UI components:*
- `src/components/ui/Modal.tsx` (3)
- `src/components/ui/ConfirmationDialog.tsx` (2)
- `src/components/ui/DateRangePicker.tsx` (10)
- `src/components/ui/AccountSelector.tsx` (9)
- `src/components/ui/DescriptionAutocomplete.tsx` (8)

*Report components:*
- `src/components/reports/ReportViewer.tsx` (8)
- `src/components/reports/ReportTable.tsx` (15)
- `src/components/reports/ReportFilters.tsx` (9)

*Page files:*
- `src/app/(main)/accounts/page.tsx` (9)
- `src/app/(main)/accounts/[guid]/page.tsx` (16)
- `src/app/(main)/ledger/page.tsx` (9)
- `src/app/(main)/investments/page.tsx` (9)
- `src/app/(main)/budgets/page.tsx` (9)
- `src/app/(main)/budgets/[guid]/page.tsx` (39)
- `src/app/(main)/reports/page.tsx` (7)
- `src/app/(main)/reports/income_statement/page.tsx` (2)
- `src/app/(main)/reports/account_summary/page.tsx` (1)
- `src/app/(main)/reports/transaction_report/page.tsx` (12)
- `src/app/(main)/reports/cash_flow/page.tsx` (1)
- `src/app/(main)/profile/page.tsx` (23)

**Note:** `src/lib/reports/balance-sheet.ts` was checked and does not contain hardcoded neutral-* classes (it is a server-side data module, not UI).

**Also modify:**
- `src/app/(main)/profile/page.tsx` - Add theme toggle to profile settings page (if not already there via ThemeToggle component)

**Acceptance Criteria:**
- [ ] Zero hardcoded `neutral-*` background/text/border classes remain in any component
- [ ] All components use CSS variable-based semantic color classes
- [ ] Light mode: white/light gray backgrounds, dark text, proper contrast
- [ ] Dark mode: dark backgrounds, light text, proper contrast
- [ ] Theme toggle works from profile page
- [ ] No visual regressions in dark mode (current default experience)
- [ ] Build succeeds without errors

**Commit:** `feat(theme): migrate all components from hardcoded colors to CSS variable theming`

---

#### Task 2.2: Sidebar Responsive + Collapsible (Item 1)
**Complexity: MEDIUM**

**Problem:** The sidebar in `src/components/Layout.tsx` is a fixed `w-64` element with no responsive behavior. On mobile screens it permanently consumes space, and on desktop there's no way to collapse it.

**Files to Modify:**
- `src/components/Layout.tsx` - Complete sidebar rewrite:
  - Add hamburger button for mobile (hidden on desktop)
  - Add collapse toggle button for desktop
  - Implement slide-in overlay on mobile with backdrop
  - Implement narrow icon-only mode on desktop when collapsed
  - Persist collapsed state to localStorage
  - Close mobile sidebar on navigation
  - Add `Dashboard` nav item at top of nav list (for Phase 3)
- `src/app/globals.css` - Add sidebar animation/transition classes if needed

**New State Management:**
- `sidebarCollapsed` state persisted in localStorage
- `mobileMenuOpen` state for mobile overlay
- Breakpoint detection: mobile (<768px) vs desktop (>=768px)

**Responsive Behavior:**
| Screen | Default | User Action |
|---|---|---|
| Mobile (<768px) | Sidebar hidden (off-screen) | Hamburger button opens overlay with backdrop |
| Desktop (>=768px) | Sidebar expanded (w-64) | Collapse button toggles to icon-only (w-16) |

**Acceptance Criteria:**
- [ ] Mobile: sidebar hidden by default, hamburger menu in top bar
- [ ] Mobile: sidebar opens as overlay with dark backdrop
- [ ] Mobile: tapping backdrop or nav link closes sidebar
- [ ] Desktop: collapse button in sidebar header toggles between expanded (w-64) and collapsed (w-16)
- [ ] Desktop collapsed: only icons visible, tooltip on hover showing label
- [ ] Collapsed state persists across page refreshes (localStorage)
- [ ] Smooth CSS transitions for open/close animations
- [ ] Top bar shows hamburger only on mobile
- [ ] GnuCash Web logo/title hidden when collapsed on desktop

**Commit:** `feat(layout): add responsive collapsible sidebar with mobile support`

---

### PHASE 3: Charting Library Migration (Item 4)
*Must happen before dashboard which needs Sankey*

---

#### Task 3.1: Switch Charting Library for Sankey Support (Item 4)
**Complexity: MEDIUM**

**Problem:** recharts 3.7 does not natively support Sankey diagrams. The dashboard (Item 3) requires a Sankey diagram for income-to-expense flow visualization.

**Research - Library Options:**

| Library | Sankey Support | React Integration | Bundle Size | recharts Compatibility |
|---|---|---|---|---|
| **Nivo** (@nivo/sankey + @nivo/pie + @nivo/bar + @nivo/line) | Native `<Sankey>` | Native React | ~200KB per chart | Different API, full rewrite |
| **ECharts** (echarts + echarts-for-react) | Native sankey series | React wrapper | ~800KB (tree-shakeable) | Different API, full rewrite |
| **recharts + d3-sankey** | Manual via d3-sankey | Keep recharts | +50KB | Keep existing, add d3-sankey for Sankey only |
| **Plotly** (react-plotly.js) | Native sankey trace | React wrapper | ~3MB | Different API, full rewrite |

**Recommendation: Keep recharts + add d3-sankey**

Rationale:
- Existing 3 chart components (AllocationChart, PerformanceChart, InvestmentAccount) use recharts and work well
- Rewriting them all is unnecessary risk with no user benefit
- d3-sankey is a focused library (~50KB) that provides Sankey layout calculations
- We render the Sankey using SVG directly (or recharts `<Customized>` component)
- Lowest migration cost, lowest risk

**SSR Note:** The SankeyChart component uses d3-sankey which accesses browser APIs. It must be imported with `next/dynamic` and `ssr: false` in any server-rendered page:
```tsx
const SankeyChart = dynamic(() => import('@/components/charts/SankeyChart'), { ssr: false });
```

**New Dependencies:**
```
npm install d3-sankey @types/d3-sankey
```

**Files to Create:**
- `src/components/charts/SankeyChart.tsx` - Reusable Sankey diagram component using d3-sankey for layout + SVG rendering

**Files to Modify:**
- `package.json` - Add d3-sankey dependency

**Acceptance Criteria:**
- [ ] `d3-sankey` and `@types/d3-sankey` installed
- [ ] SankeyChart component renders income-to-expense flow
- [ ] SankeyChart accepts data as props: `{ nodes: Array<{name: string}>, links: Array<{source: number, target: number, value: number}> }`
- [ ] SankeyChart is responsive (uses container width)
- [ ] SankeyChart supports light and dark theme colors
- [ ] SankeyChart is exported as default for dynamic import compatibility
- [ ] Existing recharts components continue to work unchanged
- [ ] Build succeeds

**Commit:** `feat(charts): add Sankey diagram component using d3-sankey`

---

### PHASE 4: Dashboard (Item 3)
*Depends on Phase 3 for Sankey, Phase 2 for theming*

---

#### Task 4.1: Dashboard Page - API Endpoints
**Complexity: HIGH**

**New API Routes to Create:**

1. **`src/app/api/dashboard/net-worth/route.ts`**
   - GET with query params: `startDate`, `endDate`, `interval` (monthly/weekly)
   - Returns time series: `Array<{ date: string, netWorth: number, assets: number, liabilities: number }>`

   **Net Worth Calculation (exact pseudocode):**
   ```
   ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'STOCK', 'MUTUAL']
   LIABILITY_TYPES = ['LIABILITY', 'CREDIT']

   For each date point in the time series:

     // Monetary accounts (ASSET, BANK, CASH, LIABILITY, CREDIT)
     monetary_balance = SUM(
       splits.value_num / splits.value_denom
       WHERE account.account_type IN (ASSET_TYPES without STOCK/MUTUAL) + LIABILITY_TYPES
       AND transaction.post_date <= date_point
     )

     // Investment accounts (STOCK, MUTUAL) - need market valuation
     For each account WHERE account_type IN ('STOCK', 'MUTUAL'):
       shares = SUM(splits.quantity_num / splits.quantity_denom)
                WHERE splits.account_guid = account.guid
                AND transaction.post_date <= date_point
       latest_price = most recent price from prices table
                      WHERE commodity_guid = account.commodity_guid
                      AND date <= date_point
       investment_value += shares * latest_price

     assets = monetary_balance (for ASSET_TYPES accounts only) + investment_value
     liabilities = monetary_balance (for LIABILITY_TYPES accounts only)
     // Note: liabilities are naturally NEGATIVE in GnuCash
     net_worth = assets + liabilities
   ```

   **Key rules:**
   - Equity accounts are EXCLUDED to avoid double-counting opening balances
   - For STOCK/MUTUAL: use `quantity_num/quantity_denom` for share count, multiply by latest market price
   - For monetary accounts (ASSET, BANK, CASH, LIABILITY, CREDIT): use `value_num/value_denom` directly
   - Liabilities are naturally negative in GnuCash (no sign reversal needed)
   - Net Worth = assets + liabilities (where liabilities < 0)

2. **`src/app/api/dashboard/income-expense/route.ts`**
   - GET with query params: `startDate`, `endDate`
   - Returns monthly aggregates: `Array<{ month: string, income: number, expenses: number, taxes: number, netProfit: number }>`
   - Income = sum of splits in INCOME accounts (reversed sign: GnuCash stores income splits as negative values)
   - Expenses = sum of splits in EXPENSE accounts (naturally positive in GnuCash)
   - Taxes = sum of splits in EXPENSE accounts with "Tax" in the account path
   - netProfit = income - expenses

3. **`src/app/api/dashboard/sankey/route.ts`**
   - GET with query params: `startDate`, `endDate`
   - Returns Sankey data: `{ nodes: Array<{name: string}>, links: Array<{source: number, target: number, value: number}> }`
   - Nodes: top-level income categories + top-level expense categories + "Savings" node
   - Links: income sources -> expenses/savings

4. **`src/app/api/dashboard/kpis/route.ts`**
   - GET with query params: `startDate`, `endDate`
   - Returns KPIs: `{ netWorth: number, netWorthChange: number, totalIncome: number, totalExpenses: number, savingsRate: number, topExpenseCategory: string, topExpenseAmount: number, investmentValue: number }`
   - `investmentValue`: sum of (shares * latest_price) for all STOCK/MUTUAL accounts using `quantity_num/quantity_denom` for shares

**Files to Create:**
- `src/app/api/dashboard/net-worth/route.ts`
- `src/app/api/dashboard/income-expense/route.ts`
- `src/app/api/dashboard/sankey/route.ts`
- `src/app/api/dashboard/kpis/route.ts`

**Acceptance Criteria:**
- [ ] All 4 API endpoints return correct JSON shapes
- [ ] Date range filtering works on all endpoints
- [ ] Net worth correctly sums monetary accounts via `value_num/value_denom`
- [ ] Net worth correctly values STOCK/MUTUAL as shares (`quantity_num/quantity_denom`) * latest market price
- [ ] Equity accounts are excluded from net worth calculation
- [ ] Income/expense correctly handles GnuCash sign conventions (Income splits are negative values, reversed for display)
- [ ] Sankey data correctly links income sources to expense categories
- [ ] Handles empty date ranges gracefully

**Commit:** `feat(dashboard): add API endpoints for net worth, income/expense, sankey, and KPIs`

---

#### Task 4.2: Dashboard Page - Frontend Components
**Complexity: HIGH**

**Files to Create:**
- `src/app/(main)/dashboard/page.tsx` - Dashboard page with grid layout
- `src/components/dashboard/NetWorthCard.tsx` - Net worth KPI card with sparkline
- `src/components/dashboard/NetWorthChart.tsx` - Line chart with date range selector (recharts LineChart)
- `src/components/dashboard/SankeyDiagram.tsx` - Income-to-expense flow (imports SankeyChart via `next/dynamic` with `ssr: false`)
- `src/components/dashboard/ExpensePieChart.tsx` - Expense breakdown pie chart (recharts PieChart)
- `src/components/dashboard/IncomePieChart.tsx` - Income breakdown pie chart (recharts PieChart)
- `src/components/dashboard/TaxPieChart.tsx` - Tax breakdown pie chart (recharts PieChart)
- `src/components/dashboard/IncomeExpenseBarChart.tsx` - Monthly income vs expense (recharts BarChart)
- `src/components/dashboard/NetProfitChart.tsx` - Monthly net profit line/bar chart (recharts)
- `src/components/dashboard/KPIGrid.tsx` - Grid of KPI cards (net worth, savings rate, top expense, etc.)
- `src/components/dashboard/DashboardDateRange.tsx` - Shared date range control for the dashboard

**Files to Modify:**
- `src/app/(main)/page.tsx` - Change redirect from `/accounts` to `/dashboard`
- `src/components/Layout.tsx` - Add "Dashboard" nav item at top of list (href: `/dashboard`)

**Dashboard Layout (Desktop):**
```
+-------------------------------------------+
| KPI Cards Row (4-5 cards)                 |
+-------------------------------------------+
| Net Worth Line Chart (full width)         |
| [Date Range Selector]                     |
+-------------------------------------------+
| Sankey Diagram     | Expense Pie | Income |
| (Income -> Exp)    | Chart       | Pie    |
+-------------------------------------------+
| Income vs Expense Bar Chart (full width)  |
+-------------------------------------------+
| Net Profit by Month (full width)          |
+-------------------------------------------+
| Tax Pie Chart (half width)                |
+-------------------------------------------+
```

**New recharts Imports Needed:**
- `BarChart`, `Bar` from recharts (not currently used)

**Acceptance Criteria:**
- [ ] Dashboard accessible at `/dashboard`
- [ ] Home page (`/`) redirects to `/dashboard` instead of `/accounts`
- [ ] "Dashboard" appears as first nav item in sidebar
- [ ] Net worth KPI card shows current value with period change ($ and %)
- [ ] Net worth line chart with date range selector (1M, 3M, 6M, 1Y, YTD, ALL)
- [ ] Sankey diagram shows income flowing to expense categories and savings
- [ ] Expense pie chart shows top expense categories with percentages
- [ ] Income pie chart shows income sources
- [ ] Tax pie chart shows tax categories
- [ ] Income vs expense bar chart shows monthly comparison
- [ ] Net profit chart shows monthly surplus/deficit
- [ ] All charts use theme colors (CSS variables)
- [ ] Responsive layout: stacks vertically on mobile
- [ ] Loading states with skeleton placeholders
- [ ] Empty states when no data available

**Commit:** `feat(dashboard): add comprehensive financial dashboard with charts and KPIs`

---

### PHASE 5: Graph Expand Modal (Item 9)
*Depends on Phase 3 (charting foundation). Does NOT depend on Phase 4 -- investment page charts already exist and can be wrapped independently.*

---

#### Task 5.1: Expandable Graph Modal (Item 9)
**Complexity: MEDIUM**

**Problem:** Charts on the dashboard and investments page are fixed-size. Users need the ability to expand any chart to full-screen for better inspection.

**Files to Create:**
- `src/components/charts/ExpandableChart.tsx` - Wrapper component that adds an expand button to any chart and renders it in a full-screen modal

**Component Design:**
```tsx
<ExpandableChart title="Net Worth Over Time">
  <NetWorthChart data={data} />
</ExpandableChart>
```

The wrapper:
- Renders children normally with an expand icon button in the top-right corner
- On click, opens existing `Modal` component at `size="fullscreen"` (new size to add)
- Modal shows the same chart component at full viewport size
- ESC key and X button close (already supported by Modal)

**Files to Modify:**
- `src/components/ui/Modal.tsx` - Add `fullscreen` size option: `'fullscreen': 'max-w-[95vw] h-[90vh]'`
- `src/app/(main)/dashboard/page.tsx` - Wrap each chart in `<ExpandableChart>` (if Phase 4 is complete)
- `src/app/(main)/investments/page.tsx` - Wrap investment charts in `<ExpandableChart>`
- `src/components/investments/AllocationChart.tsx` - Ensure chart fills container (ResponsiveContainer)
- `src/components/investments/PerformanceChart.tsx` - Ensure chart fills container
- `src/components/InvestmentAccount.tsx` - Ensure chart fills container

**Note:** The investment page charts can be wrapped independently of the dashboard. If Phase 4 is complete when this task runs, dashboard charts should also be wrapped. If not, wrapping dashboard charts can be a follow-up within the same commit.

**Acceptance Criteria:**
- [ ] Every chart on dashboard has a subtle expand icon (top-right corner)
- [ ] Clicking expand opens the chart in a near-full-screen modal
- [ ] Modal shows chart title in header
- [ ] Chart in modal responsively fills the available space
- [ ] ESC key closes the expanded view
- [ ] X button closes the expanded view
- [ ] Clicking backdrop closes the expanded view
- [ ] Investment page charts also have expand buttons
- [ ] Expand icon uses theme colors, visible in both light and dark mode

**Commit:** `feat(charts): add expand-to-fullscreen modal for all graphs`

---

### PHASE 6: Price Provider Switch (Item 5)
*Independent of other phases but significant risk*

---

#### Task 6.1: Switch from FMP to Yahoo Finance (Item 5)
**Complexity: MEDIUM**

**Problem:** FMP (Financial Modeling Prep) requires an API key and has rate limits on the free tier. Yahoo Finance via the `yahoo-finance2` npm package provides free, keyless access to stock and crypto prices.

**Why yahoo-finance2:** It is the most widely used Node.js library for Yahoo Finance data (1M+ weekly downloads on npm), provides a clean typed API, supports stocks/ETFs/mutual funds/crypto, and requires no API key. Alternatives like `finnhub` and `alpha-vantage` require API keys. Direct Yahoo scraping is fragile. `yahoo-finance2` abstracts that and handles Yahoo API changes via library updates.

**New Dependencies:**
```
npm install yahoo-finance2
```

**Files to Create:**
- `src/lib/yahoo-price-service.ts` - New price service using yahoo-finance2
  - `fetchBatchQuotes(symbols: string[]): Promise<PriceFetchResult[]>` - Same interface as FMP service
  - `fetchAndStorePrices(symbols?: string[], force?: boolean): Promise<FetchAndStoreResult>` - Same interface
  - Uses `yahooFinance.quote()` for individual quotes or `yahooFinance.quoteSummary()` for detailed data
  - Stores prices in the same GnuCash `prices` table with `source: 'Finance::Quote'` (for GnuCash desktop interoperability -- GnuCash desktop uses this string for all automated price fetches regardless of backend provider)

**Files to Modify:**
- `src/lib/price-service.ts` - Refactor to be a facade:
  - Import from yahoo-price-service
  - Remove FMP-specific code
  - Keep the same exported interface (`PriceFetchResult`, `FetchAndStoreResult`, `fetchBatchQuotes`, `fetchAndStorePrices`)
  - OR: Replace FMP implementation entirely with Yahoo Finance calls
- `src/lib/config.ts` - Remove FMP configuration, keep as general config
- `src/app/api/prices/fetch/route.ts` - Update if it references FMP-specific logic
- `src/app/api/investments/status/route.ts` - Update status endpoint to reflect Yahoo Finance
- `.env.example` (if exists) - Remove `FMP_API_KEY`, note that Yahoo Finance needs no key

**Migration Strategy:**
- Keep the same `PriceFetchResult` and `FetchAndStoreResult` interfaces
- yahoo-finance2 returns price data in a slightly different shape; map to existing interfaces
- Store prices with `source: 'Finance::Quote'` (previously `'fmp'`) for GnuCash desktop compatibility
- No database schema changes needed

**Acceptance Criteria:**
- [ ] `yahoo-finance2` package installed
- [ ] FMP API key no longer required (remove from env)
- [ ] Price fetching works for US stocks (e.g., AAPL, MSFT)
- [ ] Price fetching works for crypto (e.g., BTC-USD, ETH-USD)
- [ ] Price fetching works for mutual funds (e.g., VFIAX)
- [ ] Prices stored in GnuCash prices table with `source: 'Finance::Quote'`
- [ ] `/api/prices/fetch` endpoint works without API key
- [ ] `/api/investments/status` reflects Yahoo Finance status
- [ ] Error handling for invalid symbols, network failures
- [ ] Existing price history (from FMP) remains intact in database

**Risk: yahoo-finance2 uses web scraping and may break with Yahoo website changes. Mitigation: pin version, implement retry logic, log detailed errors.**

**Commit:** `feat(prices): switch from FMP to Yahoo Finance for stock/crypto price fetching`

---

### PHASE 7: Budgets Hierarchy Enhancement (Item 8)
*Independent, can run in parallel with Phase 6*

---

#### Task 7.1: Budgets Full Account Hierarchy (Item 8)
**Complexity: MEDIUM**

**Problem:** The current budget detail page at `src/app/(main)/budgets/[guid]/page.tsx` already has a hierarchy with expandable tree and subtotals. The requirements specify that the hierarchy should show ALL accounts in the tree, not just ones with budget amounts, and visually distinguish between subtotals (rolled up from children) and explicitly budgeted amounts.

**What Already Exists (DO NOT reimplement):**
- `AccountNode` interface with `ownTotal`, `rolledUpTotal`, and `rolledUpPeriods` fields
- `showRolledUp` logic at line 522: `const showRolledUp = hasChildren && !account.hasOwnBudget`
- `(subtotal)` indicator at line 559-560: `<span className="ml-2 text-cyan-600">(subtotal)</span>`
- Parent accounts already roll up child values
- Expandable tree structure already works

**What Needs to Change (delta only):**
1. **API change:** `src/app/api/budgets/[guid]/route.ts` currently returns only accounts that have budget_amounts records. It must return ALL accounts in the hierarchy so the tree shows the complete account structure.
2. **API change:** `src/app/api/budgets/[guid]/accounts/route.ts` - May need to return all accounts for tree building (not just budgeted ones).
3. **UI change:** Add a toggle to filter between "All accounts" and "Budgeted only" views in the page.
4. **Visual refinement:** Ensure subtotal rows (non-explicit parents) use `text-foreground-muted italic` styling to clearly distinguish from explicit budget amounts. The existing `(subtotal)` indicator in cyan should remain.
5. **Verify:** Only explicitly entered amounts are saved to the database (verify current behavior, do not change if already correct).

**Files to Modify:**
- `src/app/api/budgets/[guid]/route.ts` - Return full account hierarchy, not just accounts with budget amounts
- `src/app/api/budgets/[guid]/accounts/route.ts` - Return all accounts for tree building
- `src/app/(main)/budgets/[guid]/page.tsx` - UI changes:
  - Build tree from ALL accounts, not just those with budget_amounts
  - Add toggle to show "All accounts" vs "Budgeted only"
  - Ensure italic/muted styling on subtotal rows

**Acceptance Criteria:**
- [ ] Full account hierarchy visible in expandable tree
- [ ] Parent accounts show subtotals of their children
- [ ] Explicit budget amounts shown in normal weight/style
- [ ] Subtotal (rolled-up) amounts shown in italic or muted color with "(subtotal)" indicator (existing behavior preserved)
- [ ] Toggle to switch between "All accounts" and "Budgeted accounts only" views
- [ ] Only explicitly entered amounts are saved to the database
- [ ] Expanding/collapsing works for all hierarchy levels
- [ ] Performance acceptable with large account trees (100+ accounts)

**Commit:** `feat(budgets): show full account hierarchy with visual subtotal distinction`

---

### PHASE 8: Import/Export and Multiple Books (Items 11, 12, 13)
*Highest complexity, most risk -- needs careful sequencing*

---

#### Task 8.1: GnuCash XML Import/Export (Item 11)
**Complexity: HIGH**

**Problem:** No way to import or export GnuCash data. GnuCash `.gnucash` files are gzip-compressed XML containing account hierarchies, transactions, commodities, etc.

**Target GnuCash XML Version:** GnuCash 2.6+ XML format (version 2.0.0 of the file format). This covers the vast majority of GnuCash files in the wild. The XML uses namespace `http://www.gnucash.org/XML/gnc` with sub-namespaces for each element type (act, trn, split, cmdty, price, etc.).

**Scope (In/Out):**

| In Scope (v1) | Out of Scope (v1 -- acknowledged) |
|---|---|
| `gnc:account` - Full account hierarchy | `gnc:schedxaction` - Scheduled transactions |
| `gnc:transaction` + `trn:split` - All transactions and splits | `slot:value` / KVP slots - Key-value pairs on accounts/transactions |
| `gnc:commodity` - Currencies and securities | `gnc:template-transactions` - SX templates |
| `gnc:pricedb` / `price` - Price database entries | `gnc:lot` - Lot tracking for investments |
| `gnc:budget` + `bgt:amount` - Budgets and amounts | `gnc:vendor` / `gnc:customer` / `gnc:invoice` - Business features |
| `gnc:book` - Book metadata | `gnc:job` / `gnc:billterm` / `gnc:taxtable` - Business tax tables |
| `gnc:count-data` - Element counts for validation | Custom user data / report configurations |

**Limitations:**
- Slot data (key-value pairs attached to accounts, transactions, etc.) is NOT imported or exported in v1. This means some GnuCash metadata like "notes", "hidden" flags, and custom fields will be lost on round-trip.
- Scheduled transactions are not supported -- they will be silently skipped on import.
- Business features (invoices, customers, vendors) are not supported.
- Lot tracking for investment cost basis is not imported.
- Exported files will NOT include slots, scheduled transactions, or business data even if they existed in the original import.

**New Dependencies:**
```
npm install fast-xml-parser fflate
```
- `fast-xml-parser` - XML parsing/building (fast, no native deps)
- `fflate` - gzip compression/decompression (browser + Node.js compatible)

**Files to Create:**

*Backend:*
- `src/lib/gnucash-xml/parser.ts` - Parse .gnucash XML into intermediate data structures
- `src/lib/gnucash-xml/builder.ts` - Build .gnucash XML from database records
- `src/lib/gnucash-xml/types.ts` - TypeScript types for GnuCash XML elements (accounts, transactions, splits, commodities, prices, budgets)
- `src/lib/gnucash-xml/importer.ts` - Import parsed data into PostgreSQL via Prisma (insert accounts, commodities, transactions, splits, prices, budgets, budget_amounts)
- `src/lib/gnucash-xml/exporter.ts` - Export from PostgreSQL to GnuCash XML format
- `src/app/api/import/route.ts` - POST endpoint: accepts multipart form upload of .gnucash file, parses and imports
- `src/app/api/export/route.ts` - GET endpoint: exports current book as .gnucash XML download

*Frontend:*
- `src/app/(main)/import-export/page.tsx` - Import/export page with:
  - File upload dropzone for .gnucash import
  - Import preview showing account count, transaction count before committing
  - Export button to download current book
  - Import progress indicator
- `src/components/ImportPreview.tsx` - Shows preview of what will be imported

**Files to Modify:**
- `src/components/Layout.tsx` - Add "Import/Export" nav item

**Database Considerations:**
- Import creates a NEW book entry in the `books` table
- Import creates all related records (commodities, accounts, transactions, splits, prices, budgets, budget_amounts)
- Import should be wrapped in a database transaction for atomicity
- Export queries all records associated with the book's root_account_guid

**Acceptance Criteria:**
- [ ] Can upload a `.gnucash` file (gzip-compressed XML, GnuCash 2.6+ format)
- [ ] Import preview shows: number of accounts, transactions, commodities, budgets
- [ ] User confirms before import begins
- [ ] Import creates all in-scope records in the database within a transaction
- [ ] Import creates a new book entry
- [ ] If import fails partway, all changes are rolled back
- [ ] Export downloads a valid `.gnucash` file
- [ ] Exported file can be opened by GnuCash desktop application (for in-scope entities)
- [ ] Import/Export page accessible from sidebar navigation
- [ ] Error messages for invalid/corrupted files
- [ ] Progress feedback during import
- [ ] Unsupported elements (slots, scheduled transactions, business features) are silently skipped with a summary warning shown to the user after import

**Risk: GnuCash XML schema is complex with many optional fields. Mitigation: Start with core entities (accounts, transactions, splits, commodities, prices, budgets), add others iteratively. Test with real GnuCash files.**

**Commit:** `feat(import-export): add GnuCash XML file import and export`

---

#### Task 8.2: Multiple Books Support (Item 12)
**Complexity: HIGH**

**Problem:** The application currently assumes a single book. The GnuCash `books` table supports multiple books, each with its own `root_account_guid`. The app needs to support switching between books.

**Database State:**
- `books` table exists in schema with `guid`, `root_account_guid`, `root_template_guid`
- All account queries currently ignore book boundaries (query all accounts)
- Need to scope all queries by the active book's root account

**Book-Scoping Utility Function:**

Create a shared utility to avoid scoping logic duplication across 20+ API routes:

```typescript
// src/lib/book-scope.ts

/**
 * Returns the active book's root_account_guid from the session.
 * Falls back to the first book if no active book is set.
 * Throws if no books exist at all.
 */
export async function getActiveBookRootGuid(): Promise<string> {
  const session = await getSession();
  if (session.activeBookGuid) {
    const book = await prisma.books.findUnique({
      where: { guid: session.activeBookGuid },
      select: { root_account_guid: true }
    });
    if (book) return book.root_account_guid;
  }
  // Fallback to first book
  const firstBook = await prisma.books.findFirst({
    select: { guid: true, root_account_guid: true }
  });
  if (!firstBook) throw new Error('NO_BOOKS');
  // Auto-set session
  session.activeBookGuid = firstBook.guid;
  await session.save();
  return firstBook.root_account_guid;
}

/**
 * Returns all account GUIDs under the active book's root.
 * Useful for scoping transaction queries.
 */
export async function getBookAccountGuids(): Promise<string[]> {
  const rootGuid = await getActiveBookRootGuid();
  // Query recursive account hierarchy under root
  const accounts = await prisma.$queryRaw<{guid: string}[]>`
    WITH RECURSIVE account_tree AS (
      SELECT guid FROM accounts WHERE guid = ${rootGuid}
      UNION ALL
      SELECT a.guid FROM accounts a
      JOIN account_tree t ON a.parent_guid = t.guid
    )
    SELECT guid FROM account_tree
  `;
  return accounts.map(a => a.guid);
}
```

**Example integration in an API route:**
```typescript
// src/app/api/accounts/route.ts (before)
const accounts = await prisma.accounts.findMany({ ... });

// src/app/api/accounts/route.ts (after)
import { getActiveBookRootGuid } from '@/lib/book-scope';
const rootGuid = await getActiveBookRootGuid();
const accounts = await prisma.accounts.findMany({
  where: { /* existing filters */ },
  // Add: only accounts in this book's tree
});
```

**Session Changes:**

**Files to Modify:**
- `src/lib/auth.ts` - Add `activeBookGuid?: string` to `SessionData` interface

**Files to Create:**
- `src/lib/book-scope.ts` - Book scoping utility (as described above)
- `src/contexts/BookContext.tsx` - Client-side context providing active book GUID, book list, and `switchBook()` function. This is a display cache only; the server-side session (iron-session) is the source of truth. Book switch calls the API then triggers `router.refresh()`.
- `src/app/api/books/route.ts` - GET: list all books; POST: create new book
- `src/app/api/books/[guid]/route.ts` - GET: book details; PUT: update book name; DELETE: delete book and all associated data
- `src/app/api/books/active/route.ts` - GET: get active book from session; PUT: set active book in session
- `src/components/BookSwitcher.tsx` - Dropdown in sidebar or top bar to switch between books

**Files to Modify (scope queries by book):**

All API routes that query accounts must filter by the active book's account hierarchy:
- `src/app/api/accounts/route.ts` - Filter by root_account_guid ancestry
- `src/app/api/accounts/[guid]/route.ts` - Verify account belongs to active book
- `src/app/api/accounts/[guid]/transactions/route.ts` - Same
- `src/app/api/accounts/[guid]/info/route.ts` - Same
- `src/app/api/accounts/[guid]/move/route.ts` - Same
- `src/app/api/accounts/[guid]/valuation/route.ts` - Same
- `src/app/api/accounts/balances/route.ts` - Same
- `src/app/api/transactions/route.ts` - Filter by accounts in active book
- `src/app/api/transactions/[guid]/route.ts` - Same
- `src/app/api/transactions/descriptions/route.ts` - Same
- `src/app/api/budgets/route.ts` - Budgets are per-book
- `src/app/api/investments/portfolio/route.ts` - Filter by active book
- `src/app/api/dashboard/*` - All dashboard endpoints scoped to active book
- `src/app/api/reports/*` - All report endpoints scoped to active book
- `src/app/api/import/route.ts` - Import creates a new book
- `src/app/api/export/route.ts` - Export exports active book

**Acceptance Criteria:**
- [ ] Book switcher visible in sidebar (dropdown or select)
- [ ] Switching books updates all data across the app
- [ ] Account hierarchy shows only accounts under active book's root
- [ ] Transactions, budgets, reports, investments all scoped to active book
- [ ] Active book persists in iron-session across page reloads
- [ ] Client-side BookContext is a display cache; `switchBook()` calls PUT `/api/books/active` then `router.refresh()`
- [ ] New book can be created from the book switcher
- [ ] Books can be renamed
- [ ] Books can be deleted (with confirmation)
- [ ] Deleting a book removes all associated data
- [ ] If only one book exists, switcher still shows but delete is disabled
- [ ] Import creates a new book and optionally switches to it

**Risk: This is the most invasive change -- it touches nearly every API endpoint. Mitigation: Implement book scoping via the shared `getActiveBookRootGuid()` / `getBookAccountGuids()` utility functions, add to endpoints incrementally, test each endpoint after modification.**

**Commit:** `feat(books): add multiple books support with book switching`

---

#### Task 8.3: Default Book Creation on First Load (Item 13)
**Complexity: LOW**

**Problem:** When a new user visits the app with an empty database (no GnuCash file imported), there should be a way to create a default book with a standard account hierarchy from the web interface.

**Dependencies:** Requires Task 8.2 (multiple books support) to be complete.

**Files to Create:**
- `src/lib/default-book.ts` - Function to create a default book with standard GnuCash account hierarchy:
  - Root Account
  - Assets (ASSET) -> Current Assets (ASSET) -> Checking Account (BANK), Savings Account (BANK), Cash (CASH)
  - Liabilities (LIABILITY) -> Credit Card (CREDIT)
  - Income (INCOME) -> Salary (INCOME), Other Income (INCOME)
  - Expenses (EXPENSE) -> Groceries, Utilities, Rent, Transportation, Entertainment, Healthcare, Insurance (all EXPENSE)
  - Equity (EQUITY) -> Opening Balances (EQUITY)
  - Also creates default USD commodity
- `src/app/api/books/default/route.ts` - POST: creates default book, returns book GUID

**Files to Modify:**
- `src/app/(main)/layout.tsx` or `src/app/(main)/page.tsx` - On first load, if no books exist, show "Welcome" screen with:
  - "Create Default Book" button
  - "Import GnuCash File" button
  - Brief description of each option
- `src/components/BookSwitcher.tsx` - Add "Create New Book" option that triggers default book creation

**Acceptance Criteria:**
- [ ] First-time users see a welcome screen when no books exist
- [ ] "Create Default Book" creates a book with standard account hierarchy
- [ ] Default book has Asset, Liability, Income, Expense, Equity top-level accounts
- [ ] Each top-level has sensible sub-accounts
- [ ] Default USD commodity is created if not present
- [ ] After creation, user is redirected to the new book's dashboard
- [ ] "Import GnuCash File" on welcome screen links to import page

**Commit:** `feat(books): add default book creation for first-time users`

---

### PHASE 9: Security Research (Item 14)
*Documentation only -- no implementation*

---

#### Task 9.1: Security Research Document (Item 14)
**Complexity: LOW**

**Problem:** Need to research and document a role-based access control (RBAC) system for per-book permissions with read-only, edit, and admin roles. This is RESEARCH ONLY -- no code implementation.

**Files to Create:**
- `docs/security-rbac-research.md` - Research document covering:

**Research Topics:**
1. **Role Definitions:**
   - Read-only: View accounts, transactions, reports, budgets. No modifications.
   - Edit: All read-only + create/edit transactions, manage budgets, reconcile
   - Admin: All edit + manage users, manage books, import/export, delete

2. **Database Schema Proposal:**
   - `gnucash_web_roles` table: id, name (readonly/edit/admin), description
   - `gnucash_web_book_permissions` table: id, user_id, book_guid, role_id
   - Default: first user gets admin on all books, invited users get readonly

3. **Implementation Approach:**
   - Middleware-based enforcement (Next.js middleware + API route checks)
   - Session-based role resolution (user + active book -> role)
   - UI-level: hide/disable buttons based on role
   - API-level: reject unauthorized mutations

4. **Invitation System:**
   - Admin can invite users to a book with a specific role
   - Invitation via link/code (no email required for self-hosted)

5. **Migration Path:**
   - Add tables without breaking existing users
   - Auto-assign admin role to existing users
   - Gradual enforcement rollout

6. **Security Considerations:**
   - CSRF protection
   - Rate limiting on auth endpoints
   - Session expiration policies
   - Audit logging (already partially implemented via `gnucash_web_audit`)

**Acceptance Criteria:**
- [ ] Research document created at `docs/security-rbac-research.md`
- [ ] Document covers all 6 research topics above
- [ ] Includes proposed database schema (CREATE TABLE statements)
- [ ] Includes proposed API changes (which endpoints need role checks)
- [ ] Includes UI mockup descriptions (what changes per role)
- [ ] NO code implementation -- documentation only
- [ ] References existing auth system (iron-session, bcrypt)

**Commit:** `docs(security): add RBAC research document for per-book user roles`

---

## Dependency Graph

```
Phase 1 (Quick Wins: Items 2, 10, 7)
  |
  v
Phase 2 (Theme + Sidebar: Items 6, 1)
  |
  v
Phase 3 (Charting: Item 4)
  |
  +--> Phase 4 (Dashboard: Item 3)
  |
  +--> Phase 5 (Graph Expand: Item 9) -- can start after Phase 3
       (wraps investment charts immediately;
        wraps dashboard charts when Phase 4 completes)

Phase 6 (Yahoo Finance: Item 5) -- independent, parallel with Phase 3-5

Phase 7 (Budgets: Item 8) -- independent, parallel with Phase 3-6

Phase 8 (Import/Export + Books: Items 11, 12, 13) -- depends on nothing but is highest risk
  |
  +-- Task 8.1 (Import/Export) --> Task 8.2 (Multiple Books) --> Task 8.3 (Default Book)

Phase 9 (Security Research: Item 14) -- independent, can run anytime
```

## Parallelization Opportunities

| Can Run In Parallel | Notes |
|---|---|
| Phase 1 tasks (1.1, 1.2, 1.3) | All independent, different files |
| Phase 2.1 (theme) + Phase 6 (Yahoo Finance) | Different file sets |
| Phase 2.1 (theme) + Phase 7 (budgets) | Minimal overlap (budget page touched by both) |
| Phase 3 (charting) + Phase 6 (Yahoo Finance) | Completely independent |
| Phase 3 (charting) + Phase 7 (budgets) | Completely independent |
| Phase 5 (graph expand) + Phase 7 (budgets) | Completely independent |
| Phase 5 (graph expand) can start after Phase 3 | Does NOT need Phase 4 -- investment charts exist already |
| Phase 9 (security research) + anything | Documentation only |

---

## Commit Strategy

| Phase | Commits |
|---|---|
| Phase 1 | 3 small commits (one per task) |
| Phase 2 | 2 commits (theme migration, sidebar) |
| Phase 3 | 1 commit (sankey chart component) |
| Phase 4 | 2 commits (APIs, frontend) |
| Phase 5 | 1 commit (expandable chart wrapper) |
| Phase 6 | 1 commit (Yahoo Finance switch) |
| Phase 7 | 1 commit (budget hierarchy) |
| Phase 8 | 3 commits (import/export, multiple books, default book) |
| Phase 9 | 1 commit (research doc) |
| **Total** | **15 commits** |

---

## Risk Register

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| Theme migration breaks existing dark mode appearance | HIGH | MEDIUM | Systematic file-by-file conversion, visual testing after each batch |
| yahoo-finance2 rate limiting or API changes | MEDIUM | LOW | Pin version, implement caching, add fallback to manual price entry |
| GnuCash XML parsing edge cases (slots, SX, business) | HIGH | HIGH | v1 scope limited to core entities; silently skip unsupported elements with user warning; test with real files |
| Multiple books query scoping misses an endpoint | HIGH | MEDIUM | Shared `getActiveBookRootGuid()` utility, grep for all account/transaction queries, test each endpoint |
| d3-sankey SSR issues in Next.js | MEDIUM | LOW | Dynamic import with `next/dynamic` and `ssr: false` (specified in Task 3.1) |
| Dashboard API performance with large datasets | MEDIUM | MEDIUM | Add date range limits, consider database views/indexes, implement caching |
| Sidebar collapse breaks existing layouts | LOW | LOW | CSS-only implementation, test all pages at mobile and desktop |

---

## New Dependencies Summary

| Package | Purpose | Phase |
|---|---|---|
| `d3-sankey` | Sankey diagram layout calculations | Phase 3 |
| `@types/d3-sankey` | TypeScript types for d3-sankey | Phase 3 |
| `yahoo-finance2` | Stock/crypto price fetching (replaces FMP) | Phase 6 |
| `fast-xml-parser` | GnuCash XML parsing and building | Phase 8 |
| `fflate` | Gzip compression/decompression for .gnucash files | Phase 8 |

---

## Success Criteria (Overall)

- [ ] All 14 items addressed (13 implemented, 1 documented)
- [ ] Application builds without TypeScript errors
- [ ] Light and dark themes work correctly on all pages
- [ ] Dashboard shows comprehensive financial overview
- [ ] Sidebar is responsive on mobile and collapsible on desktop
- [ ] Investment portfolio includes both STOCK and MUTUAL accounts
- [ ] Prices can be fetched without an API key (Yahoo Finance)
- [ ] GnuCash XML files can be imported and exported (core entities)
- [ ] Multiple books can be managed simultaneously
- [ ] Security research document provides actionable implementation plan
- [ ] No regressions in existing functionality
