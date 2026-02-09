# Implementation Plan: Report Fixes & Budget Editor

## Final Task List (Critic-Approved)

### Phase 1: Fix Reports (CRITICAL) - Parallel

**T1: Fix Balance Sheet Report**
- File: `src/lib/reports/balance-sheet.ts`
- Changes:
  1. Add query for Root Account GUID at start of generateBalanceSheet()
  2. Pass rootGuid to buildHierarchy() calls at lines 105-107
- Acceptance: Balance Sheet shows non-zero totals

**T2: Fix Income Statement Report**
- File: `src/lib/reports/income-statement.ts`
- Changes:
  1. Add query for Root Account GUID at start of generateIncomeStatement()
  2. Pass rootGuid to buildHierarchy() calls at lines 131-136
- Acceptance: Income Statement shows non-zero totals

### Phase 2A: Inline Editing

**T3: Create Amounts API Endpoint**
- File: `src/app/api/budgets/[guid]/amounts/route.ts` (CREATE)
- Creates PATCH handler that calls BudgetService.setAmount()

**T4: Create InlineAmountEditor Component**
- File: `src/components/budget/InlineAmountEditor.tsx` (CREATE)
- Click to edit, Enter/blur to save, Escape to cancel

**T5: Integrate Inline Editing into Budget Page**
- File: `src/app/(main)/budgets/[guid]/page.tsx`
- Replace static cells with InlineAmountEditor
- Depends on: T3, T4

### Phase 2B: Add Account

**T6: Add addAccount Service Method**
- File: `src/lib/services/budget.service.ts`
- Creates budget_amounts for all periods with 0 values

**T7: Create Add Account API Endpoint**
- File: `src/app/api/budgets/[guid]/accounts/route.ts` (CREATE)
- POST handler
- Depends on: T6

**T8: Create AccountPickerModal Component**
- File: `src/components/budget/AccountPickerModal.tsx` (CREATE)
- Filter to budgetable types, exclude existing accounts

**T9: Add "Add Account" Button to Budget Page**
- File: `src/app/(main)/budgets/[guid]/page.tsx`
- Depends on: T7, T8

### Phase 2C: Delete Allocation

**T10: Add deleteAccountAmounts Service Method**
- File: `src/lib/services/budget.service.ts`

**T11: Add DELETE Handler to Amounts API**
- File: `src/app/api/budgets/[guid]/amounts/route.ts`
- Depends on: T3, T10

**T12: Add Delete Button to Budget Page**
- File: `src/app/(main)/budgets/[guid]/page.tsx`
- Depends on: T11

### Phase 3A: All Periods Batch Editing

**T13: Add setAllPeriods Service Method**
- File: `src/lib/services/budget.service.ts`

**T14: Create All Periods API Endpoint**
- File: `src/app/api/budgets/[guid]/amounts/all-periods/route.ts` (CREATE)
- Depends on: T13

**T15: Create BatchEditModal Component**
- File: `src/components/budget/BatchEditModal.tsx` (CREATE)

**T16: Add "Set All" Button to Budget Page**
- File: `src/app/(main)/budgets/[guid]/page.tsx`
- Depends on: T14, T15

### Phase 3B: Estimate from History

**T17: Add getHistoricalAverage Service Method**
- File: `src/lib/services/budget.service.ts`
- Query last 12 months of transactions, calculate average

**T18: Create Estimate API Endpoint**
- File: `src/app/api/budgets/[guid]/estimate/route.ts` (CREATE)
- Depends on: T17

**T19: Add Estimate Button to Budget Page**
- File: `src/app/(main)/budgets/[guid]/page.tsx`
- Depends on: T14, T18

## Execution Order

```
PARALLEL: T1, T2 (Phase 1)
PARALLEL: T3, T4 (Phase 2A start)
SEQUENTIAL: T5 (depends on T3, T4)
PARALLEL: T6, T8, T10 (Phase 2B/2C service methods)
SEQUENTIAL: T7 (depends on T6)
PARALLEL: T9 (depends on T7, T8), T11 (depends on T3, T10)
SEQUENTIAL: T12 (depends on T11)
PARALLEL: T13, T15, T17 (Phase 3 service methods)
SEQUENTIAL: T14 (depends on T13)
SEQUENTIAL: T16 (depends on T14, T15)
SEQUENTIAL: T18 (depends on T17)
SEQUENTIAL: T19 (depends on T14, T18)
```

## Files Summary

| File | Action | Tasks |
|------|--------|-------|
| src/lib/reports/balance-sheet.ts | Modify | T1 |
| src/lib/reports/income-statement.ts | Modify | T2 |
| src/lib/services/budget.service.ts | Modify | T6, T10, T13, T17 |
| src/app/api/budgets/[guid]/amounts/route.ts | Create | T3, T11 |
| src/app/api/budgets/[guid]/accounts/route.ts | Create | T7 |
| src/app/api/budgets/[guid]/amounts/all-periods/route.ts | Create | T14 |
| src/app/api/budgets/[guid]/estimate/route.ts | Create | T18 |
| src/components/budget/InlineAmountEditor.tsx | Create | T4 |
| src/components/budget/AccountPickerModal.tsx | Create | T8 |
| src/components/budget/BatchEditModal.tsx | Create | T15 |
| src/app/(main)/budgets/[guid]/page.tsx | Modify | T5, T9, T12, T16, T19 |
