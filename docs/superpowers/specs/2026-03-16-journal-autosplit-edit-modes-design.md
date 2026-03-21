# Journal & Auto-Split Edit Modes

## Overview

Add journal and auto-split view modes to edit mode in the account ledger. Currently these view modes only work in read-only mode. In edit mode, all transactions use the "basic" layout with account/debit/credit inputs on the transaction line itself.

The new modes move all value editing to split rows below the transaction line, matching GnuCash desktop behavior. This is additive — the existing basic edit mode is unchanged.

## Behavior by Mode

### Basic Edit (existing, unchanged)
- `EditableRow` renders date, description, account, debit, credit on the transaction line
- Multi-split transactions show "-- N splits --" (read-only, modal to edit)
- No split rows shown

### Journal Edit (new)
- Transaction line: date + description inputs only. Account/debit/credit columns are empty cells.
- All splits always visible as editable rows below every transaction
- Blank placeholder row at the bottom of each transaction's splits

### Auto-Split Edit (new)
- Same slim transaction line as journal edit
- Editable split rows only visible under the focused transaction
- On focus change: auto-save dirty splits, then collapse
- Blank placeholder row at the bottom when splits are visible

## Components

### EditableRow Changes

Receives `ledgerViewStyle` as a prop. When `'journal'` or `'autosplit'`:
- Active row: only `DateCell` and `DescriptionCell` inputs. Debit/credit/account columns render as empty `<td>` elements.
- Inactive row: date and description as static text, empty debit/credit/account cells.
- `focusedColumnIndex` range shrinks from 0-4 to 0-1 (date, description).
- Tab from description calls `onTabToSplits()` callback (coordinated by parent) to move focus to the first split row.
- In journal/autosplit mode, `EditableRow.save()` is not called — the parent handles saves by combining data from both handles. The `EditableRowHandle` is extended with `getTransactionData(): { post_date: string; description: string }` so the parent can read date/description when constructing the save payload.
- Multi-split "-- N splits --" branch is conditional on `ledgerViewStyle === 'basic'`. In journal/autosplit modes, multi-split transactions render the same slim transaction line since all splits are visible below. Modal edit button remains available but outside the tab order (`tabIndex={-1}`).

### New: EditableSplitRows Component

File: `src/components/ledger/EditableSplitRows.tsx`

Parallel to the read-only `SplitRows.tsx`. Renders editable split rows below a transaction line.

**Props:**
- `transaction` — the parent transaction
- `accountGuid` — the current ledger account
- `columns` — total column count for alignment
- `onSplitsChange` — callback when local split state changes (for dirty tracking)
- `isActive` — whether the parent transaction row is focused
- `focusedSplitIndex` — which split row is focused (-1 or undefined = none)
- `onFocusedSplitChange` — callback to update focusedSplitIndex in parent

**Local state:**
- Maintains a local copy of splits (initialized from `transaction.splits`) plus the blank placeholder row
- Tracks dirty state: whether local splits differ from the original transaction splits
- Exposes imperative handle (`EditableSplitRowsHandle`) with:
  - `isDirty(): boolean` — whether any split has unsaved changes
  - `getSplitPayload(): SplitData[]` — returns the current splits (excluding blank row) for save. `SplitData` matches the `CreateTransactionRequest.splits` shape (fraction-based `value_num/value_denom`). The conversion from debit/credit decimal inputs to fractions happens inside `getSplitPayload()`. For same-currency splits, `quantity_num/quantity_denom` equals `value_num/value_denom`.
  - `revert(): void` — reset local splits to original transaction state

**Per-split row:**
All splits are editable, including the current account's own split:
- Leading empty cells (checkbox, expand, reconcile, date) — matching `SplitRows` alignment
- Memo input (text input in description column)
- Account input (`AccountSelector`, same component as current `EditableRow`)
- Debit input (`AmountCell`)
- Credit input (`AmountCell`)
- Delete button (only if >2 real/non-placeholder splits, outside tab order with `tabIndex={-1}`, mouse-only)
- Trailing empty cells (balance, actions)

**Blank/placeholder row:**
- Always the last row in the split list
- Pre-filled imbalance amount: `-(sum of all split values)` in the appropriate debit/credit field. This is the amount needed to balance the transaction. Follows the same pattern as the existing `BalancingRow` component.
- Account field is empty — acts as the entry point
- When the user selects an account, the blank row becomes a real split (with a client-generated GUID via `crypto.randomUUID().replace(/-/g, '')`) and a new blank row appears beneath it
- If the transaction is balanced (imbalance = 0), the blank row shows zero

**Trading splits:**
Auto-generated trading splits from `processMultiCurrencySplits` are not shown in the editable split rows — they are generated server-side during save. Only user-authored splits are displayed and editable.

### AccountLedger Orchestration

The existing `showSplitRows` logic determines visibility per view style. In edit mode with journal/autosplit, renders `EditableSplitRows` instead of read-only `SplitRows`.

**Save payload construction:**
`AccountLedger` owns the save. When focus leaves a transaction:
1. Reads date + description from the `EditableRow` handle (or local state)
2. Reads splits from the `EditableSplitRowsHandle.getSplitPayload()`
3. Constructs a `CreateTransactionRequest` combining both
4. Sends via `PUT /api/transactions/[guid]`

