# GnuCash Web Implementation Plan

This document outlines the roadmap for expanding gnucash-web from a read-only viewer to a full-featured financial web application, focusing on transaction journals, account hierarchy, budgeting, and reporting.

## Current State

The application currently provides:
- Read-only account hierarchy browsing with expandable tree
- Account ledger view with running balances and infinite scroll
- General ledger (all transactions) with search
- Multi-currency formatting
- PostgreSQL backend connection

## GnuCash Data Model Reference

### Core Tables (PostgreSQL)

| Table | Purpose |
|-------|---------|
| `accounts` | Account definitions (guid, name, account_type, commodity_guid, parent_guid, hidden, placeholder) |
| `transactions` | Transaction headers (guid, currency_guid, num, post_date, description) |
| `splits` | Transaction line items (guid, tx_guid, account_guid, value_num, value_denom, quantity_num, quantity_denom, reconcile_state) |
| `commodities` | Currencies and securities (guid, mnemonic, fullname, fraction) |
| `budgets` | Budget definitions (guid, name, description, num_periods) |
| `budget_amounts` | Budget allocations (budget_guid, account_guid, period_num, amount_num, amount_denom) |
| `prices` | Exchange rates and security prices (commodity_guid, currency_guid, date, value_num, value_denom) |

### Key Concepts

- **Double-Entry Bookkeeping**: Every transaction's splits must sum to zero
- **Value vs Quantity**: Value is in transaction currency; quantity is in account's commodity (differs for investments/multi-currency)
- **Fraction Storage**: Amounts stored as num/denom pairs (e.g., 1234/100 = 12.34)

---

## Phase 1: Enhanced Transaction Journal

### 1.1 Configurable Date Filtering

**Current Issue**: Period balance hardcoded to 2026-01-01

**Implementation**:
- Add date range picker component (start/end dates)
- Add period presets: This Month, This Quarter, This Year, Last Year, Custom
- Store selected period in URL query params and localStorage
- Update all API routes to accept `startDate` and `endDate` parameters

**Files to modify**:
- `src/app/api/accounts/route.ts` - Accept date params for period_balance
- `src/app/api/transactions/route.ts` - Filter by date range
- `src/app/api/accounts/[guid]/transactions/route.ts` - Filter by date range
- `src/components/AccountHierarchy.tsx` - Add date picker
- `src/components/TransactionJournal.tsx` - Add date picker
- New: `src/components/DateRangePicker.tsx`

### 1.2 Advanced Transaction Filtering

**Features**:
- Filter by account type (Asset, Liability, Income, Expense, etc.)
- Filter by amount range (min/max)
- Filter by reconciliation status (Cleared, Reconciled, Unreconciled)
- Filter by memo/description text
- Combine multiple filters

**API Changes**:
```
GET /api/transactions?
  startDate=2024-01-01&
  endDate=2024-12-31&
  accountTypes=ASSET,LIABILITY&
  minAmount=100&
  maxAmount=1000&
  reconcileState=c,y&
  search=payment
```

**New Components**:
- `src/components/TransactionFilters.tsx` - Collapsible filter panel
- `src/components/FilterChip.tsx` - Active filter display with remove button

### 1.3 Transaction Details Modal

**Features**:
- Click transaction row to open detail view
- Show all splits with account names and amounts
- Display transaction metadata (enter date, currency, number)
- Show memo for each split
- Link to related accounts

**New Components**:
- `src/components/TransactionModal.tsx`

### 1.4 Transaction Creation & Editing

**API Endpoints**:
```
POST   /api/transactions        - Create new transaction
PUT    /api/transactions/{guid} - Update transaction
DELETE /api/transactions/{guid} - Delete transaction (with splits)
```

**Transaction Form Features**:
- Date picker for post date
- Description field
- Transaction number (optional)
- Dynamic split rows (add/remove)
- Account selector dropdown with search
- Auto-balance: Calculate remaining amount for last split
- Validation: Ensure splits sum to zero before save
- Multi-currency support with exchange rate entry

