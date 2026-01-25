# Phase 04: Budgeting System - Research

**Researched:** 2026-01-24
**Domain:** GnuCash Budgets, Budget Periods, Budget vs Actual Reporting
**Confidence:** HIGH

## Summary

GnuCash stores budgets in the `budgets` table with amounts in `budget_amounts`. Each budget has a recurrence pattern (monthly, quarterly, yearly) and budget amounts are stored per account per period. This phase implements budget CRUD, a spreadsheet-style editor, and budget vs actual comparison views.

**Primary recommendation:** Use a virtualized spreadsheet component for the budget editor to handle large account lists efficiently. Leverage GnuCash's existing budget schema without modifications.

## GnuCash Budget Schema

### budgets Table
```sql
CREATE TABLE budgets (
  guid CHAR(32) PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  num_periods INT NOT NULL  -- Number of budget periods
);
```

### budget_amounts Table
```sql
CREATE TABLE budget_amounts (
  id SERIAL PRIMARY KEY,
  budget_guid CHAR(32) REFERENCES budgets(guid),
  account_guid CHAR(32) REFERENCES accounts(guid),
  period_num INT NOT NULL,
  amount_num BIGINT NOT NULL,
  amount_denom BIGINT NOT NULL
);
```

### recurrences Table (for budget period configuration)
```sql
CREATE TABLE recurrences (
  id SERIAL PRIMARY KEY,
  obj_guid CHAR(32),  -- Links to budget guid
  recurrence_mult INT,
  recurrence_period_type TEXT,  -- 'month', 'year', etc.
  recurrence_period_start DATE
);
```

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@tanstack/react-table` | ^8.x | Table/Grid | Virtual scrolling, column pinning, sorting |
| `@tanstack/react-virtual` | ^3.x | Virtualization | Efficient rendering for large datasets |
| Prisma | ^6.x | ORM | Type-safe DB access |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `date-fns` | ^4.x | Date math | Period calculations |
| `recharts` | ^2.x | Charts | Budget vs actual visualization |

**Installation:**
```bash
npm install @tanstack/react-table @tanstack/react-virtual recharts
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── app/
│   ├── (main)/budgets/
│   │   ├── page.tsx           # Budget list
│   │   └── [guid]/page.tsx    # Budget editor
│   └── api/budgets/
│       ├── route.ts           # List/Create
│       └── [guid]/
│           ├── route.ts       # Get/Update/Delete
│           └── amounts/route.ts # Batch update amounts
├── components/
│   └── BudgetEditor/
│       ├── BudgetGrid.tsx     # Spreadsheet editor
│       ├── PeriodHeader.tsx   # Column headers
│       └── AccountRow.tsx     # Row with inputs
```

### Pattern 1: Budget Period Calculation
```typescript
// Calculate period dates for a budget
const getBudgetPeriods = (budget: Budget, recurrence: Recurrence) => {
  const periods = [];
  let currentDate = new Date(recurrence.recurrence_period_start);

  for (let i = 0; i < budget.num_periods; i++) {
    const periodStart = new Date(currentDate);
    const periodEnd = addPeriod(currentDate, recurrence);
    periods.push({ num: i, start: periodStart, end: periodEnd });
    currentDate = periodEnd;
  }
  return periods;
};
```

### Pattern 2: Budget vs Actual Query
```typescript
const getBudgetVsActual = async (budgetGuid: string, periodNum: number) => {
  const budget = await prisma.budget.findUnique({
    where: { guid: budgetGuid },
    include: { amounts: { where: { period_num: periodNum } } }
  });

  // Get actuals from transactions
  const actuals = await prisma.$queryRaw`
    SELECT s.account_guid,
           SUM(s.value_num::decimal / s.value_denom::decimal) as actual
    FROM splits s
    JOIN transactions t ON t.guid = s.tx_guid
    WHERE t.post_date BETWEEN ${periodStart} AND ${periodEnd}
    GROUP BY s.account_guid
  `;

  return mergeWithBudget(budget.amounts, actuals);
};
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Spreadsheet grid | Custom table | @tanstack/react-table | Virtual scroll, keyboard nav, copy/paste |
| Period math | Manual date math | date-fns | Handles edge cases (month lengths, leap years) |
| Charts | Canvas drawing | recharts | Responsive, accessible, animation support |

## Common Pitfalls

### Pitfall 1: Period Number Misalignment
**What goes wrong:** Wrong amounts for period.
**Why it happens:** Period 0 vs period 1 indexing confusion.
**How to avoid:** Consistently use 0-indexed periods throughout.

### Pitfall 2: Large Budget Grids
**What goes wrong:** UI freezes with 200+ accounts × 12 periods.
**Why it happens:** Rendering 2400+ cells without virtualization.
**How to avoid:** Use @tanstack/react-virtual for row virtualization.

### Pitfall 3: Stale Actuals
**What goes wrong:** Budget vs actual shows outdated data.
**Why it happens:** Actuals computed at page load, not refreshed.
**How to avoid:** Add refresh button or use SWR for automatic revalidation.

## Code Examples

### Budget Amount Update (Batch)
```typescript
// API endpoint for batch updating budget amounts
export async function PUT(req: Request) {
  const { budgetGuid, amounts } = await req.json();

  await prisma.$transaction(
    amounts.map(({ accountGuid, periodNum, value }) =>
      prisma.budgetAmount.upsert({
        where: {
          budget_guid_account_guid_period_num: {
            budget_guid: budgetGuid,
            account_guid: accountGuid,
            period_num: periodNum,
          }
        },
        update: {
          amount_num: BigInt(Math.round(value * 100)),
          amount_denom: BigInt(100),
        },
        create: {
          budget_guid: budgetGuid,
          account_guid: accountGuid,
          period_num: periodNum,
          amount_num: BigInt(Math.round(value * 100)),
          amount_denom: BigInt(100),
        }
      })
    )
  );
}
```

## Sources

### Primary (HIGH confidence)
- [GnuCash Wiki: SQL](https://wiki.gnucash.org/wiki/SQL) - Budget tables
- [GnuCash Source: Budget.c](https://github.com/Gnucash/gnucash) - Budget logic

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH
- Architecture: HIGH
- Pitfalls: MEDIUM (budget schema less documented)

**Research date:** 2026-01-24
**Valid until:** 2026-02-24
