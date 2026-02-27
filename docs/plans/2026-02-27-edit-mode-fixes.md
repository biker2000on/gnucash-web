# Edit Mode Fixes & Enhancements -- Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken review mode behavior, rename to "Edit Mode", overhaul date fields app-wide, fix AccountSelector bugs, add keyboard column persistence, add bulk delete, add SimpleFin indicators to account hierarchy, and add user preferences for date format and default ledger mode.

**Architecture:** Incremental refactor across 6 independent phases. Each phase produces a shippable, testable increment. Phases 1, 2, 3, 5 run in parallel. Phase 4 depends on 1+3. Phase 6 depends on 1+3.

**Tech Stack:** Next.js 16, React 19, TypeScript, TanStack Table, Prisma (raw SQL for extension tables)

---

## RALPLAN-DR Summary

### Principles
1. **Keyboard-first interaction** -- Every edit-mode action achievable without a mouse. Tab order: one stop per column.
2. **Preserve existing behavior** -- Read-only mode, reconciliation, and modal workflows must not regress.
3. **Incremental delivery** -- Each phase produces a shippable, testable increment.
4. **Component isolation** -- Cell components own their keyboard events and delegate row-level actions via callbacks.
5. **Single source of truth for preferences** -- `UserPreferencesContext` is canonical for all user prefs.

### Decision Drivers
1. Date input usability -- `input[type="date"]` creates 3-4 internal tab stops, breaking Tab flow.
2. Edit mode completeness -- Cannot navigate rows with Enter from inputs, no click-to-activate, lose column position.
3. Discoverability -- "Review Mode" name confusing; no visibility into which accounts need review.

### Recommended: Option A -- Incremental Refactor
Fix each concern as independent phases. Smallest blast radius; easy to review; parallel-safe; any phase can ship alone.

---

## Keyboard Event Ownership Table

This defines who handles each key in each context. "Handles" means `preventDefault()` + `stopPropagation()`.

| Key | Cell w/ dropdown OPEN | Cell w/ dropdown CLOSED | Cell w/o dropdown (Date, Amount) | No input focused (table-level) |
|-----|----------------------|------------------------|----------------------------------|-------------------------------|
| **Enter** | Dropdown: select item, close | Cell: `onEnter()` → save + advance row | Cell: `onEnter()` → save + advance row | Table: save row, advance |
| **ArrowUp** | Dropdown: move focus up | Cell: `onArrowUp()` → save + row up | Cell: `onArrowUp()` → save + row up | Table: `focusedRowIndex--` |
| **ArrowDown** | Dropdown: move focus down | Cell: open dropdown | Cell: `onArrowDown()` → save + row down | Table: `focusedRowIndex++` |
| **Tab** | Dropdown: select item, browser advance | Browser: advance focus | Browser: advance focus | N/A |
| **Escape** | Dropdown: close, keep cell | Cell: blur, deselect row | Cell: blur, deselect row | Table: deselect row |
| **Ctrl+R** | Pass to parent | Parent: toggle reviewed | Parent: toggle reviewed | Table: toggle reviewed |

---

## Phase 1: Date Field Overhaul (11 tasks)

**Goal:** Replace ALL `input[type="date"]` with `input[type="text"]` + display/parse logic. Single tab stop per field.

**Dependencies:** None.

### Complete `type="date"` Inventory

| # | File | Line | Treatment |
|---|------|------|-----------|
| 1 | `src/components/ledger/cells/DateCell.tsx` | 22 | Full overhaul: text input, display format, parse on blur, shortcuts, `onEnter`/`onArrowUp`/`onArrowDown` |
| 2 | `src/components/InlineEditRow.tsx` | 146 | Full overhaul: text input, display format, parse on blur, shortcuts |
| 3 | `src/components/TransactionForm.tsx` | 669 | Full overhaul: text input, display format, parse on blur |
| 4 | `src/components/InvestmentTransactionForm.tsx` | 648 | Full overhaul: text input, display format, parse on blur |
| 5 | `src/components/InvestmentAccount.tsx` | 721 | Text conversion: text input, parse/format on blur |
| 6 | `src/components/ReconciliationPanel.tsx` | 130 | Text conversion: text input, parse/format on blur |
| 7 | `src/components/assets/DepreciationScheduleForm.tsx` | 192 | Text conversion: text input, parse/format on blur |
| 8 | `src/components/assets/AssetDetailView.tsx` | 271 | Text conversion: text input, parse/format on blur |
| 9 | `src/components/reports/ReportFilters.tsx` | 113 | Text conversion: text input, parse/format on blur |
| 10 | `src/components/reports/ReportFilters.tsx` | 124 | Text conversion: text input, parse/format on blur |
| 11 | `src/components/ui/DateRangePicker.tsx` | 119 | Text conversion: text input, parse/format on blur |
| 12 | `src/components/ui/DateRangePicker.tsx` | 126 | Text conversion: text input, parse/format on blur |