**New Components**:
- `src/components/TransactionForm.tsx` - Main form
- `src/components/SplitRow.tsx` - Individual split entry
- `src/components/AccountSelector.tsx` - Searchable account dropdown

**Database Considerations**:
- Generate UUIDs for new transactions/splits
- Maintain referential integrity
- Handle commodity conversions

### 1.5 Reconciliation Workflow

**Features**:
- Reconciliation mode toggle per account ledger
- Mark transactions as Cleared (c) or Reconciled (y)
- Running reconciled balance display
- Statement balance entry and comparison
- Batch reconcile selected transactions

**API Endpoints**:
```
PATCH /api/splits/{guid}/reconcile - Update reconcile_state and reconcile_date
POST  /api/accounts/{guid}/reconcile - Batch reconcile multiple splits
```

**New Components**:
- `src/components/ReconcileToolbar.tsx`
- Modify `src/components/AccountLedger.tsx` - Add checkboxes, reconcile state display

---

## Phase 2: Enhanced Account Hierarchy

### 2.1 Account CRUD Operations

**API Endpoints**:
```
POST   /api/accounts        - Create account
PUT    /api/accounts/{guid} - Update account
DELETE /api/accounts/{guid} - Delete account (if no splits)
PATCH  /api/accounts/{guid}/move - Change parent account
```

**Account Form Fields**:
- Name (required)
- Account Type (dropdown: Asset, Liability, Income, Expense, Equity, etc.)
- Parent Account (searchable dropdown)
- Commodity/Currency (dropdown)
- Code (optional)
- Description (optional)
- Placeholder checkbox
- Hidden checkbox

**New Components**:
- `src/components/AccountForm.tsx`
- `src/components/AccountTypeSelector.tsx`

### 2.2 Account Hierarchy Reorganization

