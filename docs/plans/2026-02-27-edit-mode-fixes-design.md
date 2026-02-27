# Edit Mode Fixes & Enhancements -- Design

## Summary

Fix broken review mode behavior, rename it to "Edit Mode", overhaul the date field app-wide, fix AccountSelector bugs, add keyboard column persistence, add bulk delete, add SimpleFin indicators to account hierarchy, and add user preferences for date format and default ledger mode.

## 1. Date Field Overhaul (app-wide)

### Problem

`input[type="date"]` creates multiple internal tab stops (month → day → year → calendar icon), so Tab doesn't move to the next field as expected. Arrow keys change the date value instead of navigating rows. The calendar icon is in the tab index.

### Solution

Replace `input[type="date"]` with `input[type="text"]` everywhere.

**Display behavior:**
- Shows the date in the user's preferred format (default: MM/DD/YYYY)
- Stored internally as ISO YYYY-MM-DD
- On focus: text is selected for easy replacement
- On blur: parses the typed value and reformats to display format
- Parsing accepts multiple formats: MM/DD/YYYY, YYYY-MM-DD, M/D/YY, etc.

**Calendar icon:**
- Remains next to the field as a clickable button
- `tabIndex={-1}` -- not in the tab order
- Click opens a date picker popover (lightweight -- a simple month grid)

**Keyboard shortcuts (unchanged):**
- `+` / `=`: increment date by 1 day
- `-`: decrement date by 1 day
- `t` / `T`: set to today

**Arrow keys in edit mode:**
- ArrowUp/ArrowDown do NOT alter the date
- Instead they bubble up to the row navigation handler: save current row, move to adjacent row (same column)

**Affected components:**
- `src/components/ledger/cells/DateCell.tsx` -- edit mode cell
- `src/lib/hooks/useDateShortcuts.ts` -- shortcut hook (remove arrow key date changing if present)
- `src/components/TransactionForm.tsx` -- modal form date field
- `src/components/InlineEditRow.tsx` -- inline edit date field
- Any other `input[type="date"]` in the codebase

## 2. AccountSelector Fixes (app-wide)

### 2a. Hide Book Name

`formatAccountPath()` currently strips the "Root Account:" prefix. It must also strip the book name segment. The book name is the first segment after root removal.

Example: "Root Account:My Book:Assets:Checking" → currently "My Book:Assets:Checking" → should be "Assets:Checking".

Detection: The first segment is a book name if it matches the root account's direct child. Query the accounts list for `account_type === 'ROOT'` children, or use the book name from the app context. Simpler approach: the API already strips "Root Account:" -- additionally strip the first colon-separated segment since that's always the book-level account (Assets, Liabilities, etc. are children of the book, not the book itself).

Actually, the real structure is: Root Account → Book Name → Asset Types (Assets, Liabilities, Income, Expense, Equity). So "Root Account:My Book:Assets:Checking" after stripping "Root Account:" becomes "My Book:Assets:Checking". We need to also strip "My Book:" to get "Assets:Checking".

Implementation: Fetch the book name (already available via `getActiveBookRootGuid()` pattern) and strip it as a prefix alongside "Root Account:".

### 2b. Don't Open Dropdown on Focus

Current behavior: `handleInputFocus()` calls `setIsOpen(true)` immediately. This opens the dropdown and scrolls to the selected account, which is slow for large account lists.

New behavior:
- On focus: show the selected account name as text, select it (so typing replaces it). Do NOT open the dropdown.
- On keystroke (typing): open the dropdown with filtered results.
- On ArrowDown when closed: open the dropdown and set focusedIndex.
- On Tab with dropdown closed: move to next field without opening dropdown.

### 2c. Fix Arrow Key Navigation in Filtered List

Bug: The `useEffect` on `[search, isOpen, value, flatOptions]` resets `focusedIndex` to 0 whenever `flatOptions` changes. Since `flatOptions` is derived from `groupedAccounts` via `useMemo`, every search keystroke rebuilds it with a new reference, resetting the focused index.

Fix: Track search changes separately. Only reset `focusedIndex` to 0 when the `search` string actually changes (length changes or content changes). Don't reset when the user presses ArrowDown/ArrowUp -- those should only be driven by the keydown handler.

### 2d. Applies to All Modals

Since `TransactionForm`, `TransactionFormModal`, `AccountForm`, and all other forms use the same `AccountSelector` component, these fixes apply automatically everywhere -- modals, inline edit, edit mode cells.

## 3. Edit Mode (Rename + Expand)

### Rename

"Review Mode" → "Edit Mode" throughout the codebase:
- Button label: "Edit Mode" / "Exit Edit Mode"
- State variable: `isReviewMode` → `isEditMode`
- CSS classes: keep cyan accent color (already used)

### Decouple Unreviewed Filter

Currently entering review mode auto-enables `showUnreviewedOnly`. Change:
- The two toggles are independent. Entering edit mode does NOT change the unreviewed filter state.
- Both toggles are visible and functional regardless of mode.
- The "Show Unreviewed" filter works in both read-only and edit mode.

### Click to Activate Row

In edit mode, clicking a row sets it as the active (editable) row:
- Currently clicking in review mode does nothing special (no click handler on the `EditableRow` `<tr>`)
- Add `onClick` to each `EditableRow` `<tr>` that sets `focusedRowIndex` to that row's index
- Don't trigger on checkbox or button clicks (same guard as normal mode)

### Bulk Delete

Add a "Delete Selected (N)" button next to "Mark Reviewed (N)" in the bulk actions bar:
- Only visible when `reviewSelectedGuids.size > 0`
- Click opens a confirmation dialog: "Delete N selected transactions? This cannot be undone."
- On confirm: DELETE each selected transaction via API, refresh list
- Dedup-protected transactions (SimpleFin-imported) have their meta row preserved (existing behavior from the delete API)

