# Dashboard API Fixes Plan

## Context

### Original Request
Fix two issues in dashboard APIs: (1) remove stale TODO in income-expense route, (2) align KPI totals with Treasurer Report by filtering hidden accounts.

### Research Findings
- `buildAccountPath()` in `income-expense/route.ts` already traverses the full parent chain via `parent_guid`, so the TODO concern is already addressed by existing code.
- `kpis/route.ts` lines 267-272 filter income/expense accounts without checking `hidden === 0`, while `treasurer/route.ts` line 149 does filter hidden accounts. This causes KPI totals to include hidden account splits, inflating numbers vs. the Treasurer Report.

### Known Differences (Out of Scope)
- **Rounding methodology**: The Treasurer Report rounds each split to 2dp before accumulating (line 213), while the KPI route accumulates raw floats and rounds only the final total (lines 401-402). This pre-existing difference may cause sub-cent discrepancies even after hidden account filtering is aligned. Aligning rounding is out of scope for this fix.

## Work Objectives

### Core Objective
Make dashboard KPI totals consistent with the Treasurer Report and clean up a stale TODO.

### Deliverables
1. KPI income/expense totals match Treasurer Report (hidden accounts excluded)
2. Stale TODO removed, replaced with clarifying comment

### Definition of Done
- Both code changes applied
- Playwright verification confirms KPI values match Treasurer Report values
- No build errors

## Guardrails

### Must Have
- Hidden account filtering in KPI route using `a.hidden === 0`
- TODO removal with explanatory comment in income-expense route
- Playwright verification of both changes

### Must NOT Have
- Changes to any other API routes
- Changes to the Treasurer Report logic
- New test files or test framework setup

## Tasks

### Task 1: Remove stale TODO in income-expense route
**File:** `src/app/api/dashboard/income-expense/route.ts`
**Parallel:** Yes (independent of Task 2)

**Steps:**
1. Remove the TODO comment on line 32
2. Add a clarifying comment explaining that `buildAccountPath()` already traverses the full parent chain, so `isTaxAccount()` correctly matches "tax" anywhere in the hierarchy path

**Acceptance Criteria:**
- TODO comment removed
- New comment explains why the path check works correctly
- No functional changes to `isTaxAccount()` or `buildAccountPath()`

### Task 2: Filter hidden accounts in KPI route
**File:** `src/app/api/dashboard/kpis/route.ts`
**Parallel:** Yes (independent of Task 1)

**Steps:**
1. At lines 267-272, add `&& a.hidden === 0` to both the `incomeAccounts` and `expenseAccounts` filter conditions:
   ```typescript
   const incomeAccounts = allAccounts.filter(
       a => a.account_type === 'INCOME' && a.hidden === 0
   );
   const expenseAccounts = allAccounts.filter(
       a => a.account_type === 'EXPENSE' && a.hidden === 0
   );
   ```

**Acceptance Criteria:**
- Hidden income accounts excluded from KPI income total
- Hidden expense accounts excluded from KPI expense total
- KPI totals closely match Treasurer Report totals for the same date range (within rounding tolerance of ~$1 due to per-split vs final-total rounding difference)

### Verification (after both tasks)
**Tool:** Playwright MCP
**Login:** Use credentials from `.env.test` (username: `biker2000on`)

**Steps:**
1. Navigate to the dashboard, note the Income and Expense KPI values
2. Navigate to the Treasurer Report for the same date range, note Income and Expense totals
3. Confirm KPI values closely match Treasurer Report values (within ~$1 rounding tolerance)
4. Navigate to dashboard income-expense chart, confirm tax breakdown still works correctly
5. Run `npm run build` to confirm no build errors

## Commit Strategy

Single commit for both fixes:
```
fix(dashboard): filter hidden accounts in KPIs and remove stale TODO

- Add hidden === 0 filter to income/expense account queries in KPIs route
  to match Treasurer Report behavior
- Remove resolved TODO in income-expense route; buildAccountPath already
  traverses full parent chain for tax account detection
```

## Success Criteria
- [ ] KPI income/expense totals closely match Treasurer Report for same date range (within ~$1 rounding tolerance)
- [ ] Tax account detection still works correctly in income-expense breakdown
- [ ] Build passes with zero errors
- [ ] Playwright verification confirms both fixes
