# Data-Driven Financial Planning Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the mortgage and FIRE calculators from standalone manual-input tools into data-driven planning tools that pull real financial data from the GnuCash database, and add a new scheduled transactions UI.

**Architecture:** Extract shared financial summary service from the KPI API route. Add a mortgage detection service with Newton-Raphson rate solver. Add a recurrence computation utility for scheduled transactions. Each feature has its own API route(s) and page components, reusing the existing `tool-config` service for persistence.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL (Prisma + raw SQL), recharts, Tailwind CSS

**Design doc:** `~/.gstack/projects/biker2000on-gnucash-web/justin-feat-mortgage-fire-tools-design-20260322-125807.md`

---

## File Structure

### New Files
- `src/lib/services/financial-summary.service.ts` — Shared service extracted from KPI API (net worth, income, expenses, savings rate)
- `src/lib/services/mortgage.service.ts` — Mortgage detection (rate solver, split separation, original amount detection)
- `src/lib/recurrence.ts` — Recurrence computation utility (next occurrence dates from GnuCash recurrence patterns)
- `src/app/api/tools/mortgage/detect/route.ts` — Mortgage auto-detect API endpoint
- `src/app/api/scheduled-transactions/route.ts` — Scheduled transactions list API
- `src/app/api/scheduled-transactions/upcoming/route.ts` — Upcoming scheduled transactions API
- `src/components/mortgage/MortgageAutoDetect.tsx` — Auto-detect flow component
- `src/components/mortgage/AmortizationTable.tsx` — Extracted amortization table component
- `src/components/mortgage/PayoffComparison.tsx` — Extracted payoff comparison component
- `src/app/(main)/scheduled-transactions/page.tsx` — Scheduled transactions page
- `src/lib/services/__tests__/financial-summary.service.test.ts` — Financial summary service tests
- `src/lib/services/__tests__/mortgage.service.test.ts` — Mortgage service tests
- `src/lib/__tests__/recurrence.test.ts` — Recurrence utility tests

### Modified Files
- `src/app/api/dashboard/kpis/route.ts` — Refactor to use shared financial summary service
- `src/app/(main)/tools/mortgage/page.tsx` — Add auto-detect, decompose into components
- `src/app/(main)/tools/fire-calculator/page.tsx` — Transform to data-driven with API fetching
- `src/components/Layout.tsx` — Add scheduled transactions nav item

---

## Task 1: Financial Summary Service (Extract from KPI)

**Files:**
- Create: `src/lib/services/financial-summary.service.ts`
- Create: `src/lib/services/__tests__/financial-summary.service.test.ts`
- Modify: `src/app/api/dashboard/kpis/route.ts`

This task extracts the core financial computation logic from the 435-line KPI API route into a reusable service. The KPI route will be refactored to call this service, and the FIRE calculator will also use it.

- [ ] **Step 1: Write financial summary service tests**

Create `src/lib/services/__tests__/financial-summary.service.test.ts` with tests for:
- `computeNetWorth()` — single currency, returns sum of assets minus liabilities
- `computeNetWorth()` — multi-currency, applies exchange rates
- `computeNetWorth()` — includes investment accounts at market price
- `computeIncomeExpenses()` — sums income and expense accounts over date range
- `computeIncomeExpenses()` — negates income (GnuCash stores income as negative)
- `computeIncomeExpenses()` — multi-currency conversion at end date
- `computeSavingsRate()` — returns (income - expenses) / income * 100
- `computeSavingsRate()` — returns 0 when income is 0

Mock Prisma queries and `findExchangeRate()`. Use the existing test patterns from `src/lib/services/__tests__/` (see `tool-config.service.test.ts` for mocking patterns).

Account type constants to use:
```typescript
const ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'RECEIVABLE'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];
const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run src/lib/services/__tests__/financial-summary.service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement financial summary service**

Create `src/lib/services/financial-summary.service.ts` with a `FinancialSummaryService` class containing static methods:

```typescript
import { prisma } from '@/lib/db';
import { toDecimal } from '@/lib/gnucash';
import { findExchangeRate, getBaseCurrency } from '@/lib/currency';

export interface FinancialSummary {
  netWorth: number;
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
  investmentValue: number;
  topExpenseCategory: string;
  topExpenseAmount: number;
}