**Dirty aggregation:**
A transaction is dirty if either the `EditableRow` (date/description) OR the `EditableSplitRows` reports dirty. Both expose imperative handles; the parent checks both.

## Focus & Keyboard Navigation

### Two-Level Focus Index

The two-level focus model applies **only in journal/autosplit edit modes**. Basic edit mode continues using the existing `focusedRowIndex` unchanged.

New state (used when `ledgerViewStyle !== 'basic'` and `isEditMode`):
- `focusedTxIndex` — index into `displayTransactions`
- `focusedSplitIndex` — index within the transaction's splits (-1 = transaction line itself, 0+ = split rows, where the last index is the blank placeholder row)

When `ledgerViewStyle === 'basic'`, the existing `focusedRowIndex` is used as-is. A mapping layer converts between the two representations at the boundary (the `handleTableKeyDown` handler branches on view style).

**Column focus within splits:**
When `focusedSplitIndex >= 0`, `focusedColumnIndex` refers to split columns: memo=0, account=1, debit=2, credit=3. When `focusedSplitIndex === -1` (transaction line), `focusedColumnIndex` refers to transaction columns: date=0, description=1.

**Other consumers of `focusedRowIndex`:**
`InlineEditRow` and reconciliation mode are unaffected — they only operate in basic/read-only mode where `focusedRowIndex` is still used.

### Arrow Key Behavior (j/k, Up/Down)

Navigates a flat list of all visible rows — both transaction lines and split rows:
- Down from transaction line → first split row (if splits visible)
- Down through splits → blank row → next transaction line (triggers save check)
- Up reverses the path
- Moving from the last row of one transaction to the next transaction's line triggers the save flow

### Tab Order Within a Transaction

1. Transaction line: Date → Description
2. Tab from description → first split row's memo field
3. Within each split row: Memo → Account → Debit → Credit
4. Tab from last field of a split → next split row's memo
5. Tab from last field of blank row → next transaction's date field (triggers auto-save)

Tabbing past an untouched blank row (no account selected, transaction already balanced) simply advances to the next transaction without triggering save validation.

### Enter Key
- On blank row's account field (after selecting account) → focus moves to blank row's debit/credit field

### Escape
- Blur the current field (same as current edit mode)

### Expand/Collapse (ArrowRight/ArrowLeft)
These shortcuts are for basic view mode only (already guarded by `ledgerViewStyle === 'basic'` check in the existing handler). No change needed — they remain inactive in journal/autosplit modes.

## Save Flow

### Trigger
Focus moves away from a transaction (`focusedTxIndex` changes). Parent checks if the outgoing transaction is dirty (either `EditableRow` or `EditableSplitRows` reports dirty).

### Balanced Transaction (imbalance = 0)
Save immediately via `PUT /api/transactions/[guid]` with the full set of splits.

### Unbalanced Transaction
Show imbalance dialog:
- Message: "Transaction is unbalanced by [amount]. What would you like to do?"
- **Revert** — discard local changes, call `EditableSplitRowsHandle.revert()`, restore to last saved state
- **Continue Editing** — dismiss dialog, return focus to the transaction, cancel the focus move

State: `imbalanceDialogTx: string | null` — transaction GUID. When set, dialog shows and focus changes are blocked.

### Client-Side Validation
Imbalance = sum of all split `value_num / value_denom` across all real (non-placeholder) splits. A balanced transaction sums to zero.

### GUID Generation
New splits get client-side generated GUIDs via `crypto.randomUUID().replace(/-/g, '')` — same pattern used by the `n` (new transaction) shortcut. These GUIDs are sent to the API to keep client and server state in sync across eager saves.

### New Transactions
The `n` shortcut creates a blank transaction with pre-generated GUIDs. In journal/autosplit mode, the blank transaction starts with one split for the current account (with zero amount) and the blank placeholder row. Save uses `PUT` (same as existing behavior — the `n` shortcut already creates the transaction via the existing POST flow, then subsequent saves use PUT).

## API Changes

### PUT /api/transactions/[guid]

Single change to the split creation loop:

- Each split in the request payload can optionally include a `guid` field
- If `guid` is provided, use it instead of calling `generateGuid()`
- If `guid` is omitted, generate one server-side (backward compatible)
- Validate client-provided GUIDs are 32-char hex strings matching GnuCash format. Return 400 with an error message on validation failure.

The existing delete-all-and-recreate flow, multi-currency trading split processing, optimistic locking, and audit logging are all unchanged.

No changes to POST (new transactions) or other endpoints.

## What's NOT Changing

- Basic edit mode — fully unchanged
- Read-only view modes (basic, journal, autosplit) — unchanged
- `InlineEditRow` (single transaction edit in view mode) — unchanged
- `InvestmentEditRow` — unchanged (investment accounts continue using their own edit component)
- Transaction form modal — still available for complex edits
- Bulk operations (move, delete, review) — unchanged
- Reconciliation mode — unchanged
- `focusedRowIndex` in basic edit mode — unchanged
