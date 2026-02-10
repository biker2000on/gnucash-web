# GnuCash Standard Reports - Phased Implementation Plan (v3)

## Context

### Original Request
Add GnuCash standard reports to the gnucash-web application. Focus on the most useful core accounting reports, one investment report, and chart-based reports. Each report should have configurability saved to `gnucash_web_saved_reports` table.

### Existing Infrastructure
The codebase has a mature report system:

**Type System** (`src/lib/reports/types.ts`):
- `ReportType` enum (6 values), `ReportConfig` (type/name/description/icon/category)
- `ReportFilters` (date range, compareToPrevious, accountTypes, showZeroBalances, bookAccountGuids)
- `ReportData` with sections/grandTotal pattern — works for balance-based reports only
- `TreasurerReportData` — separate non-section-based shape (precedent for divergent data)
- `TransactionReportData` — extends ReportData via `Omit<ReportData, 'sections'>` + custom fields
- `SavedReport` / `SavedReportInput` for persistence
- `ReportConfig.category` currently: `'financial' | 'account' | 'transaction'`

**Generator Pattern** (e.g., `balance-sheet.ts`):
- Each report has a `generate*()` function taking `ReportFilters`, returning `ReportData`
- Common patterns: book-scoping, root GUID resolution, `toDecimal()`, `buildHierarchy()`
- **Code duplication**: `toDecimal()` copy-pasted in 5 files, `buildHierarchy()` in 4 files

**Components**:
- `ReportViewer` — header, CSV/Print buttons, filter panel, loading/error states
- `ReportTable` — hierarchical section-based table (expand/collapse, comparison columns)
- `ReportFilters` — date range inputs, presets, compare toggle
- `AccountPicker` — multi-select account chooser (used by Treasurer)

**CSV Export** (`csv-export.ts`):
- Only handles `ReportData` shape (sections with LineItems)
- Needs extension for: debit/credit columns, journal entries, chart data tables, portfolio columns

**Saved Reports DB** (`gnucash_web_saved_reports`):
- Columns: id, user_id, base_report_type (varchar 50), name, description, config (JSON), filters (JSON), is_starred
- `VALID_REPORT_TYPES` set in `saved-reports.ts` must be updated per new report

