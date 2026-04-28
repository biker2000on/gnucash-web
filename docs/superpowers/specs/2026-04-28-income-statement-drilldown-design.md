# Income Statement by Period — Transaction Drill-down

**Status:** Approved (design)
**Date:** 2026-04-28
**Owner:** Justin

## Problem

The Income Statement by Period report shows aggregate amounts per account
per period, but offers no way to inspect what makes up a number. To verify a
figure or recall what drove a spike, the user must leave the report, open the
account ledger, and manually filter by the period — a slow context switch.

## Goal

Let the user click an amount in the periodic report and see the underlying
transactions inline in a modal, with date, description, account, and amount.

## Non-goals

- Editing transactions from the modal (link out to the ledger instead).
- Drill-down on section subtotals, the Total column total at the section
  level, or the Net Income row. These mix many accounts and produce lists
  too long to be useful at a glance.
- Drill-down on other reports (income statement, balance sheet, etc.). This
  scope is the periodic report only.

## Click targets

Clickable cells:

- Per-period account cells, both leaf accounts and parent accounts (parents
  roll up descendants — clicking a parent shows transactions across all
  descendant in-scope accounts in that period).
- The per-row "Total" column on each account row (full date range, that
  account and descendants). This is the rightmost column on every account
  line. The section subtotal rows ("Total Income", "Total Expenses") are
  not clickable — see non-clickable list below.

Non-clickable cells:

- Section title rows (Income / Expenses).
- Section totals rows ("Total Income", "Total Expenses").
- Net Income row.
- Cells whose absolute value rounds to zero (`Math.abs(v) < 0.005`) — there
  is nothing to show.

Affordance: clickable cells get `cursor-pointer` and an underline-on-hover.
Zero cells render as today (muted, non-interactive).

## API

**Endpoint:** `GET /api/reports/income-statement-by-period/transactions`

**Query parameters:**

| param              | required | description                                       |
| ------------------ | -------- | ------------------------------------------------- |
| `accountGuid`      | yes      | The account whose subtree we are drilling into.   |
| `startDate`        | yes      | ISO date (`YYYY-MM-DD`), inclusive.               |
| `endDate`          | yes      | ISO date, inclusive.                              |
| `bookAccountGuids` | no       | Optional book scoping, mirrors the report filter. |

**Behavior:**

1. Resolve the in-scope account set: `accountGuid` plus its descendants,
   filtered to `account_type IN ('INCOME', 'EXPENSE')`. Use the existing
   `account_hierarchy` view (recursive CTE created at startup) so the
   resolution matches what the report itself does.
2. Fetch every split where `account_guid IN (in-scope)` and the parent
   transaction `post_date` falls in `[startDate, endDate]` inclusive.
3. Convert quantity to decimal with `toDecimal(num, denom)`. Look up the
   clicked account's type once; if it is `INCOME`, flip every amount's
   sign so positive numbers represent inflows (matching the report's
   display). EXPENSE amounts are left as-is.
4. Sort by `post_date DESC, enter_date DESC`.

**Response:**

```ts
{
  transactions: Array<{
    txGuid: string;
    splitGuid: string;
    date: string;        // ISO 'YYYY-MM-DD'
    description: string; // transaction.description
    accountGuid: string; // the in-scope account this split hit
    accountName: string;
    amount: number;      // signed; income flipped to positive
  }>;
  total: number;         // sum of amounts; should match the clicked cell
}
```

One row per split. If a single transaction has two splits in the in-scope
subtree (e.g., a payroll txn with separate splits to `Income:Salary` and
`Income:Bonus` and the user clicks the `Income` parent), it appears as two
rows. This keeps the row sum equal to the clicked cell, which is the
property the modal uses as a sanity check.

## Frontend

### State

The page (`src/app/(main)/reports/income_statement_by_period/page.tsx`)
owns a single piece of new state:

```ts
type DrilldownTarget = {
  accountGuid: string;
  accountName: string;
  periodLabel: string; // e.g., "March 2026" or "Total" or "Jan 2026 – Apr 2026"
  startDate: string;
  endDate: string;
} | null;
```

`null` means closed. Setting a value opens the modal; the modal fetches on
mount.

### Click wiring

In `PeriodicSectionRows`, every amount `<td>` for an account row becomes a
`<button>` (or a clickable `<td>` with `role="button"`) when the value is
non-zero. The handler computes:

- For period cells: `startDate` / `endDate` from `reportData.periods[i]`,
  `periodLabel` from `periods[i].label`.
- For the Total column: `startDate` = first period's `startDate`,
  `endDate` = last period's `endDate`, `periodLabel` = the range string
  built from the first and last period labels (e.g.,
  `"Jan 2026 – Apr 2026"`).

The page passes a single `onCellClick(target: DrilldownTarget)` callback
into `PeriodicSectionRows`.

### Modal

**File:** `src/components/reports/TransactionDrilldownModal.tsx`

**Props:**

```ts
interface Props {
  target: DrilldownTarget;
  onClose: () => void;
}
```

**Structure:**

- Backdrop: full-screen `fixed inset-0 bg-black/50`, click closes.
- Panel: centered, max-width ~960px desktop, full-height drawer on small
  screens (`sm:` breakpoint).
- Header: account name (large) + period label (muted) + close (X) button.
- Sub-header: split count and total. The total is rendered with the same
  color rules used by the report (positive = secondary, negative = rose).
  This serves as a sanity check that the modal sum equals the clicked cell.
- Body:
  - **Desktop (≥ `sm:`)**: a 4-column table with sticky header.
    Columns: Date · Description · Account · Amount. Amount is right-
    aligned monospace; Account is muted (`text-foreground-secondary`).
  - **Mobile (< `sm:`)**: a vertical card list. Each row: top line is
    `Date` (left) and `Amount` (right, monospace); description on the
    next line; account name below in `text-xs text-foreground-muted`.
- Each row links to `/accounts/{accountGuid}#tx-{txGuid}` so the user can
  jump to the ledger to edit if needed. The link covers the row.
- Sort: by date descending.

**States:**

- Loading: skeleton rows (5 placeholder rows).
- Error: inline error message with retry button.
- Empty (response with no rows): "No transactions in this period." (This
  shouldn't happen for non-zero cells but handle it defensively.)

**Dismiss:** Esc key, backdrop click, X button. Restore focus to the
clicked cell on close.

**Accessibility:**

- `role="dialog"` and `aria-modal="true"` on the panel.
- Focus moves to the close button on open.
- Each clickable cell is a real `<button>` so it works with keyboard
  navigation and screen readers.

## Data flow

```
user clicks cell
  → page sets DrilldownTarget state
    → modal mounts, calls /api/reports/income-statement-by-period/transactions
      → modal renders rows; total in sub-header equals the clicked cell
        → user clicks row link → /accounts/{guid}#tx-{guid}
        → user presses Esc / clicks X / clicks backdrop → state cleared, modal unmounts
```

## Testing

- Unit test for the API route: account hierarchy resolution (parent vs.
  leaf), date range inclusivity at boundaries, INCOME sign flip, multiple
  splits per transaction in-scope.
- Component test for the modal: loading / error / empty / populated
  states; Esc and backdrop dismiss.
- Manual: click leaf cell, parent cell, Total column. Verify the
  sub-header total matches the clicked cell exactly.

## Files touched

- `src/app/api/reports/income-statement-by-period/transactions/route.ts` — new.
- `src/lib/reports/income-statement-by-period-transactions.ts` — new (query
  and shaping logic, kept out of the route file for testability).
- `src/components/reports/TransactionDrilldownModal.tsx` — new.
- `src/app/(main)/reports/income_statement_by_period/page.tsx` — wire the
  state, pass `onCellClick`, render the modal.
- Tests under `src/lib/reports/__tests__/`.