export class FinancialSummaryService {
  static async computeNetWorth(bookGuid: string, asOfDate: Date): Promise<{
    netWorth: number;
    assets: number;
    liabilities: number;
    investmentValue: number;
  }> { /* ... */ }

  static async computeIncomeExpenses(bookGuid: string, startDate: Date, endDate: Date): Promise<{
    totalIncome: number;
    totalExpenses: number;
    savingsRate: number;
    topExpenseCategory: string;
    topExpenseAmount: number;
  }> { /* ... */ }

  static async getSummary(bookGuid: string, startDate: Date, endDate: Date): Promise<FinancialSummary> { /* ... */ }
}
```

Extract the computation logic from `src/app/api/dashboard/kpis/route.ts` lines covering:
- Account classification (ASSET_TYPES, LIABILITY_TYPES, INVESTMENT_TYPES)
- Multi-currency balance aggregation with `findExchangeRate()`
- Investment valuation using latest prices from the `prices` table
- Income/expense split summation with GnuCash sign convention (income is negative)
- Expense categorization by top-level parent account
- Savings rate calculation

Use `toDecimal()` for all GnuCash fraction-to-decimal conversions. Use `getBaseCurrency()` to determine the reporting currency.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run src/lib/services/__tests__/financial-summary.service.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor KPI route to use shared service**

Modify `src/app/api/dashboard/kpis/route.ts` to call `FinancialSummaryService.getSummary()` instead of inline computation. The route should still handle:
- Query param parsing (`startDate`, `endDate`)
- Caching (`cache:{bookGuid}:kpis:{startDate}-{endDate}`)
- Response formatting
- Net worth change calculation (call `computeNetWorth()` at both start and end dates)

The route shrinks significantly as computation moves to the service.

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/lib/services/financial-summary.service.ts src/lib/services/__tests__/financial-summary.service.test.ts src/app/api/dashboard/kpis/route.ts
git commit -m "refactor: extract financial summary service from KPI API route"
```

---

## Task 2: Mortgage Detection Service

**Files:**
- Create: `src/lib/services/mortgage.service.ts`
- Create: `src/lib/services/__tests__/mortgage.service.test.ts`

This task creates the core mortgage analysis logic: detecting the original loan amount, separating payment splits into principal vs interest, and reverse-engineering the interest rate using Newton-Raphson.

- [ ] **Step 1: Write mortgage service tests**

Create `src/lib/services/__tests__/mortgage.service.test.ts` with tests:

```typescript
// Rate detection tests
// T3: Newton-Raphson converges for standard 30yr mortgage at 4.5%
// T4: Returns insufficient data error for < 3 payments
// T5: Flags variable rate when variance > 0.5%
// T6: Returns error when Newton-Raphson doesn't converge (degenerate data)

// Original amount detection tests
// T1: Detects from opening balance transaction
// T2: Falls back to sum of principal postings when no opening transaction

// Split separation tests
// T7: Correctly separates principal and interest splits
// T8: Excludes escrow splits (different expense accounts)
// T9: Returns empty arrays when no interest splits found

// Full pipeline test
// T10: detectMortgageDetails() returns complete results
```

For the Newton-Raphson test, use known mortgage parameters:
- P = $200,000, annual rate = 4.5%, 30 years (360 months)
- Monthly payment M = $1,013.37
- Detected rate should be within 0.01% of 4.5%

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run src/lib/services/__tests__/mortgage.service.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement mortgage service**

Create `src/lib/services/mortgage.service.ts`:

```typescript
import { prisma } from '@/lib/db';
import { toDecimal } from '@/lib/gnucash';

export interface MortgageDetectionResult {
  originalAmount: number;
  interestRate: number;        // annual percentage
  monthlyPayment: number;      // average P+I payment
  paymentsAnalyzed: number;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
}

export interface PaymentSplit {
  date: Date;
  principal: number;
  interest: number;
  total: number;
}

export class MortgageService {
  /**
   * Separate transaction splits into principal and interest components.
   * Principal = splits posting to the liability account (mortgage account).
   * Interest = splits posting to the specified interest expense account.
   * Escrow and other splits are ignored.
   */
  static separateSplits(
    splits: Array<{ post_date: Date; account_guid: string; value_num: bigint; value_denom: bigint }>,
    mortgageAccountGuid: string,
    interestAccountGuid: string
  ): PaymentSplit[] { /* ... */ }

  /**
   * Detect the original loan amount.
   * Strategy 1: Look for the first/largest posting to the liability account (opening balance).
   * Strategy 2: Sum all principal postings (fallback).
   */
  static detectOriginalAmount(
    splits: Array<{ post_date: Date; account_guid: string; value_num: bigint; value_denom: bigint }>,
    mortgageAccountGuid: string
  ): number { /* ... */ }

  /**
   * Reverse-engineer the annual interest rate using Newton-Raphson.
   * Given: original balance P, monthly payment M, number of payments n
   * Solve: M = P * r(1+r)^n / ((1+r)^n - 1) for monthly rate r
   * Returns annual rate = r * 12 * 100
   */
  static detectInterestRate(
    originalAmount: number,
    monthlyPayment: number,
    totalPayments: number
  ): { rate: number; converged: boolean } { /* ... */ }

  /**
   * Full detection pipeline: query splits, separate, detect amount and rate.
   */
  static async detectMortgageDetails(
    mortgageAccountGuid: string,
    interestAccountGuid: string
  ): Promise<MortgageDetectionResult> { /* ... */ }
}
```

Newton-Raphson implementation for `detectInterestRate()`:
- f(r) = M - P * r * (1+r)^n / ((1+r)^n - 1)
- f'(r) = derivative of the above
- Iterate: r_new = r_old - f(r) / f'(r)
- Initial guess: r = 0.04 / 12 (4% annual)
- Convergence: |f(r)| < 0.01 (within 1 cent)
- Max iterations: 100
- Validate: compare each payment's implied rate, flag variance > 0.5%

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run src/lib/services/__tests__/mortgage.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/lib/services/mortgage.service.ts src/lib/services/__tests__/mortgage.service.test.ts
git commit -m "feat(mortgage): add mortgage detection service with Newton-Raphson rate solver"
```

---

## Task 3: Mortgage Detect API Route

**Files:**
- Create: `src/app/api/tools/mortgage/detect/route.ts`

- [ ] **Step 1: Implement the detect API route**

Create `src/app/api/tools/mortgage/detect/route.ts`:

```typescript
// GET /api/tools/mortgage/detect?accountGuid=X&interestAccountGuid=Y
// Returns: MortgageDetectionResult (original amount, interest rate, monthly payment, confidence, warnings)
```

The route should:
1. Validate query params (`accountGuid` and `interestAccountGuid` required, both 32-char strings)
2. Call `requireRole('readonly')` for auth
3. Call `MortgageService.detectMortgageDetails(accountGuid, interestAccountGuid)`
4. Return JSON response with detected values
5. Handle errors: 400 for missing params, 404 for account not found, 500 for detection failure

Follow the pattern from existing API routes in the codebase (e.g., `src/app/api/tools/config/route.ts`).

- [ ] **Step 2: Run lint to verify no errors**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npm run lint`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/app/api/tools/mortgage/detect/route.ts
git commit -m "feat(mortgage): add auto-detect API endpoint"
```

---

## Task 4: Mortgage Page Decomposition & Auto-Detect UI

**Files:**
- Create: `src/components/mortgage/MortgageAutoDetect.tsx`
- Create: `src/components/mortgage/AmortizationTable.tsx`
- Create: `src/components/mortgage/PayoffComparison.tsx`
- Modify: `src/app/(main)/tools/mortgage/page.tsx`

- [ ] **Step 1: Extract AmortizationTable component**

Create `src/components/mortgage/AmortizationTable.tsx` — extract the amortization schedule table rendering from the mortgage page. Props:

```typescript
interface AmortizationTableProps {
  schedule: AmortizationRow[];
  showExtraPayment?: boolean;
}
```

Should render: month-by-month table with Month, Payment, Principal, Interest, Extra Payment (if applicable), Balance columns. Right-aligned monospace numbers, alternating row shading, sticky header, bold total row. Horizontal scroll with sticky first column on mobile.

- [ ] **Step 2: Extract PayoffComparison component**

Create `src/components/mortgage/PayoffComparison.tsx` — extract the payoff comparison view. Props:

```typescript
interface PayoffComparisonProps {
  originalSchedule: AmortizationRow[];
  acceleratedSchedule: AmortizationRow[];
  originalPayment: number;
  acceleratedPayment: number;
}
```

Side-by-side columns: "Current Plan" vs "Your Plan" with rows for Monthly Payment, Payoff Term, Total Interest, Total Paid, and a highlighted delta row at bottom.

- [ ] **Step 3: Create MortgageAutoDetect component**

Create `src/components/mortgage/MortgageAutoDetect.tsx` — the auto-detection flow:

```typescript
interface MortgageAutoDetectProps {
  onDetectionComplete: (result: {
    originalAmount: number;
    interestRate: number;
    monthlyPayment: number;
    loanTermMonths: number;
    accountGuid: string;
    interestAccountGuid: string;
  }) => void;
}
```

The component should:
1. Show an account selector (liability accounts only) — reuse `AccountSelector` component
2. After account selection, show a second selector for the interest expense account
3. Call `GET /api/tools/mortgage/detect?accountGuid=X&interestAccountGuid=Y`
4. Show loading state: skeleton cards with "Analyzing payments..."
5. Show results: detected values with green checkmarks, each value editable (inline override)
6. Show warnings from the detection result
7. "Use These Values" button calls `onDetectionComplete`
8. Error state: "Couldn't analyze payments. Enter values manually below." with [Try Again] and [Manual] buttons

- [ ] **Step 4: Update mortgage page to use extracted components and add mode toggle**

Modify `src/app/(main)/tools/mortgage/page.tsx`:
- Add mode toggle at top: [Linked Account] vs [New Mortgage]
- In "Linked Account" mode: show `MortgageAutoDetect`, then existing calculator with pre-filled values
- In "New Mortgage" mode: show existing calculator as-is (purchase price, down payment, rate, term)
- Replace inline amortization table with `AmortizationTable` component
- Replace inline payoff comparison with `PayoffComparison` component
- Update config saving to include `interestAccountGuid` in the config JSON
- Add primary summary cards at top showing: Current Balance (fetched from linked account), Interest Rate, Payoff Date

- [ ] **Step 5: Run lint and test suite**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npm run lint && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/components/mortgage/ src/app/\(main\)/tools/mortgage/page.tsx
git commit -m "feat(mortgage): decompose page and add auto-detect UI with mode toggle"
```