**Key Constraints**:
- Raw SQL `ALTER TABLE` for schema migrations (not `prisma db push`)
- GnuCash stores income/liability/equity as negative; must negate for display
- Multi-currency: `findExchangeRate()` in `src/lib/currency.ts` — **out of scope** for this plan (all reports use book's default currency; cross-currency display is a future enhancement)
- Book scoping via `getBookAccountGuids()` / `getActiveBookRootGuid()`

---

## Changes from v1/v2 (Addressing Architect + Critic Feedback)

**v2 changes (from v1):**
1. Dropped Advanced Portfolio — deferred to future work
2. Dropped options framework — extend ReportFilters per-report instead
3. Decoupled chart reports from options framework
4. Added discriminated union approach via `ReportDataBase`
5. CSV export updated per-phase
6. Added `transaction-report.ts` to Phase 0 refactor
7. Added sign convention rules per report
8. Added `'investment' | 'chart'` to `ReportConfig.category`
9. Added custom table components to file lists
10. Multi-currency explicitly out of scope
11. Reduced chart reports to 2
12. Shared query helpers have defined signatures

**v3 changes (from v2, addressing Architect blocking + Critic critical issues):**
13. **Clarified toDecimal consolidation** — reports version (null-safe, returns number) is distinct from gnucash.ts version (returns string); they coexist
14. **Specified CSV export wiring for custom data shapes** — follow Treasurer pattern: page handles export directly, omit `reportData` from ReportViewer
15. **Specified chart report data extraction strategy** — internal `fetch()` proxy to existing dashboard APIs
16. **Added category assignments** for each new report (`'financial'`, `'account'`, `'transaction'`)
17. **Fixed category counts** in Phase 4 (6 financial, 3 account, 2 transaction, 1 investment, 2 chart)
18. **Clarified getAccountBalances scope** — returns raw balances without investment price conversion
19. **Added RECEIVABLE/PAYABLE** to Trial Balance account types
20. **Added Reconciliation page integration details** — follows Treasurer pattern for AccountPicker

---

## Cross-Cutting Decisions

### CSV Export for Custom Data Shapes
Reports using custom data shapes (TrialBalance, GeneralJournal, GeneralLedger, InvestmentPortfolio, ChartReport) **cannot** pass data through ReportViewer's `reportData?: ReportData` prop, as it only accepts section-based `ReportData`.

**Decision**: Follow the Treasurer page pattern. Each page with a custom data shape:
1. Omits `reportData` prop from ReportViewer (hides the built-in CSV button)
2. Adds its own CSV export button in the page header or alongside ReportViewer
3. Calls `downloadCSV(generateXxxCSV(data), filename)` directly

Reports that use standard `ReportData` (Equity Statement, Reconciliation) continue using ReportViewer's built-in CSV button as-is.

### Chart Report Data Extraction Strategy
The dashboard API routes (`net-worth/route.ts` ~460 lines, `income-expense/route.ts` ~216 lines) contain complex calculation logic inline with no extractable functions.

**Decision**: Use internal `fetch()` proxy pattern. The chart report API routes will call the existing dashboard API endpoints internally:
```typescript
// In src/app/api/reports/net-worth-chart/route.ts
const dashboardUrl = new URL('/api/dashboard/net-worth', request.nextUrl.origin);
dashboardUrl.searchParams.set('startDate', filters.startDate);
dashboardUrl.searchParams.set('endDate', filters.endDate);
const response = await fetch(dashboardUrl, { headers: request.headers });
const dashboardData = await response.json();
// Transform dashboardData into ChartReportData shape
```

This avoids: (a) refactoring dashboard APIs (risk of breaking dashboard), (b) duplicating 600+ lines of complex code. The tradeoff is one internal HTTP call per report generation, which is acceptable for a report use case.

### toDecimal Consolidation
There are two distinct `toDecimal` functions in the codebase:
1. **`src/lib/gnucash.ts` / `src/lib/prisma.ts`**: Takes `bigint | number | string`, returns **string** (`"1.50"`)
2. **Report generators** (5 files): Takes `bigint | null`, returns **number** (`1.5`), handles null safely

These are **different functions serving different contexts**. The consolidation in Phase 0:
- Moves the reports version (null-safe, returns number) to `src/lib/reports/utils.ts`
- Does NOT modify `gnucash.ts` or `prisma.ts`
- The two functions coexist in different module scopes with no naming collision

### getAccountBalances Utility Scope
The shared `getAccountBalances()` returns **raw balances** (sum of `quantity_num/quantity_denom`) without investment price conversion. Generators that need market value for STOCK/MUTUAL accounts (e.g., Balance Sheet, Investment Portfolio) handle price conversion in the caller after receiving raw balances from the utility.

---

## Sign Convention Rules

| Report | Rule |
|--------|------|
| Balance Sheet | Assets positive, Liabilities/Equity negated (already implemented) |
| Income Statement | Income negated, Expenses positive (already implemented) |
| Cash Flow | Follows income statement convention (already implemented) |
| **Equity Statement** | Equity negated (positive = increase); Net Income = negated income - expenses |
| **Trial Balance** | Debit-normal accounts (Asset, Expense) → debit column; Credit-normal (Liability, Equity, Income) → credit column. Both columns positive. |
| **General Journal** | Per-split: positive value → Debit, negative value → Credit (both displayed as positive) |
| **General Ledger** | Same as General Journal for individual entries; running balance follows account's natural sign |
| **Reconciliation** | Same sign as parent account type |
| **Investment Portfolio** | Shares positive, Market Value positive, Gain = Market - Cost (can be negative) |
| **Chart Reports** | Follow dashboard conventions (income negated for display) |

---

## Work Objectives

### Core Objective
Implement 8 new reports with refactored shared utilities, consistent patterns, and per-report CSV export.

### Deliverables
1. **Refactored shared report utilities** — eliminate duplication across 5 generators
2. **5 Tier 1 core accounting reports** — Equity Statement, Trial Balance, General Journal, General Ledger, Reconciliation
3. **1 Investment Portfolio report** — holdings with market value and gain/loss
4. **2 Chart-based reports** — Net Worth, Income/Expense
5. **Updated reports index** — new categories, icons, navigation for all 14 reports

### Definition of Done
- All 8 new reports render correctly with "Last Year" (2025) date filter
- Each report supports: date filtering, CSV export, print, save-to-DB
- `npm run build` passes with zero TypeScript errors
- Existing 6 reports continue to work unchanged
- Playwright verification for each phase

---

## Guardrails

### Must Have
- Follow existing generator/API/page pattern
- Use Prisma ORM for queries (raw SQL only for schema migrations)
- Negate income/liability/equity amounts per sign convention table above
- Book scoping via `bookAccountGuids` in all generators
- Update `VALID_REPORT_TYPES` when adding each new report type
- Extend `csv-export.ts` in the same phase that introduces a new data shape
- Each phase leaves app buildable and deployable

### Must NOT Have
- No Tier 4+ reports (budget, multicolumn, business) in this plan
- No Advanced Portfolio (deferred)
- No generic options framework (extend ReportFilters per-report instead)
- No changes to existing dashboard page or its charts
- No multi-currency conversion (use book's default currency)
- No new npm dependencies (Recharts already available)
- No authentication changes

---

## Task Flow and Dependencies

```
Phase 0: Refactor Shared Utilities + Type System
    |
    ├──> Phase 1: Tier 1 Core Accounting Reports (5 reports)
    |         (each report extends csv-export as needed)
    |
    ├──> Phase 2: Investment Portfolio Report (1 report)
    |         (independent of Phase 1)
    |
    └──> Phase 3: Chart-Based Reports (2 reports)
              (independent of Phase 1 and Phase 2)

Phase 4: Reports Index Polish (after Phases 1-3)
```

**Phases 1, 2, and 3 are independent and can run in parallel after Phase 0.**
Phase 4 depends on all preceding phases.

---

## Phase 0: Refactor Shared Report Utilities

**Goal**: Extract duplicated code, update type system, prepare for new report shapes.

### Task 0.1: Extract shared utility functions
**Files to modify**:
- `src/lib/reports/utils.ts` (extend)
- `src/lib/reports/balance-sheet.ts` (remove local defs, import from utils)
- `src/lib/reports/income-statement.ts` (same)
- `src/lib/reports/cash-flow.ts` (same)
- `src/lib/reports/account-summary.ts` (same)
- `src/lib/reports/transaction-report.ts` (same — also has local `toDecimal`)

**Work**:
1. Move `toDecimal()` to `utils.ts`:
   ```typescript
   export function toDecimal(num: bigint | null, denom: bigint | null): number {
     if (num === null || denom === null || denom === 0n) return 0;
     return Number(num) / Number(denom);
   }
   ```
   Note: `src/lib/prisma.ts` also exports a `toDecimal` but it returns a **string** (re-exports from `gnucash.ts`). The reports version returns **number** and handles null. These are distinct functions — see Cross-Cutting Decisions above.

2. Move `buildHierarchy()` to `utils.ts` with generalized input type:
   ```typescript
   export interface AccountWithBalance {
     guid: string;
     name: string;
     account_type: string;
     parent_guid: string | null;
     balance: number;
     previousBalance?: number;
   }
   export function buildHierarchy(accounts: AccountWithBalance[], parentGuid: string | null = null, depth = 0): LineItem[]
   ```

3. Extract `resolveRootGuid()` to utils:
   ```typescript
   export async function resolveRootGuid(bookAccountGuids?: string[]): Promise<string | null>
   ```
   Currently duplicated in balance-sheet.ts, income-statement.ts, cash-flow.ts (identical 12-line pattern).

4. Extract `getAccountBalances()` to utils — shared query helper:
   ```typescript
   export async function getAccountBalances(opts: {
     accountGuids?: string[];
     accountTypes: string[];
     endDate: Date;
     startDate?: Date; // If provided, only splits in range; otherwise all splits up to endDate
     includeHidden?: boolean;
   }): Promise<AccountWithBalance[]>
   ```
   This consolidates the per-account split aggregation pattern used in all 4 balance-based generators.

5. Update all 5 generator files to import from utils.

**Acceptance Criteria**:
- `npm run build` passes
- All 6 existing reports render identically
- Zero duplicate `toDecimal` or `buildHierarchy` in generator files
- `utils.ts` exports: `toDecimal`, `buildHierarchy`, `resolveRootGuid`, `buildAccountPathMap`, `getAccountBalances`, `AccountWithBalance`

### Task 0.2: Update type system for new report categories
**Files to modify**:
- `src/lib/reports/types.ts`

**Work**:
1. Extend `ReportConfig.category`:
   ```typescript
   category: 'financial' | 'account' | 'transaction' | 'investment' | 'chart';
   ```

2. The existing pattern already supports divergent data shapes via TypeScript:
   - `ReportData` — section-based (Balance Sheet, Income Statement, etc.)
   - `TransactionReportData` — extends via `Omit` + custom fields
   - `TreasurerReportData` — entirely separate interface

   New reports will follow this established pattern: each new report type that doesn't fit `ReportData` gets its own interface (e.g., `TrialBalanceData`, `GeneralJournalData`, `GeneralLedgerData`, `InvestmentPortfolioData`, `ChartReportData`). Each extends a minimal base:
   ```typescript
   export interface ReportDataBase {
     type: ReportType;
     title: string;
     generatedAt: string;
     filters: ReportFilters;
   }
   ```
   Existing `ReportData` continues unchanged for backward compatibility. New reports use `ReportDataBase` as their base when they don't fit the sections pattern.

**Acceptance Criteria**:
- `ReportDataBase` interface exported
- `ReportConfig.category` includes 'investment' and 'chart'
- All existing code compiles without changes

---

## Phase 1: Tier 1 Core Accounting Reports

**Goal**: Add 5 core accounting reports. Each report gets: generator, API route, page, CSV export support.

### Task 1.1: Equity Statement
**New files**:
- `src/lib/reports/equity-statement.ts`
- `src/app/api/reports/equity-statement/route.ts`
- `src/app/(main)/reports/equity_statement/page.tsx`

**Modify**:
- `src/lib/reports/types.ts` (add `EQUITY_STATEMENT` to enum + REPORTS array)
- `src/lib/reports/saved-reports.ts` (add to VALID_REPORT_TYPES)

**Category**: `'financial'`

**Work**:
Uses standard `ReportData` sections pattern. Sections:
1. **Opening Equity** — equity account balances before startDate
2. **Net Income** — (negated income total) - expense total during period
3. **Other Equity Changes** — direct equity account transactions during period
4. **Closing Equity** — equity account balances at endDate

Sign convention: Equity amounts negated for display (positive = increase in equity).
Formula: Closing Equity = Opening Equity + Net Income + Other Changes

**Acceptance Criteria**:
- Closing Equity = Opening + Net Income + Other Changes (validates accounting equation)
- Shows in reports index under "Financial Statements" category
- CSV/print/save work

### Task 1.2: Trial Balance
**New files**:
- `src/lib/reports/trial-balance.ts`
- `src/app/api/reports/trial-balance/route.ts`
- `src/app/(main)/reports/trial_balance/page.tsx`
- `src/components/reports/TrialBalanceTable.tsx` (custom table with Debit/Credit columns)

**Modify**:
- `src/lib/reports/types.ts` (add `TRIAL_BALANCE` to enum + REPORTS array + `TrialBalanceData` interface)
- `src/lib/reports/saved-reports.ts`
- `src/lib/reports/csv-export.ts` (add `generateTrialBalanceCSV()`)

**Data Shape** (new interface, extends `ReportDataBase`):
```typescript
export interface TrialBalanceEntry {
  guid: string;
  accountPath: string;
  accountType: string;
  debit: number;  // Always >= 0
  credit: number; // Always >= 0
}
export interface TrialBalanceData extends ReportDataBase {
  entries: TrialBalanceEntry[];
  totalDebits: number;
  totalCredits: number;
}
```

**Category**: `'financial'`

**Sign convention**:
- Debit-normal accounts (ASSET, BANK, CASH, STOCK, MUTUAL, EXPENSE, RECEIVABLE): positive balance → debit column
- Credit-normal accounts (LIABILITY, CREDIT, EQUITY, INCOME, PAYABLE): positive abs(balance) → credit column
- If balance is opposite to normal sign, put in the other column
- Query ALL non-ROOT account types (including RECEIVABLE, PAYABLE, TRADING)

**Custom table component** `TrialBalanceTable.tsx`: 4 columns (Account, Account Type, Debit, Credit). Footer: Total Debits / Total Credits. Highlight if imbalanced.

**Acceptance Criteria**:
- Total Debits = Total Credits (or imbalance clearly shown)
- Every non-zero-balance account appears
- CSV export has Debit/Credit columns
- Custom table (not ReportTable)

### Task 1.3: General Journal
**New files**:
- `src/lib/reports/general-journal.ts`
- `src/app/api/reports/general-journal/route.ts`
- `src/app/(main)/reports/general_journal/page.tsx`
- `src/components/reports/JournalTable.tsx` (custom table grouping splits by transaction)

**Modify**:
- `src/lib/reports/types.ts` (add `GENERAL_JOURNAL` + `GeneralJournalData`)
- `src/lib/reports/saved-reports.ts`
- `src/lib/reports/csv-export.ts` (add `generateJournalCSV()`)

**Data Shape**:
```typescript
export interface JournalSplit {
  accountPath: string;
  debit: number;
  credit: number;
  memo: string;
}
export interface JournalEntry {
  transactionGuid: string;
  date: string;
  description: string;
  num: string;
  splits: JournalSplit[];
}
export interface GeneralJournalData extends ReportDataBase {
  entries: JournalEntry[];
  totalDebits: number;
  totalCredits: number;
  entryCount: number;
}
```

**Category**: `'transaction'`

**Sign convention**: Per split: `value_num > 0` → Debit, `value_num < 0` → Credit (displayed as positive).

**Custom table component** `JournalTable.tsx`: Transaction header row (date, description, num) + indented split rows (account, debit, credit, memo). Alternating transaction group backgrounds.

**Acceptance Criteria**:
- All transactions in date range shown chronologically
- Each transaction shows ALL its splits grouped
- Debit/Credit columns (not signed amounts)
- Full account paths (e.g., "Assets:Current:Checking")
- CSV with Date, Description, Account, Debit, Credit, Memo columns

### Task 1.4: General Ledger
**New files**:
- `src/lib/reports/general-ledger.ts`
- `src/app/api/reports/general-ledger/route.ts`
- `src/app/(main)/reports/general_ledger/page.tsx`
- `src/components/reports/LedgerTable.tsx` (custom table with per-account sections + running balance)

**Modify**:
- `src/lib/reports/types.ts` (add `GENERAL_LEDGER` + `GeneralLedgerData`)
- `src/lib/reports/saved-reports.ts`
- `src/lib/reports/csv-export.ts` (add `generateLedgerCSV()`)

**Data Shape**:
```typescript
export interface LedgerEntry {
  date: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
  memo: string;
}
export interface LedgerAccount {
  guid: string;
  accountPath: string;
  accountType: string;
  openingBalance: number;
  entries: LedgerEntry[];
  closingBalance: number;
}
export interface GeneralLedgerData extends ReportDataBase {
  accounts: LedgerAccount[];
  totalDebits: number;
  totalCredits: number;
}
```

**Category**: `'account'`

**Custom table component** `LedgerTable.tsx`: One collapsible section per account. Header shows account path + opening balance. Transaction rows: Date, Description, Debit, Credit, Running Balance. Footer: closing balance.

**Acceptance Criteria**:
- One section per account with opening/closing balance
- Running balance column
- Can filter to specific account types via `filters.accountTypes`
- CSV includes all accounts + transactions

### Task 1.5: Reconciliation Report
**New files**:
- `src/lib/reports/reconciliation.ts`
- `src/app/api/reports/reconciliation/route.ts`
- `src/app/(main)/reports/reconciliation/page.tsx`

**Modify**:
- `src/lib/reports/types.ts` (add `RECONCILIATION`)
- `src/lib/reports/saved-reports.ts`

**Work**:
Uses `ReportData` sections pattern (fits naturally). Sections:
1. **Reconciled Balance** — sum of splits with `reconcile_state = 'y'`
2. **Cleared Transactions** — splits with `reconcile_state = 'c'` (date, description, amount)
3. **Uncleared Transactions** — splits with `reconcile_state = 'n'`
4. **Register Balance** — sum of ALL splits

**Category**: `'account'`

Requires account selection via AccountPicker pattern (stored in config JSON like Treasurer). The page component follows the Treasurer page pattern for AccountPicker integration: `selectedAccountGuids` state, passing guids as query params to API, and `SaveReportDialog` integration with config containing `accountGuids`.

**Acceptance Criteria**:
- Shows split reconcile states correctly
- Reconciled + Cleared + Uncleared = Register Balance
- Account selection via AccountPicker
- Existing CSV export works (uses standard ReportData)

---

## Phase 2: Investment Portfolio Report

**Goal**: Add investment portfolio report with holdings, market value, and gain/loss.

### Task 2.1: Investment Portfolio
**New files**:
- `src/lib/reports/investment-portfolio.ts`
- `src/app/api/reports/investment-portfolio/route.ts`
- `src/app/(main)/reports/investment_portfolio/page.tsx`
- `src/components/reports/PortfolioTable.tsx` (custom table with investment-specific columns)

**Modify**:
- `src/lib/reports/types.ts` (add `INVESTMENT_PORTFOLIO` + `InvestmentPortfolioData`)
- `src/lib/reports/saved-reports.ts`
- `src/lib/reports/csv-export.ts` (add `generatePortfolioCSV()`)

**Data Shape**:
```typescript
export interface PortfolioHolding {
  guid: string;
  accountName: string;
  symbol: string;
  shares: number;
  latestPrice: number;
  priceDate: string;
  marketValue: number;
  costBasis: number;
  gain: number;
  gainPercent: number;
}
export interface InvestmentPortfolioData extends ReportDataBase {
  holdings: PortfolioHolding[];
  totals: {
    marketValue: number;
    costBasis: number;
    gain: number;
    gainPercent: number;
  };
  showZeroShares: boolean;
}
```

**Work**:
For each STOCK/MUTUAL account:
- **Shares**: sum of `quantity_num/quantity_denom` for splits up to endDate
- **Latest Price**: from prices table via `getLatestPrice(commodity_guid, undefined, endDate)`
- **Market Value**: shares × price
- **Cost Basis**: sum of `value_num/value_denom` for all splits (cash amount paid/received)
- **Gain/Loss**: market value - cost basis
- **Gain %**: (gain / |cost basis|) × 100

Uses existing `getLatestPrice()` from `src/lib/commodities.ts`.
Option to show/hide zero-share accounts (stored in config JSON).

**Custom table component** `PortfolioTable.tsx`: Columns: Account, Symbol, Shares, Price, Price Date, Market Value, Cost Basis, Gain/Loss, Gain %. Footer: totals. Color-code gains green, losses red.

**Acceptance Criteria**:
- All STOCK/MUTUAL accounts listed
- Market value from latest price ≤ endDate
- Cost basis from split values (not shares × average price)
- Gain/loss + percentage correct
- Zero-share accounts toggleable
- CSV with all columns

---

## Phase 3: Chart-Based Reports

**Goal**: Wrap existing dashboard chart data as saveable, printable report pages. 2 reports: Net Worth, Income/Expense.

**Scope**: These reports reuse the data-fetching logic from existing dashboard API endpoints. They do NOT modify the dashboard page or its components. Each chart report has its own page with ReportViewer wrapper, date filtering, and chart rendering via Recharts.

### Task 3.1: Net Worth Chart Report
**New files**:
- `src/app/api/reports/net-worth-chart/route.ts` (proxies/adapts dashboard net-worth API logic)
- `src/app/(main)/reports/net_worth_chart/page.tsx`

**Modify**:
- `src/lib/reports/types.ts` (add `NET_WORTH_CHART` + `ChartReportData`)
- `src/lib/reports/saved-reports.ts`
- `src/lib/reports/csv-export.ts` (add `generateChartCSV()` — date/value table)

**Data Shape**:
```typescript
export interface ChartDataPoint {
  date: string;
  [key: string]: string | number; // series values
}
export interface ChartReportData extends ReportDataBase {
  dataPoints: ChartDataPoint[];
  series: string[]; // e.g., ['assets', 'liabilities', 'netWorth']
}
```

**Work**:
- API route extracts the net-worth calculation logic from dashboard API (import shared functions or duplicate minimally)
- Page renders: ReportViewer wrapper with filters + Recharts LineChart with assets/liabilities/netWorth series
- Date range from filters; monthly data points
- CSV export: Date, Assets, Liabilities, Net Worth columns

**Acceptance Criteria**:
- Full-page chart with ReportViewer wrapper
- Date range filtering works
- CSV exports date/value table
- Save-to-DB works
- Print captures chart as visible on screen

### Task 3.2: Income/Expense Chart Report
**New files**:
- `src/app/api/reports/income-expense-chart/route.ts`
- `src/app/(main)/reports/income_expense_chart/page.tsx`

**Modify**:
- `src/lib/reports/types.ts` (add `INCOME_EXPENSE_CHART`)
- `src/lib/reports/saved-reports.ts`

**Work**:
Same pattern as Net Worth chart but uses income-expense dashboard data.
- Bar chart: income (green) and expense (red) by month
- Reuses `ChartReportData` shape with series: ['income', 'expense']
- CSV: Date, Income, Expense columns

**Acceptance Criteria**:
- Monthly bar chart with income/expense
- Date range filtering
- CSV exports monthly table
- Save/print work

---

## Phase 4: Reports Index Polish

**Goal**: Update reports landing page for all 14 reports.

### Task 4.1: Update reports index page
**Modify**:
- `src/app/(main)/reports/page.tsx`

**Work**:
1. Add category labels: `'investment': 'Investment Reports'`, `'chart': 'Chart Reports'`
2. Update `CATEGORY_ORDER` to: `['financial', 'account', 'transaction', 'investment', 'chart']`
3. Add icons for new report types in `ReportIcon` component or icon mapping
4. Verify all 14 reports appear correctly grouped

**Acceptance Criteria**:
- All 14 reports visible and correctly categorized
- Categories: Financial Statements (6: Balance Sheet, Income Statement, Cash Flow, Treasurer, Equity Statement, Trial Balance), Account Reports (3: Account Summary, General Ledger, Reconciliation), Transaction Reports (2: Transaction Report, General Journal), Investment Reports (1: Investment Portfolio), Chart Reports (2: Net Worth, Income/Expense)
- Each report link navigates correctly
- Icons distinguishable per report

---

## Commit Strategy

| Phase | Commits |
|-------|---------|
| Phase 0 | 1: "refactor: extract shared report utilities and update type system" |
| Phase 1 | 5: one per report ("feat(reports): add Equity Statement report", etc.) |
| Phase 2 | 1: "feat(reports): add Investment Portfolio report" |
| Phase 3 | 2: one per chart report |
| Phase 4 | 1: "feat(reports): update index page with new categories and icons" |

All commits on current branch (`feature/phase1-date-filtering`).

---

## Success Criteria

1. **Functional**: All 8 new reports generate correct data with "Last Year" (2025) filter
2. **Consistent**: All reports follow generator/API/page pattern
3. **Saveable**: All reports support save/load/star/delete via existing infrastructure
4. **Exportable**: All reports support CSV export and print
5. **Buildable**: `npm run build` passes after each phase
6. **Non-breaking**: Existing 6 reports work identically
7. **DRY**: No duplicated `toDecimal()` or `buildHierarchy()` after Phase 0
8. **Verified**: Playwright validation for "Last Year" (2025) per the prompt

---

## Estimated Effort

| Phase | Tasks | Complexity | Notes |
|-------|-------|-----------|-------|
| Phase 0 | 2 | LOW | Mechanical refactor + type additions |
| Phase 1 | 5 | MEDIUM-HIGH | Trial Balance, General Journal, General Ledger need custom tables |
| Phase 2 | 1 | MEDIUM | Portfolio calculations, custom table |
| Phase 3 | 2 | MEDIUM | Chart extraction + Recharts rendering in report context |
| Phase 4 | 1 | LOW | Index page updates |

---

## Out of Scope (Future Work)

- Advanced Portfolio (realized gains, dividends, return %)
- Budget reports
- Business reports (invoice, AP aging, AR aging)
- Multi-column reports
- Generic report options framework (current ReportFilters + config JSON is sufficient)
- Multi-currency conversion in reports
- Tax reports
