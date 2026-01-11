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

### 5.1 Investment Account Support (Commodity Valuation)

**Problem**: Investment accounts hold non-cash commodities (stocks, mutual funds, etc.) where the quantity is in shares/units but needs to be displayed in the reporting currency (e.g., USD) using current market prices.

**GnuCash Data Model**:
- **Accounts**: `commodity_guid` references the commodity held (e.g., AAPL stock)
- **Splits**: `quantity_num/quantity_denom` = shares held, `value_num/value_denom` = transaction currency value
- **Commodities**: `namespace` distinguishes types (CURRENCY, STOCK, FUND, etc.)
- **Prices**: Historical price quotes with `commodity_guid`, `currency_guid`, `date`, `value_num/value_denom`

**How GnuCash Desktop Handles This** (from gnc-pricedb.h):
1. For each account, check if its commodity differs from the reporting currency
2. If different, look up the conversion price using:
   - `gnc_pricedb_lookup_latest()` - Most recent available price
   - `gnc_pricedb_lookup_nearest_in_time64()` - Price nearest to a specific date
   - `gnc_pricedb_convert_balance_latest_price()` - Direct balance conversion
3. Multiply quantity by price to get value in reporting currency
4. For multi-currency chains (e.g., EUR stock → EUR → USD), traverse price lookups

**Implementation for GnuCash Web**:

#### 5.1.1 Price API Endpoints

```
GET  /api/prices                                    - List all prices (paginated)
GET  /api/prices/latest?commodity={guid}            - Latest price for commodity
GET  /api/prices/nearest?commodity={guid}&date={date} - Price nearest to date
GET  /api/prices?commodity={guid}&currency={guid}&date={date} - Specific lookup
POST /api/prices                                    - Add new price quote
```

**New Files**:
- `src/app/api/prices/route.ts` - Price listing and creation
- `src/app/api/prices/latest/route.ts` - Latest price lookup
- `src/app/api/prices/nearest/route.ts` - Time-based price lookup
- `src/lib/prices.ts` - Price lookup utility functions

**Price Lookup Utility** (`src/lib/prices.ts`):
```typescript
interface PriceLookup {
  commodity_guid: string;
  currency_guid: string;
  date: Date;
  value: number;  // Price as decimal
  source: string;
}

// Get latest price, optionally traversing currency chains
async function getLatestPrice(
  commodityGuid: string,
  targetCurrencyGuid: string
): Promise<number | null>;

// Get price nearest to a specific date
async function getNearestPrice(
  commodityGuid: string,
  targetCurrencyGuid: string,
  asOfDate: Date
): Promise<number | null>;

// Convert a quantity to target currency using latest prices
async function convertToReportingCurrency(
  quantity: number,
  commodityGuid: string,
  reportingCurrencyGuid: string
): Promise<number | null>;
```

#### 5.1.2 Account Balance Conversion

**Modify `/api/accounts` route**:
1. Add optional `reportingCurrency` query parameter (defaults to USD)
2. For each account where `commodity_guid` != reporting currency:
   - Look up latest price from `prices` table
   - Calculate `converted_balance = quantity * price`