---

## Task 5: FIRE Calculator Data-Driven Upgrade

**Files:**
- Modify: `src/app/(main)/tools/fire-calculator/page.tsx`

- [ ] **Step 1: Transform FIRE calculator to data-driven**

Rewrite `src/app/(main)/tools/fire-calculator/page.tsx` to:

1. **Fetch KPI data on mount**: Call `GET /api/dashboard/kpis` with appropriate date range (last 12 months by default). Extract: `netWorth`, `totalIncome`, `totalExpenses`, `savingsRate`, `investmentValue`.

2. **Fetch portfolio return**: Call `GET /api/investments/history?days=365`. Run `calculateTimeWeightedReturn()` client-side to get annualized return. Use as default `expectedReturn`.

3. **Data source state**: Track which values are "(from your data)" vs "(override)". Each financial input has:
   ```typescript
   interface DataDrivenValue {
     computed: number | null;  // from API
     override: number | null;  // user override
     source: 'data' | 'override' | 'manual';
   }
   ```

4. **Inline override UX**: Each value shows "(from your data)" label with a small edit icon. Clicking makes it an input field. Changed values show "(override)" with a reset button (×) that restores the computed value.

5. **Save/load configs**: Use existing `tool-config` service (`toolType: 'fire-calculator'`). Config stores: override values, time window months, excluded accounts.

6. **Loading/error states**:
   - Loading: skeleton cards with "Loading your financial data..."
   - Error: "Couldn't load your financial data." [Retry] [Use Manual]
   - Empty: "No financial data found. Enter values manually to get started."
   - Partial: show what's available, manual for the rest

7. **Information hierarchy** (from design review):
   - Primary: FI dashboard cards (Net Worth, FI Number, Years to FI with progress bar)
   - Secondary: projection chart (area with gradient, dashed line for projected)
   - Tertiary: inputs grid with inline override
   - Quaternary: scenario comparison deltas ("If you save $500 more → FI 2.1yr sooner")

8. **Keep existing calculation logic**: `useMemo` for FI number, years to FI, portfolio projection. Use effective values (override || computed || manual input).