**Calendar popover: DEFERRED.** Out of scope. Users enter dates via text + shortcuts (+/-/t). Calendar icon is removed for now.

**`useDateShortcuts`**: No changes needed. Verified it only handles +/-/t (no arrow keys).

### Task 1.1: Create date formatting/parsing utility

**Files:**
- Create: `src/lib/date-format.ts`

**Step 1: Create the utility**

```typescript
export type DateFormat = 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'MM-DD-YYYY';

export function formatDateForDisplay(isoDate: string, format: DateFormat): string {
    const [y, m, d] = isoDate.split('-');
    switch (format) {
        case 'MM/DD/YYYY': return `${m}/${d}/${y}`;
        case 'MM-DD-YYYY': return `${m}-${d}-${y}`;
        case 'YYYY-MM-DD': return isoDate;
    }
}

export function parseDateInput(input: string, preferredFormat?: DateFormat): string | null {
    // Try preferred format first, then fallbacks
    // Returns YYYY-MM-DD or null
    // Handles: MM/DD/YYYY, YYYY-MM-DD, M/D/YY, M/D/YYYY, MM-DD-YYYY
    // 2-digit years assume 2000s
    // Validates real dates (rejects Feb 30 etc.)
}
```

**Step 2: Verify** -- test `parseDateInput('2/3/25')` → `'2025-02-03'`, `parseDateInput('gibberish')` → `null`.

### Task 1.2: Rewrite DateCell to text input

**Files:**
- Modify: `src/components/ledger/cells/DateCell.tsx`

**Changes:**
- Replace `input type="date"` with `input type="text"`
- Import `formatDateForDisplay`, `parseDateInput` from `@/lib/date-format`
- Import `useUserPreferences` to get `dateFormat` (default `'MM/DD/YYYY'`)
- Local `displayValue` state: `formatDateForDisplay(value, dateFormat)`
- On focus: `ref.current?.select()`
- On blur: parse `displayValue`, if valid call `onChange(parsedIso)`, else revert
- Add `onEnter`, `onArrowUp`, `onArrowDown` optional callback props
- Wire in onKeyDown: Enter → `onEnter?.()`, ArrowUp → `onArrowUp?.()`, ArrowDown → `onArrowDown?.()` (all with `preventDefault`)

### Task 1.3-1.11: Replace remaining date inputs

For each of the remaining 10 files (InlineEditRow, TransactionForm, InvestmentTransactionForm, InvestmentAccount, ReconciliationPanel, DepreciationScheduleForm, AssetDetailView, ReportFilters x2, DateRangePicker x2):

- Replace `type="date"` with `type="text"`
- Add `displayValue` state formatted from the ISO value
- On focus: select all text
- On blur: parse via `parseDateInput()`, update state if valid, revert if not
- For data-entry forms (InlineEditRow, TransactionForm, InvestmentTransactionForm): also wire `useDateShortcuts`

**Commit:** `refactor: replace all type="date" inputs with text-based date fields`

---

## Phase 2: AccountSelector Fixes (8 tasks)

**Goal:** Fix book name stripping, lazy dropdown open, and arrow key navigation reset.

**Dependencies:** None.

### Task 2.1: Consolidate formatAccountPath

**Files:**
- Create: `src/lib/account-utils.ts`
- Modify: `src/components/ui/AccountSelector.tsx` (remove local copy)

Extract `formatAccountPath` to a shared utility. Strip book name using `BookContext`:

```typescript
export function formatAccountPath(fullname: string | undefined, name: string, bookName?: string): string {
    let path = fullname || name;
    if (path.startsWith('Root Account:')) path = path.substring('Root Account:'.length);
    if (bookName && path.startsWith(bookName + ':')) path = path.substring(bookName.length + 1);
    return path;
}
```

### Task 2.2: Don't open dropdown on focus

**Files:**
- Modify: `src/components/ui/AccountSelector.tsx`