3. Return both `native_balance` (in account's commodity) and `converted_balance` (in reporting currency)

**Updated Account Response**:
```typescript
interface Account {
  // ... existing fields
  commodity_guid: string;
  commodity_mnemonic: string;      // e.g., "AAPL", "USD", "EUR"
  commodity_namespace: string;      // e.g., "STOCK", "CURRENCY"
  native_balance: string;           // Balance in account's commodity
  converted_balance: string;        // Balance in reporting currency
  conversion_price?: string;        // Price used for conversion (if applicable)
  conversion_date?: string;         // Date of price quote used
}
```

**SQL Query Pattern**:
```sql
WITH account_balances AS (
  SELECT
    a.guid,
    a.commodity_guid,
    c.mnemonic as commodity_mnemonic,
    c.namespace as commodity_namespace,
    COALESCE(SUM(s.quantity_num::numeric / s.quantity_denom), 0) as native_balance
  FROM accounts a
  JOIN commodities c ON a.commodity_guid = c.guid
  LEFT JOIN splits s ON a.guid = s.account_guid
  GROUP BY a.guid, a.commodity_guid, c.mnemonic, c.namespace
),
latest_prices AS (
  SELECT DISTINCT ON (commodity_guid)
    commodity_guid,
    currency_guid,
    value_num::numeric / value_denom as price,
    date
  FROM prices
  WHERE currency_guid = $1  -- reporting currency GUID
  ORDER BY commodity_guid, date DESC
)
SELECT
  ab.*,
  COALESCE(lp.price, 1) as conversion_price,
  lp.date as conversion_date,
  ab.native_balance * COALESCE(lp.price, 1) as converted_balance
FROM account_balances ab
LEFT JOIN latest_prices lp ON ab.commodity_guid = lp.commodity_guid;
```

#### 5.1.3 Account Hierarchy UI Updates

**Modify `AccountHierarchy.tsx`**:
1. Show converted balances for aggregation (summing in same currency)
2. Display commodity symbol alongside balance for investment accounts
3. Add tooltip showing: "123.45 shares @ $456.78 = $56,290.91"
4. Aggregate child balances in reporting currency, not native

**Display Format Examples**:
- Cash account (USD): `$1,234.56`
- Stock account: `$56,290.91` (tooltip: "123.45 AAPL @ $456.78")
- Parent total: Sum of all children in reporting currency

**New Component Props**:
```typescript
interface AccountNodeProps {
  // ... existing
  showNativeBalance?: boolean;  // Toggle to show shares/units
  reportingCurrency: string;    // Currency for totals
}
```

#### 5.1.4 Price Management UI

**New Page**: `/prices` - View and manage price quotes

**Features**:
- List all commodities with their latest prices
- Historical price chart per commodity
- Manual price entry form
- Price import from CSV
- Integration with external quote services (future)

**New Files**:
- `src/app/(main)/prices/page.tsx`
- `src/components/PriceList.tsx`
- `src/components/PriceChart.tsx`
- `src/components/PriceEntryForm.tsx`

#### 5.1.5 Database Initialization

**Add to `db-init.ts`**:
```sql
-- Index for efficient price lookups
CREATE INDEX IF NOT EXISTS idx_prices_commodity_date
  ON prices(commodity_guid, date DESC);

CREATE INDEX IF NOT EXISTS idx_prices_commodity_currency
  ON prices(commodity_guid, currency_guid);

-- View for latest prices per commodity
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (commodity_guid, currency_guid)
  guid,
  commodity_guid,
  currency_guid,
  date,
  source,
  type,
  value_num::numeric / value_denom as price
FROM prices
ORDER BY commodity_guid, currency_guid, date DESC;
```

### 5.2 Multi-Currency Support (General)

**Features**:
- Price database queries for exchange rates
- Convert all amounts to reporting currency
- Display original currency alongside converted amount
- Support for manual exchange rate entry
- Currency chain traversal (e.g., GBP → EUR → USD)

**API**:
```
GET  /api/prices?commodity={guid}&currency={guid}&date={date}
POST /api/prices - Add price quote
```

### 5.3 User Authentication

**Implementation Options**:
- NextAuth.js with database adapter
- Simple password protection for single-user
- OAuth providers (Google, GitHub)

**Features**:
- Login/logout
- Session management
- Protected API routes
- User preferences storage

### 5.4 Data Validation & Integrity

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

### 5.5 Audit Trail

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

### Milestone 3: Reporting & Investments
9. Investment account support (price lookups, balance conversion)
10. Report framework setup
11. Balance Sheet report
12. Income Statement report
13. Chart visualizations

### Milestone 4: Budgeting
14. Budget list page
15. Budget editor
16. Budget vs Actual view
17. Budget reports

### Milestone 5: Polish
18. Cash Flow Statement
19. Export functionality (PDF, CSV, Excel)
20. Keyboard shortcuts
21. Mobile optimization
22. User authentication

---

## Success Metrics

- All GnuCash desktop report types available in web version
- Transaction entry as fast as desktop app
- Mobile-friendly budget tracking
- Real-time multi-user collaboration ready
- Sub-second page loads for all views