- [ ] **Step 2: Run lint and test suite**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npm run lint && npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/app/\(main\)/tools/fire-calculator/page.tsx
git commit -m "feat(fire): transform FIRE calculator to data-driven with KPI integration"
```

---

## Task 6: Recurrence Computation Utility

**Files:**
- Create: `src/lib/recurrence.ts`
- Create: `src/lib/__tests__/recurrence.test.ts`

- [ ] **Step 1: Write recurrence utility tests**

Create `src/lib/__tests__/recurrence.test.ts` with tests:

```typescript
// T33: Monthly recurrence — handles Feb (28/29), Apr (30), etc.
// T34: Weekly recurrence — correct day-of-week preservation
// T35: Daily recurrence — straightforward increment
// T36: Yearly recurrence — leap year handling (Feb 29)
// T37: Weekend adjust — shifts Saturday to Friday, Sunday to Monday
// T38: Multiplier > 1 — every 2nd month, every 3rd week, etc.
// T39: rem_occur = 0 — returns empty (no remaining occurrences)
// T40: end_date reached — stops generating at end_date
```

Test with concrete dates. Example: monthly on Jan 31, compute next 3 → Jan 31, Feb 28, Mar 31.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run src/lib/__tests__/recurrence.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement recurrence utility**

Create `src/lib/recurrence.ts`:

```typescript
export interface RecurrencePattern {
  periodType: string;       // 'daily' | 'weekly' | 'month' | 'end of month' | 'year' | etc.
  mult: number;             // interval multiplier
  periodStart: Date;        // anchor date
  weekendAdjust: string;    // 'none' | 'back' | 'forward'
}

export interface ScheduledOccurrence {
  date: Date;
  scheduledTransactionName: string;
  // ... other fields populated by caller
}

/**
 * Compute the next N occurrences of a recurrence pattern.
 * Handles: monthly end-of-month clamping, leap years, weekend adjustment, multipliers.
 */
export function computeNextOccurrences(
  pattern: RecurrencePattern,
  lastOccur: Date | null,
  endDate: Date | null,
  remainingOccurrences: number | null,  // null = unlimited
  count: number = 10,
  afterDate: Date = new Date()
): Date[] { /* ... */ }

/**
 * Adjust a date for weekend: 'back' shifts Sat/Sun to Friday, 'forward' shifts to Monday.
 */
function adjustForWeekend(date: Date, adjust: string): Date { /* ... */ }
```

Key implementation details:
- Monthly: add N months, clamp day to last day of target month (e.g., Jan 31 + 1 month = Feb 28)
- GnuCash period types: `'once'`, `'daily'`, `'weekly'`, `'month'`, `'end of month'`, `'nth weekday'`, `'last weekday'`, `'semi_monthly'`, `'year'`
- Weekend adjust: `'none'` (no adjustment), `'back'` (Saturday/Sunday → previous Friday), `'forward'` (Saturday/Sunday → next Monday)
- Start computing from `max(lastOccur + interval, afterDate)`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run src/lib/__tests__/recurrence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/lib/recurrence.ts src/lib/__tests__/recurrence.test.ts
git commit -m "feat(scheduled): add recurrence computation utility with edge case handling"
```

---

## Task 7: Scheduled Transactions API

**Files:**
- Create: `src/app/api/scheduled-transactions/route.ts`
- Create: `src/app/api/scheduled-transactions/upcoming/route.ts`

- [ ] **Step 1: Implement scheduled transactions list API**

Create `src/app/api/scheduled-transactions/route.ts`:

```typescript
// GET /api/scheduled-transactions?enabled=true
// Returns: Array of scheduled transactions with resolved template amounts and account mappings
```

Two-step query pattern:

**Step 1 query** — fetch scheduled transactions with recurrence patterns (raw SQL):
```sql
SELECT s.guid, s.name, s.enabled, s.start_date, s.end_date, s.last_occur,
       s.num_occur, s.rem_occur, s.auto_create, s.template_act_guid,
       r.recurrence_mult, r.recurrence_period_type, r.recurrence_period_start,
       r.recurrence_weekend_adjust
FROM schedxactions s
LEFT JOIN recurrences r ON r.obj_guid = s.guid
```