- `handleInputFocus`: remove `setIsOpen(true)`. Instead: `setSearch(''); inputRef.current?.select()`
- `onChange` handler: if user types and `!isOpen`, call `setIsOpen(true)` (already does this)
- ArrowDown when closed: already opens dropdown

### Task 2.3: Memoize filteredAccounts

**Files:**
- Modify: `src/components/ui/AccountSelector.tsx`

```typescript
const filteredAccounts = useMemo(() =>
    accounts.filter(account => {
        if (account.account_type === 'ROOT') return false;
        const searchLower = search.toLowerCase();
        const displayName = formatAccountPath(account.fullname, account.name, bookName);
        return displayName.toLowerCase().includes(searchLower) ||
            account.account_type.toLowerCase().includes(searchLower);
    }),
    [accounts, search, bookName]
);
```

### Task 2.4: Memoize groupedAccounts

```typescript
const groupedAccounts = useMemo(() =>
    filteredAccounts.reduce((acc, account) => {
        const type = account.account_type;
        if (!acc[type]) acc[type] = [];
        acc[type].push(account);
        return acc;
    }, {} as Record<string, Account[]>),
    [filteredAccounts]
);
```

### Task 2.5: Fix focusedIndex reset

Change the useEffect dependency from `[search, isOpen, value, flatOptions]` to `[search, isOpen]`:

```typescript
useEffect(() => {
    if (isOpen) {
        if (!search && value) {
            const idx = flatOptions.findIndex(a => a.guid === value);
            setFocusedIndex(idx >= 0 ? idx : 0);
        } else {
            setFocusedIndex(0);
        }
    }
}, [search, isOpen]);
```

### Task 2.6: Add onEnter/onArrowUp/onArrowDown props

Add to `AccountSelectorProps`:
- `onEnter?: () => void`
- `onArrowUp?: () => void`
- `onArrowDown?: () => void`

In `handleKeyDown`, when `!isOpen`:
- Enter → `onEnter?.(); e.preventDefault()`
- ArrowUp → `onArrowUp?.(); e.preventDefault()`

### Task 2.7: Add autoFocus prop

Add `autoFocus?: boolean` to props. useEffect: if `autoFocus`, `inputRef.current?.focus()`.

### Task 2.8: Verify

Verify build passes. Test: focus selector → no dropdown. Type → dropdown opens. ArrowDown 3 times → stays at index 3.

**Commit:** `fix: AccountSelector -- hide book name, lazy dropdown, memoize, fix focusedIndex`

---

## Phase 3: Edit Mode Rename + Expand (6 tasks)

**Goal:** Rename review mode, decouple filter, add click-to-activate, add bulk delete.

**Dependencies:** None. MUST MERGE before Phases 4 and 6 start.

### Task 3.1: Rename isReviewMode → isEditMode

**Files:**
- Modify: `src/components/AccountLedger.tsx`
- Modify: `src/components/ledger/columns.tsx`
- Modify: `src/components/ledger/types.ts`

Global find-replace: `isReviewMode` → `isEditMode`, `Review Mode` → `Edit Mode`, `handleToggleReviewMode` → `handleToggleEditMode`, `reviewSelectedGuids` → `editSelectedGuids`, `reviewedCount` → `editReviewedCount`.

### Task 3.2: Decouple unreviewed filter

**Files:**
- Modify: `src/components/AccountLedger.tsx`

In `handleToggleEditMode`: remove `setShowUnreviewedOnly(true)`. Both toggles operate independently.

### Task 3.3: Click-to-activate row

**Files:**
- Modify: `src/components/ledger/EditableRow.tsx`
- Modify: `src/components/AccountLedger.tsx`

Add `onClick?: () => void` prop to `EditableRow`. On all `<tr>` elements, add onClick handler with guard for checkbox/button/input targets. Parent passes `onClick={() => setFocusedRowIndex(index)}`.

### Task 3.4: Bulk delete button

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- Add `bulkDeleteConfirmOpen` state
- Add `handleBulkDelete` callback: DELETE each selected via existing `/api/transactions/[guid]`, refresh, toast
- Add "Delete Selected (N)" button (rose color) in toolbar next to "Mark Reviewed"
- Add ConfirmationDialog for bulk delete

### Task 3.5: Default ledger mode preference

**Files:**
- Modify: `src/contexts/UserPreferencesContext.tsx`
- Modify: `src/app/api/user/preferences/route.ts`
- Modify: `src/components/AccountLedger.tsx`