### User Preference: Default Mode

New preference `defaultLedgerMode`:
- Values: `"readonly"` (default), `"edit"`
- On AccountLedger mount, initialize `isEditMode` from this preference
- Setting accessible in the user preferences / settings page

## 4. Keyboard Navigation Fixes

### Enter from Any Field

Currently Enter only works from the table-level `handleTableKeyDown` when focus is NOT in an input field. When the user is typing in a date/description/account/amount cell, Enter does nothing (or submits a form).

Fix: Each cell component handles Enter keydown:
- `DateCell`: Enter → call `onEnter()` callback (parent saves + advances)
- `DescriptionCell`: Enter → call `onEnter()` callback
- `AccountCell`: Enter when dropdown is open → select item (existing). Enter when dropdown is closed → call `onEnter()` callback
- `AmountCell`: Enter → evaluate math expression if present, then call `onEnter()` callback

The parent (`EditableRow`) passes an `onEnter` prop that triggers save + advance to next row.

### Column Persistence

Track `focusedColumnIndex` (0=date, 1=description, 2=account, 3=amount) alongside `focusedRowIndex`.

When navigating rows (Enter, ArrowUp/ArrowDown):
- The new active row focuses the same column as the previous row
- `EditableRow` receives `focusedColumn` prop and auto-focuses the matching cell

When navigating cells (Tab/Shift+Tab):
- Tab moves focusedColumnIndex forward (0→1→2→3)
- Tab from last column (amount): save, advance to next row, focus column 0 (date)
- Shift+Tab moves backward
- Shift+Tab from first column (date): move to previous row, focus column 3 (amount)

### Arrow Keys Move Rows

In edit mode, ArrowUp/ArrowDown in any cell:
- Save current row if dirty
- Move to adjacent row (same column)
- Each cell component handles ArrowUp/ArrowDown by calling `onArrowUp()`/`onArrowDown()` callbacks
- Exception: AccountSelector dropdown open → ArrowUp/Down navigate the dropdown (existing behavior). Only bubble to row navigation when dropdown is closed.

## 5. Account Hierarchy SimpleFin Indicator

### API

New endpoint or extended query: for each account in the hierarchy, return:
- `hasSimpleFin: boolean` -- whether this account has a mapping in `gnucash_web_simplefin_account_map`
- `unreviewedCount: number` -- count of transactions with `reviewed = false` in `gnucash_web_transaction_meta`

Implementation: Join `gnucash_web_simplefin_account_map` on `gnucash_account_guid` and aggregate unreviewed counts from `gnucash_web_transaction_meta` where `reviewed = false` and `deleted_at IS NULL` and `transaction_guid IS NOT NULL`.

This can be a separate endpoint (`/api/accounts/review-status`) that returns a map of `{ [accountGuid]: { hasSimpleFin, unreviewedCount } }`, fetched once by AccountHierarchy.

### Visual Indicator

On each AccountNode row:
- **SimpleFin icon**: Small sync/link SVG icon (subtle, foreground-muted color) next to account name, visible when `hasSimpleFin === true`
- **Unreviewed badge**: Amber pill badge showing count (e.g., "3") when `unreviewedCount > 0`. Positioned after the SimpleFin icon.

### Filter

Add a "To Review" toggle button in the AccountHierarchy toolbar (alongside "Show Hidden"):
- When active: only shows accounts where `unreviewedCount > 0` (and their parent chain for tree structure)
- Filter works with recursive `hasMatch` pattern already used for text filtering
- Badge: amber background, like the existing "Show Unreviewed" button styling

## 6. User Preferences Additions

Two new preferences in `gnucash_web_user_preferences`:

| Key | Values | Default |
|-----|--------|---------|
| `dateFormat` | `MM/DD/YYYY`, `YYYY-MM-DD`, `MM-DD-YYYY` | `MM/DD/YYYY` |
| `defaultLedgerMode` | `readonly`, `edit` | `readonly` |

Exposed via existing `GET/PUT /api/user/preferences` endpoints.

Consumed in `UserPreferencesContext` alongside existing preferences (`balanceReversal`, `defaultTaxRate`, etc.).

Settings page (`/settings`) gets two new fields in the preferences section.

## Dependencies

No new npm packages needed. All fixes use existing libraries:
- `@tanstack/react-table` (already installed)
- Existing `AccountSelector`, `useDateShortcuts`, `UserPreferencesContext`

## Component Impact Summary

| Component | Changes |
|-----------|---------|
| `DateCell` | Replace `input[type="date"]` with text input + calendar button, add `onEnter`/`onArrowUp`/`onArrowDown` |
| `DescriptionCell` | Add `onEnter`/`onArrowUp`/`onArrowDown` |
| `AccountCell` | Add `onEnter`/`onArrowUp`/`onArrowDown` |
| `AmountCell` | Add `onEnter`/`onArrowUp`/`onArrowDown` |
| `EditableRow` | Add click handler, `focusedColumn` prop, `onEnter`/arrow callbacks, bulk delete |
| `AccountLedger` | Rename review→edit, add `focusedColumnIndex`, decouple unreviewed filter, click-to-activate, bulk delete, default mode preference |
| `AccountSelector` | Hide book name, lazy dropdown open, fix arrow nav |
| `useDateShortcuts` | Remove arrow key date changes, keep +/-/t |
| `TransactionForm` | Replace date input |
| `InlineEditRow` | Replace date input |
| `AccountHierarchy` | Add SimpleFin icons, unreviewed badges, "To Review" filter |
| `UserPreferencesContext` | Add `dateFormat`, `defaultLedgerMode` |
| Settings page | Add date format + default mode dropdowns |