**Step 2 query** — resolve template amounts for each scheduled transaction:
For each `template_act_guid`:
1. Find child accounts of the template root: `SELECT guid FROM accounts WHERE parent_guid = :templateActGuid`
2. Find splits for transactions referencing those template accounts: `SELECT s.* FROM splits s JOIN transactions t ON s.tx_guid = t.guid WHERE s.account_guid IN (:templateAccountGuids)`
3. Resolve real account GUIDs from slots: `SELECT guid_val FROM slots WHERE obj_guid IN (:templateAccountGuids) AND slot_type = 4 AND name = 'account'`
4. Map template account → real account, combine with split amounts

Response shape:
```typescript
interface ScheduledTransaction {
  guid: string;
  name: string;
  enabled: boolean;
  startDate: string;
  endDate: string | null;
  lastOccur: string | null;
  remainingOccurrences: number;
  autoCreate: boolean;
  recurrence: {
    periodType: string;
    mult: number;
    periodStart: string;
    weekendAdjust: string;
  } | null;
  nextOccurrence: string | null;  // computed
  splits: Array<{
    accountGuid: string;
    accountName: string;
    amount: number;
  }>;
}
```

- [ ] **Step 2: Implement upcoming scheduled transactions API**

Create `src/app/api/scheduled-transactions/upcoming/route.ts`:

```typescript
// GET /api/scheduled-transactions/upcoming?days=30
// Returns: Array of upcoming occurrences sorted by date
```

This route:
1. Calls the same queries as the list API
2. For each enabled scheduled transaction with a recurrence, calls `computeNextOccurrences()` from `src/lib/recurrence.ts`
3. Flattens all occurrences into a single sorted array
4. Returns occurrences within the requested window

Response shape:
```typescript
interface UpcomingOccurrence {
  date: string;
  scheduledTransactionGuid: string;
  scheduledTransactionName: string;
  splits: Array<{
    accountGuid: string;
    accountName: string;
    amount: number;
  }>;
}
```

- [ ] **Step 3: Run lint**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npm run lint`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/app/api/scheduled-transactions/
git commit -m "feat(scheduled): add scheduled transactions API with template resolution"
```

---

## Task 8: Scheduled Transactions Page

**Files:**
- Create: `src/app/(main)/scheduled-transactions/page.tsx`
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Create scheduled transactions page**

Create `src/app/(main)/scheduled-transactions/page.tsx`:

The page should:
1. Fetch from `GET /api/scheduled-transactions` on mount
2. Show two view modes via toggle: [All] and [Upcoming 30 days]
   - "All" view: full list of scheduled transactions
   - "Upcoming" view: fetches from `GET /api/scheduled-transactions/upcoming?days=30`
3. Filter controls: enabled/disabled, account name search
4. Sort controls: next occurrence date (default), name, amount
5. Each row shows: name, frequency (e.g., "Monthly"), next occurrence date, amount, enabled/disabled badge, account mapping (from → to as subtle chips)
6. Mortgage link: if a split's account matches a mortgage-configured tool config, show "View in Mortgage Calculator" link
7. Ledger-style rows matching existing transaction journal pattern: date left-aligned, amount right-aligned monospace

Interaction states:
- Loading: shimmer rows
- Empty: "No scheduled transactions found. These are created in GnuCash desktop."
- Error: "Couldn't load scheduled transactions." [Retry]

Responsive: full list on desktop, compact rows (name + amount on same line) on mobile.

- [ ] **Step 2: Add navigation item**

Modify `src/components/Layout.tsx` — add "Scheduled Transactions" to the navItems array under the Tools section:

```typescript
{
  name: 'Tools',
  href: '/tools',
  icon: 'Wrench',
  children: [
    { name: 'FIRE Calculator', href: '/tools/fire-calculator' },
    { name: 'Mortgage Calculator', href: '/tools/mortgage' },
    { name: 'Scheduled Transactions', href: '/scheduled-transactions' },
    { name: 'Asset Analysis', href: '/assets' },
  ],
},
```

- [ ] **Step 3: Run lint and test suite**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npm run lint && npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools
git add src/app/\(main\)/scheduled-transactions/ src/components/Layout.tsx
git commit -m "feat(scheduled): add scheduled transactions page with list and upcoming views"
```

---

## Task 9: Final Integration & Build Verification

**Files:** None new — verification only.

- [ ] **Step 1: Run full test suite**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npx vitest run`
Expected: All tests pass (existing 83 + ~30 new)

- [ ] **Step 2: Run production build**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npm run build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 3: Run lint**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-mortgage-fire-tools && npm run lint`
Expected: No lint errors
