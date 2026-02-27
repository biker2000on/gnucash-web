# Review Imported Transactions -- Design

## Summary

Add a review mode to the account ledger for efficiently reviewing imported SimpleFin transactions. The mode transforms the ledger into a GnuCash desktop-style register with always-edit rows, bulk review checkboxes, and keyboard-driven workflows. Also: dedup protection on transaction delete, and SimpleFin balance auto-fill for reconciliation.

## Grid Library

**TanStack Table** (`@tanstack/react-table`) replaces the manual `<table>` + `.map()` rendering in AccountLedger. It's headless (we control all rendering), works with our Tailwind styling, and supports virtual scrolling via `@tanstack/react-virtual`.

We keep all existing components: `AccountSelector`, `DescriptionAutocomplete`, `useDateShortcuts`, `useTaxShortcut`.

## Architecture: Two Modes

AccountLedger has two rendering modes controlled by a toggle:

### Normal Mode (unchanged)

Read-only table rows. Click opens view modal. Enter on a focused row opens inline edit for that single row. TanStack Table provides column definitions but rendering stays visually identical.

### Review Mode (new)

Register-style grid:

- **Always-edit**: The focused row is always editable. Moving focus makes the new row editable and the previous row read-only (auto-saved if dirty).
- **Enter**: Saves current row and advances focus to the next row (which becomes editable).
- **Tab**: Moves between cells: Date -> Description -> Account -> Amount. Tab on last cell saves and wraps to Date of next row.
- **Shift+Tab**: Moves to previous cell.
- **Arrow Up/Down**: Move focus between rows (auto-save if dirty).
- **Ctrl+R**: Mark focused row as reviewed, auto-advance to next unreviewed row.
- **Escape**: Discard unsaved changes, revert row to original values.
- **Checkbox column**: Not in tab index. Click to toggle. Shift+click for range selection (select all rows between last-checked and current). Select-all checkbox in header.
- **Edit button column**: Appears on every row. Opens TransactionFormModal directly in edit mode (skips read-only view).
- **Unreviewed filter**: Automatically enabled when entering review mode.
- **Date cell**: `useDateShortcuts` hook (`+`/`-`/`t`).
- **Amount cell**: `useTaxShortcut` hook, math expression evaluation on blur.
- **Account cell**: `AccountSelector` with portal dropdown, typeahead search, keyboard navigation. Tab selects without changing the value.
- **Description cell**: `DescriptionAutocomplete` with debounced typeahead.

### Multi-split Rows in Review Mode

Multi-split transactions are NOT inline editable (too complex for a single row). They display read-only data with the edit button. Clicking the edit button or pressing Enter opens TransactionFormModal directly in edit mode. The checkbox still works for bulk review.

### Component Structure

```
AccountLedger (state, data fetching, mode toggle)
  -> TanStack Table instance (column defs, row model)
    -> Normal mode: ReadOnlyRow
    -> Review mode: EditableRow (always-edit cells)
       -> DateCell (input + useDateShortcuts)
       -> DescriptionCell (DescriptionAutocomplete)
       -> AccountCell (AccountSelector)
       -> AmountCell (input + useTaxShortcut + math)
       -> CheckboxCell (not in tab index)
       -> EditButtonCell (opens modal)
```

## Dedup Protection on Delete

When deleting an imported transaction, the `gnucash_web_transaction_meta` row is preserved so the `simplefin_transaction_id` stays in the dedup set and the transaction won't be reimported.

### Schema Change

Add `deleted_at TIMESTAMP` column to `gnucash_web_transaction_meta`.

### Delete Flow

1. Delete API checks for a meta row with `simplefin_transaction_id`.
2. If found: NULL out `transaction_guid`, set `deleted_at = NOW()`. Keep the row.
3. If not found (manual transaction): delete normally, no meta row to preserve.
4. Delete the GnuCash transaction and splits as before.

### Sync Dedup

No changes needed. The existing dedup query (`SELECT simplefin_transaction_id FROM gnucash_web_transaction_meta WHERE simplefin_transaction_id = ANY(...)`) will find the preserved meta row and skip reimport.

### Edit Protection

Already works. Editing description/date doesn't touch the meta row, so `simplefin_transaction_id` is preserved.

## SimpleFin Balance for Reconciliation

### Storage

During sync, store the SimpleFin account balance in `gnucash_web_simplefin_account_map`:
- `last_balance DECIMAL` -- SimpleFin `balance` value
- `last_balance_date TIMESTAMP` -- when the balance was fetched

### API

Expose stored balance via `/api/simplefin/status` or a new endpoint, keyed by GnuCash account GUID.

### Reconciliation Auto-fill

When starting reconciliation on a SimpleFin-mapped account, auto-fill the statement balance field with `last_balance`. Show a label: "from SimpleFin, synced Xh ago". User can override.

## Error Handling

- **Auto-save conflicts**: If save fails (409 conflict), row stays focused with red border and toast error. User can Escape to discard or fix and retry.
- **Reconciliation + review mode**: Mutually exclusive. Entering one exits the other.
- **Empty state**: When all transactions are reviewed, show "All caught up!" with session review count.
- **Infinite scroll**: Same as current. Review mode auto-enables `unreviewedOnly` server filter.

## Dependencies

- `@tanstack/react-table` -- headless table library
- `@tanstack/react-virtual` -- virtual scrolling (for large transaction lists)