**Features**:
- Drag-and-drop to reorder/reparent accounts
- Visual drop targets showing valid parent options
- Prevent invalid moves (can't make account its own descendant)
- Undo/redo for reorganization

**Implementation**:
- Use `@dnd-kit/core` or similar for drag-drop
- Optimistic UI updates with rollback on error

### 2.3 Account Actions Menu

**Per-Account Actions**:
- View Ledger (existing)
- Edit Account
- Create Sub-Account
- Hide/Unhide Account
- Delete Account (only if no transactions)
- View in Reports

**New Components**:
- `src/components/AccountActionsMenu.tsx` - Dropdown menu per account row

### 2.4 Account Type Aggregations

**Features**:
- Summary cards at top of hierarchy page
- Total Assets, Total Liabilities, Net Worth
- Total Income, Total Expenses, Net Income (for period)
- Click card to filter tree to that type

**New Components**:
- `src/components/AccountSummaryCards.tsx`

---

## Phase 3: Budgeting System

### 3.1 Budget Data Model

**Tables Used**:
- `budgets` - Budget metadata
- `budget_amounts` - Per-account, per-period allocations
- `recurrences` - Period definitions (monthly, quarterly, yearly)

**TypeScript Types**:
```typescript
interface Budget {
  guid: string;
  name: string;
  description: string;
  num_periods: number;
  recurrence_mult: number;
  recurrence_period_type: string; // 'month', 'quarter', 'year'
  recurrence_period_start: string;
}

interface BudgetAmount {
  budget_guid: string;
  account_guid: string;
  period_num: number;
  amount_num: number;
  amount_denom: number;
}

interface BudgetRow {
  account: Account;
  periods: {
    budgeted: number;
    actual: number;
    variance: number;
  }[];
  total: {
    budgeted: number;
    actual: number;
    variance: number;
  };
}
```

### 3.2 Budget List & Management

**API Endpoints**:
```
GET    /api/budgets              - List all budgets
POST   /api/budgets              - Create budget
GET    /api/budgets/{guid}       - Get budget with amounts
PUT    /api/budgets/{guid}       - Update budget metadata
DELETE /api/budgets/{guid}       - Delete budget
```

**Pages**:
- `/budgets` - List of budgets with create button
- `/budgets/[guid]` - Budget detail/editor

**New Files**:
- `src/app/(main)/budgets/page.tsx`
- `src/app/(main)/budgets/[guid]/page.tsx`
- `src/app/api/budgets/route.ts`
- `src/app/api/budgets/[guid]/route.ts`
- `src/components/BudgetList.tsx`

### 3.3 Budget Editor

**Features**:
- Spreadsheet-style grid: accounts as rows, periods as columns
- Editable cells for budget amounts
- Show income accounts and expense accounts separately
- Hierarchical display matching account tree
- Auto-calculate parent totals from children
- Copy previous period values
- Distribute annual amount across periods

**New Components**:
- `src/components/BudgetEditor.tsx`
- `src/components/BudgetCell.tsx` - Editable amount cell
- `src/components/BudgetPeriodHeader.tsx`

**API Endpoints**:
```
PUT /api/budgets/{guid}/amounts - Batch update budget amounts
```

### 3.4 Budget vs Actual View

**Features**:
- Side-by-side: Budgeted | Actual | Variance | % of Budget
- Color coding: Green (under budget), Red (over budget)
- Drill-down: Click account to see contributing transactions
- Time-based: Show current period, YTD, or all periods
- Subtotals for account categories

**Actual Calculation**:
- Query splits for each account within budget period dates
- Sum values by account and period
- Handle parent account aggregation

**New Components**:
- `src/components/BudgetActualGrid.tsx`
- `src/components/VarianceCell.tsx`

### 3.5 Budget Reports

**Reports**:
- Budget Overview - Summary of all categories
- Budget vs Actual - Detailed variance analysis
- Budget Trend - Period-over-period progress

**New Components**:
- `src/components/reports/BudgetOverviewReport.tsx`
- `src/components/reports/BudgetVarianceReport.tsx`

---

## Phase 4: Reporting System

### 4.1 Report Framework

**Architecture**:
```
src/
├── app/(main)/reports/
│   ├── page.tsx                    # Report index
│   ├── [reportId]/page.tsx         # Report viewer
│   └── layout.tsx                  # Report-specific layout
├── lib/reports/
│   ├── types.ts                    # Report interfaces
│   ├── registry.ts                 # Report registration
│   ├── balance-sheet.ts            # Balance sheet logic
│   ├── income-statement.ts         # Income statement logic
│   ├── cash-flow.ts                # Cash flow logic
│   └── utils.ts                    # Shared calculations
└── components/reports/
    ├── ReportViewer.tsx            # Report display wrapper
    ├── ReportOptions.tsx           # Date/account selectors
    ├── ReportTable.tsx             # Tabular report display
    └── ReportChart.tsx             # Chart visualizations
```

**Report Interface**:
```typescript
interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  category: 'financial' | 'budget' | 'transaction' | 'asset';
  options: ReportOption[];
  generate: (options: ReportOptions) => Promise<ReportData>;
}

interface ReportOptions {
  startDate: string;
  endDate: string;
  accounts?: string[];        // Filter to specific accounts
  accountTypes?: string[];    // Filter to account types
  depth?: number;             // Max hierarchy depth
  showZeroBalances?: boolean;
  currency?: string;          // Reporting currency
}

interface ReportData {
  title: string;
  subtitle?: string;
  generatedAt: string;
  sections: ReportSection[];
  totals?: Record<string, number>;
}
```

### 4.2 Balance Sheet

**Structure**:
```
ASSETS
├── Current Assets
│   ├── Cash and Cash Equivalents
│   └── Accounts Receivable
├── Fixed Assets
│   └── Property & Equipment
└── Total Assets

LIABILITIES
├── Current Liabilities
│   └── Accounts Payable
├── Long-term Liabilities
│   └── Loans
└── Total Liabilities

EQUITY
├── Opening Balances
├── Retained Earnings
└── Total Equity

NET WORTH (Assets - Liabilities)
```

**Implementation**:
- Query all Asset, Liability, Equity accounts
- Calculate balances as of report date
- Group by account hierarchy
- Support comparison periods (current vs prior)

**API Endpoint**:
```
GET /api/reports/balance-sheet?asOfDate=2024-12-31&compareDate=2023-12-31
```

### 4.3 Income Statement (Profit & Loss)

**Structure**:
```
INCOME
├── Operating Income
│   └── Sales Revenue
├── Other Income
│   └── Interest Income
└── Total Income

EXPENSES
├── Operating Expenses
│   ├── Cost of Goods Sold
│   └── Salaries
├── Administrative Expenses
│   └── Office Supplies
└── Total Expenses

NET INCOME (Income - Expenses)
```

**Implementation**:
- Query Income and Expense accounts for date range
- Calculate net change in period
- Group by account hierarchy
- Support monthly/quarterly breakdown

**API Endpoint**:
```
GET /api/reports/income-statement?startDate=2024-01-01&endDate=2024-12-31
```

### 4.4 Cash Flow Statement

**Structure**:
```
OPERATING ACTIVITIES
├── Net Income
├── Adjustments for Non-Cash Items
└── Net Cash from Operating Activities

INVESTING ACTIVITIES
├── Purchase of Assets
├── Sale of Investments
└── Net Cash from Investing Activities

FINANCING ACTIVITIES
├── Loan Proceeds
├── Loan Payments
└── Net Cash from Financing Activities

NET CHANGE IN CASH
Beginning Cash Balance
Ending Cash Balance
```

**Implementation**:
- Calculate based on changes in account balances
- Categorize accounts into Operating/Investing/Financing
- Reconcile to actual cash account changes

### 4.5 Transaction Reports

**General Ledger Report**:
- All transactions in date range
- Sortable by date, account, amount
- Export to CSV

**Account Register Report**:
- Transactions for selected account(s)
- Running balance
- Reconciliation status

**Transaction Search Report**:
- Results of filtered transaction search
- Exportable

### 4.6 Chart Visualizations

**Charts to Implement**:
- Account balance pie chart (asset allocation)
- Income vs Expense bar chart (monthly)
- Net worth line chart (trend over time)
- Budget vs Actual bar chart
- Cash flow waterfall chart

**Library**: Use `recharts` or `chart.js` with React wrapper

**New Components**:
- `src/components/charts/PieChart.tsx`
- `src/components/charts/BarChart.tsx`
- `src/components/charts/LineChart.tsx`
- `src/components/charts/WaterfallChart.tsx`

### 4.7 Report Export

**Formats**:
- PDF (using `@react-pdf/renderer` or server-side generation)
- CSV (simple text generation)
- Excel (using `xlsx` library)

**API Endpoints**:
```
GET /api/reports/{reportId}/export?format=pdf&...options
GET /api/reports/{reportId}/export?format=csv&...options
```

---

## Phase 5: Supporting Features

### 5.1 Multi-Currency Support

**Features**:
- Price database queries for exchange rates
- Convert all amounts to reporting currency
- Display original currency alongside converted amount
- Support for manual exchange rate entry

**API**:
```
GET  /api/prices?commodity={guid}&currency={guid}&date={date}
POST /api/prices - Add price quote
```

### 5.2 User Authentication

**Implementation Options**:
- NextAuth.js with database adapter
- Simple password protection for single-user
- OAuth providers (Google, GitHub)

**Features**:
- Login/logout
- Session management
- Protected API routes
- User preferences storage

### 5.3 Data Validation & Integrity

**Features**:
- Unbalanced transaction detection
- Orphaned split detection
- Account balance verification
- Database constraint checking

**API**:
```
GET /api/integrity/check - Run all checks, return issues
POST /api/integrity/repair/{issueType} - Fix specific issue type
```

### 5.4 Audit Trail

**Implementation**:
- Log all write operations
- Store: timestamp, user, action, entity, old/new values
- View history for any transaction/account

**New Table**:
```sql
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  user_id VARCHAR(255),
  action VARCHAR(50),
  entity_type VARCHAR(50),
  entity_guid VARCHAR(32),
  old_values JSONB,
  new_values JSONB
);
```

---

## Database Considerations

### Required Views

The application already creates `account_hierarchy`. Additional views for performance:

```sql
-- Account balance summary (for quick balance lookups)
CREATE VIEW account_balances AS
SELECT
  a.guid,
  a.name,
  a.account_type,
  COALESCE(SUM(s.value_num::numeric / s.value_denom), 0) as balance
FROM accounts a
LEFT JOIN splits s ON s.account_guid = a.guid
LEFT JOIN transactions t ON t.guid = s.tx_guid
GROUP BY a.guid, a.name, a.account_type;

-- Monthly account summaries (for reports)
CREATE VIEW monthly_account_totals AS
SELECT
  a.guid as account_guid,
  DATE_TRUNC('month', t.post_date) as month,
  SUM(s.value_num::numeric / s.value_denom) as total
FROM splits s
JOIN transactions t ON t.guid = s.tx_guid
JOIN accounts a ON a.guid = s.account_guid
GROUP BY a.guid, DATE_TRUNC('month', t.post_date);
```

### Indexes for Performance

```sql
-- Speed up transaction queries
CREATE INDEX idx_transactions_post_date ON transactions(post_date);
CREATE INDEX idx_splits_account_guid ON splits(account_guid);
CREATE INDEX idx_splits_tx_guid ON splits(tx_guid);

-- Speed up account hierarchy queries
CREATE INDEX idx_accounts_parent_guid ON accounts(parent_guid);
CREATE INDEX idx_accounts_account_type ON accounts(account_type);

-- Speed up budget queries
CREATE INDEX idx_budget_amounts_budget_account ON budget_amounts(budget_guid, account_guid);
```

---

## UI/UX Improvements

### Navigation Updates

Add to sidebar:
- Budgets (new section)
- Reports (new section with submenu)

### Keyboard Shortcuts

- `Ctrl+N` - New transaction
- `Ctrl+S` - Save current form
- `Ctrl+F` - Focus search
- `Escape` - Close modal/cancel
- `Arrow keys` - Navigate ledger rows

### Responsive Design

- Mobile-optimized transaction entry
- Collapsible sidebar on mobile
- Touch-friendly buttons and controls
- Swipe gestures for common actions

---

## Technical Debt to Address

1. **Remove hardcoded date**: Replace `2026-01-01` with configurable period start
2. **Error handling**: Add consistent error boundaries and API error responses
3. **Loading states**: Add skeleton loaders for all data fetching
4. **Caching**: Implement React Query or SWR for data caching
5. **API validation**: Add Zod or similar for request/response validation
6. **Testing**: Set up Jest + React Testing Library

---

## Dependencies to Add

```json
{
  "dependencies": {
    "recharts": "^2.x",          // Charts
    "date-fns": "^3.x",          // Date manipulation
    "uuid": "^9.x",              // UUID generation
    "@tanstack/react-query": "^5.x",  // Data fetching/caching
    "zod": "^3.x",               // Validation
    "@dnd-kit/core": "^6.x",     // Drag and drop
    "xlsx": "^0.18.x",           // Excel export
    "@react-pdf/renderer": "^3.x" // PDF export
  },
  "devDependencies": {
    "jest": "^29.x",
    "@testing-library/react": "^14.x",
    "@testing-library/jest-dom": "^6.x"
  }
}
```

---

## Implementation Order

### Milestone 1: Foundation
1. Configurable date filtering (remove hardcoded date)
2. Advanced transaction filtering
3. Transaction details modal
4. Account summary cards

### Milestone 2: Core Editing
5. Transaction creation form
6. Transaction editing
7. Account CRUD operations
8. Reconciliation workflow

### Milestone 3: Reporting
9. Report framework setup
10. Balance Sheet report
11. Income Statement report
12. Chart visualizations

### Milestone 4: Budgeting
13. Budget list page
14. Budget editor
15. Budget vs Actual view
16. Budget reports

### Milestone 5: Polish
17. Cash Flow Statement
18. Export functionality (PDF, CSV, Excel)
19. Keyboard shortcuts
20. Mobile optimization
21. User authentication

---

## Success Metrics

- All GnuCash desktop report types available in web version
- Transaction entry as fast as desktop app
- Mobile-friendly budget tracking
- Real-time multi-user collaboration ready
- Sub-second page loads for all views