Add `defaultLedgerMode: 'readonly' | 'edit'` to context. Initialize `isEditMode` from preference on mount.

### Task 3.6: Verify

Build passes. UI shows "Edit Mode" / "Exit Edit Mode". Entering edit mode doesn't change unreviewed filter. Click activates row. Bulk delete works.

**Commit:** `feat: rename to Edit Mode, decouple filter, click-to-activate, bulk delete`

---

## Phase 4: Keyboard Navigation Fixes (9 tasks)

**Goal:** Enter saves from inputs, column persistence across rows, arrow keys move rows.

**Dependencies:** Phase 1 (DateCell props) + Phase 3 (rename landed/merged).

### Task 4.1: Add callbacks to DateCell

Already done in Task 1.2: `onEnter`, `onArrowUp`, `onArrowDown` props.

### Task 4.2: Add callbacks + autoFocus to DescriptionCell

**Files:**
- Modify: `src/components/ledger/cells/DescriptionCell.tsx`
- Modify: `src/components/ui/DescriptionAutocomplete.tsx`

Add `onEnter`, `onArrowUp`, `onArrowDown`, `autoFocus` props to both.

In `DescriptionAutocomplete.handleKeyDown`:
- If dropdown OPEN: existing behavior (navigate/select in dropdown)
- If dropdown CLOSED and Enter: `onEnter?.(); e.preventDefault()`
- If dropdown CLOSED and ArrowUp/ArrowDown: `onArrowUp?.()`/`onArrowDown?.(); e.preventDefault()`

### Task 4.3: Add callbacks to AccountCell

**Files:**
- Modify: `src/components/ledger/cells/AccountCell.tsx`

Add `onEnter`, `onArrowUp`, `onArrowDown`, `autoFocus` props. Pass through to AccountSelector (already has them from Phase 2).

### Task 4.4: Add callbacks to AmountCell

**Files:**
- Modify: `src/components/ledger/cells/AmountCell.tsx`

Add `onEnter`, `onArrowUp`, `onArrowDown` props. On Enter: evaluate math if present, then `onEnter?.()`. On ArrowUp/Down: call respective callbacks.

### Task 4.5: Add focusedColumnIndex to AccountLedger

**Files:**
- Modify: `src/components/AccountLedger.tsx`

Add `const [focusedColumnIndex, setFocusedColumnIndex] = useState(0)`. Pass as `focusedColumn` to EditableRow.

### Task 4.6: Wire focusedColumn in EditableRow

**Files:**
- Modify: `src/components/ledger/EditableRow.tsx`

Add `focusedColumn?: number`, `onEnter`, `onArrowUp`, `onArrowDown` props.

Active row: pass `autoFocus={focusedColumn === N}` to each cell (0=date, 1=description, 2=account, 3=amount). Pass `onEnter`/`onArrowUp`/`onArrowDown` to each cell.

### Task 4.7: Column focus tracking

Each cell reports focus to parent via `onColumnFocus` callback:
- DateCell focus → `setFocusedColumnIndex(0)`
- DescriptionCell focus → `setFocusedColumnIndex(1)`
- AccountCell focus → `setFocusedColumnIndex(2)`
- AmountCell focus → `setFocusedColumnIndex(3)`

Tab wrapping: Tab from amount (col 3) → save row, advance to next row col 0. Shift+Tab from date (col 0) → previous row col 3.

### Task 4.8: Update handleTableKeyDown

In edit mode, when focus IS in an input: do NOT handle Enter/ArrowUp/ArrowDown (cells handle via callbacks). Keep Ctrl+R and Escape handling.

### Task 4.9: Verify

Enter from description → saves + advances (same column). ArrowDown from amount → next row's amount. Tab wraps correctly. Dropdown captures keys when open.

**Commit:** `feat: keyboard navigation -- Enter from inputs, column persistence, arrow row movement`

---

## Phase 5: Account Hierarchy SimpleFin Indicators (7 tasks)

**Goal:** Show SimpleFin icons and unreviewed count badges. Add "To Review" filter.

**Dependencies:** None. Fully independent.

### Task 5.1: Create review-status API endpoint

**Files:**
- Create: `src/app/api/accounts/review-status/route.ts`

**IMPORTANT: Must use `prisma.$queryRaw`** -- the `gnucash_web_simplefin_account_map` and `gnucash_web_transaction_meta` tables are NOT in the Prisma schema.

```sql
-- SimpleFin mappings
SELECT gnucash_account_guid FROM gnucash_web_simplefin_account_map
WHERE gnucash_account_guid IS NOT NULL;

-- Unreviewed counts per account
SELECT s.account_guid, COUNT(DISTINCT m.transaction_guid) as unreviewed_count
FROM gnucash_web_transaction_meta m
JOIN splits s ON s.tx_guid = m.transaction_guid
WHERE m.reviewed = false
  AND m.deleted_at IS NULL
  AND m.transaction_guid IS NOT NULL
GROUP BY s.account_guid;
```

Returns: `{ [accountGuid]: { hasSimpleFin: boolean, unreviewedCount: number } }`

### Task 5.2: Create useReviewStatus hook

**Files:**
- Create: `src/lib/hooks/useReviewStatus.ts`

React Query hook fetching `/api/accounts/review-status`. Stale time: 30s.

### Task 5.3: Client-side aggregation

Add function in AccountHierarchy to aggregate unreviewed counts up the tree:

```typescript
function aggregateUnreviewed(account: AccountWithChildren, statusMap: ReviewStatusMap): number {
    let count = statusMap[account.guid]?.unreviewedCount || 0;
    for (const child of account.children) {
        count += aggregateUnreviewed(child, statusMap);
    }
    return count;
}
```

Parent nodes display aggregated count. Matches existing `getAggregatedBalances` pattern.

### Task 5.4: Add SimpleFin sync icon

Small SVG sync icon next to account name when `hasSimpleFin === true`. Color: `text-foreground-muted`.

### Task 5.5: Add unreviewed badge

Amber pill badge showing aggregated count when > 0:
```
<span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold">3</span>
```

### Task 5.6: Add "To Review" filter

Toggle button in toolbar. When active, only shows accounts with aggregated unreviewedCount > 0 (preserving parent chain). Persisted to localStorage.

### Task 5.7: Verify

Icons appear. Badges show correct aggregated counts. Filter works. Build passes.

**Commit:** `feat: SimpleFin indicators and unreviewed badges in account hierarchy`

---

## Phase 6: User Preferences (8 tasks)

**Goal:** Add dateFormat and defaultLedgerMode preferences.

**Dependencies:** Phase 1 (dateFormat consumed by DateCell) + Phase 3 (defaultLedgerMode consumed by AccountLedger).

### Task 6.1-6.2: Add to UserPreferencesContext

Add `dateFormat: DateFormat` (default `'MM/DD/YYYY'`) and `defaultLedgerMode: 'readonly' | 'edit'` (default `'readonly'`). State, setter, localStorage cache, API persist -- same pattern as `balanceReversal`.

### Task 6.3-6.4: Update preferences API

GET returns new fields. PATCH accepts and validates them.

### Task 6.5-6.6: Settings page UI

Date format dropdown (MM/DD/YYYY, YYYY-MM-DD, MM-DD-YYYY). Default ledger mode dropdown (Read-only, Edit Mode).

### Task 6.7: Wire dateFormat into all date text inputs

DateCell and all other date text inputs read `dateFormat` from `useUserPreferences()`.

### Task 6.8: Wire defaultLedgerMode into AccountLedger

Initialize `isEditMode` state from `defaultLedgerMode` preference on mount.

**Commit:** `feat: user preferences for date format and default ledger mode`

---

## Dependency Graph

```
Phase 1 (Date) ──────┐
Phase 2 (Selector)    ├──→ Phase 4 (Keyboard) ──→ Phase 6 (Prefs)
Phase 3 (Edit Mode) ──┘
Phase 5 (Hierarchy) ─────────── (independent, runs anytime)
```

**Phase 3 has a MERGE GATE**: must be merged to working branch before Phases 4 and 6 start.

## Success Criteria

1. Zero `type="date"` inputs in the codebase
2. All date fields display in user-configurable format, parse multiple formats
3. AccountSelector: no book name, no dropdown on focus, stable arrow navigation
4. Edit mode: independent of unreviewed filter, click-to-activate, bulk delete works
5. Keyboard: Enter/Arrow from any cell works, column persists, Tab wraps, dropdowns capture keys when open
6. Account hierarchy: SimpleFin icons, aggregated unreviewed badges, "To Review" filter
7. User preferences: date format + default ledger mode configurable and persisted
8. `npm run build` passes with zero errors
