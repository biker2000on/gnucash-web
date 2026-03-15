# Ledger Views, Book Management, Bulk Edit & Cost Basis Carry-Over

**Date:** 2026-03-15
**Branch:** New feature branch (TBD)
**Scope:** 5 independent features for GnuCash Web

---

## 1. Currency Selector for New Book

### Problem
The CreateBookWizard uses a manual 3-character text input for currency selection. On first app initialization with an empty database, users must know their currency code. This is error-prone and unfriendly.

### Design
- Replace **both** currency text inputs in `CreateBookWizard.tsx` (template flow and import flow) with a searchable dropdown component
- Add a hardcoded ISO 4217 currency list in `src/lib/currencies.ts` (~160 entries)
  - Format: `{ code: string, name: string }` (e.g., `{ code: "USD", name: "US Dollar" }`)
- Dropdown displays as "USD — US Dollar" format
- Filters as the user types (search by code or name)
- Default selection: from template if using template flow, otherwise USD
- No API needed — the list is static and bundled with the app

### Files to Change
- `src/lib/currencies.ts` — new file, hardcoded ISO 4217 list
- `src/components/CreateBookWizard.tsx` — replace both currency text inputs with searchable dropdown

---

## 2. Book Deletion

### Problem
The book deletion API exists (`DELETE /api/books/[guid]`) but there is no UI to trigger it. Additionally, the API currently prevents deleting the last book.

### Design
- Add a "Delete Book" button in `BookEditorModal.tsx`
  - Red button, bottom-left of the modal, visually separated from Save/Cancel
  - Clicking shows an inline confirmation panel with warning: "This will permanently delete all accounts, transactions, and data in this book. This cannot be undone."
  - Confirmation requires explicit "Yes, Delete" click
- Remove the "last book" guard from `DELETE /api/books/[guid]/route.ts`
- Post-deletion behavior:
  - Close the modal and call a new `onDeleted` callback (added to `BookEditorModal` props)
  - If other books exist: call `setActiveBook()` on the book context to switch to the first available book, then refresh
  - If no books remain: redirect to `CreateBookWizard` to force creation of a new book
- **Concurrency handling**: the delete endpoint should query remaining book count after the delete (within the same database transaction) and return it in the response. The client uses this server-provided count to decide routing — no separate client-side count query needed. This ensures the client always acts on accurate post-delete state, even under concurrent deletes.

### Files to Change
- `src/components/BookEditorModal.tsx` — add delete button, confirmation UI, and `onDeleted` callback
- `src/app/api/books/[guid]/route.ts` — remove last-book guard

---

## 3. Transaction View Modes

### Problem
The account ledger currently only supports a single view mode (Basic Ledger). GnuCash desktop offers three view modes that provide different levels of split visibility: Basic Ledger, Transaction Journal, and Auto-Split.

### 3.1 State & Persistence

- Add `ledgerViewStyle` state to `AccountLedger.tsx`: `'basic' | 'journal' | 'autosplit'`
  - Named `ledgerViewStyle` (not `viewMode`) to distinguish from the existing `defaultLedgerMode` preference which controls edit vs. readonly mode
- Persist as a user preference so it survives page reloads
- View mode applies globally — switching in one account carries to others

### 3.2 View Menu

- New `ViewMenu.tsx` dropdown component in the ledger toolbar
- Contains:
  - View mode radio group (Basic Ledger / Transaction Journal / Auto-Split)
  - Sub-accounts toggle (moved from standalone toolbar button)
  - Unreviewed-only toggle (moved from standalone toolbar button)
- Remove the standalone sub-accounts and unreviewed-only buttons from the toolbar
- Keyboard chords registered via `useKeyboardShortcut()`:
  - `v b` — Basic Ledger
  - `v j` — Transaction Journal
  - `v a` — Auto-Split
- **Chord system update required**: `KeyboardShortcutContext.tsx` currently hardcodes `g` as the only chord prefix. The chord initiation logic (checking `event.key === 'g'` and `s.key.startsWith('g ')`) must be generalized to support arbitrary chord prefixes. Refactor to detect any registered chord prefix key, not just `g`.

### 3.3 Basic Ledger

- Current single-row-per-transaction rendering (no changes to existing behavior)
- **New: expand/collapse toggle per transaction**
  - Small arrow icon (▶/▼) on each transaction row, tree-hierarchy style
  - Clicking expands to show split rows beneath the transaction (same format as Transaction Journal split rows)
  - Multiple transactions can be expanded simultaneously (not accordion)
  - Keyboard shortcuts: Right arrow to expand focused row, Left arrow to collapse
    - **Conflict resolution**: Right/Left arrows are currently used for column navigation (`focusedColumnIndex`). Expand/collapse triggers only when the focused column is the first column (the expand arrow column). In all other columns, Right/Left continue to navigate columns as before.
  - Expanded state is per-transaction, independent

### 3.4 Transaction Journal

Every transaction renders as a **transaction row** + one or more **split rows** beneath it:

- **Transaction row**: date, description, debit/credit of the account's split, running balance
- **Split rows** (indented, all splits including the account's own split):
  - Split memo in the description column; if memo is empty, show blank (no fallback text)
  - Account full path in the transfer column
  - Split debit/credit values in debit/credit columns
  - No balance column on split rows
- The account's own split appears in both the transaction row (summarized) and as a split row (detailed)
- **Edit mode blank row**: when a transaction is focused in edit mode, an extra row appears below its splits:
  - Auto-calculates the remaining imbalance to balance the transaction
  - Pre-fills debit or credit with the balancing amount
  - Updates in real-time as existing split amounts are edited
  - Account selector to choose the target account for the new split
  - Confirming adds the split via the existing transaction update API (`PUT /api/transactions/[guid]`) — no new endpoint needed, the existing API already accepts split modifications
  - Only one blank row at a time — completing it adds the split and shows a new blank row if still imbalanced

### 3.5 Auto-Split

- Default rendering identical to Basic Ledger (single row per transaction)
- When a transaction receives focus (click or keyboard navigation), it expands to show split rows — same format as Transaction Journal
- When focus moves to a different transaction, the previous one collapses
- Edit mode blank row behavior same as Transaction Journal when expanded
- Smooth expand/collapse animation (CSS transition on height)

### 3.6 Data Requirements

- The current API at `/api/accounts/[guid]/transactions` already returns splits per transaction
- Split memo, account name, and values are already in the response
- No API changes needed for rendering; split addition uses existing transaction update API

### Files to Change
- `src/components/AccountLedger.tsx` — view mode state, conditional rendering per mode
- `src/components/ViewMenu.tsx` — new dropdown component
- `src/components/ledger/TransactionRow.tsx` — new component for transaction row rendering (shared across modes)
- `src/components/ledger/SplitRows.tsx` — new component for split row rendering
- `src/components/ledger/BalancingRow.tsx` — new component for edit mode blank balancing row
- `src/components/ledger/EditableRow.tsx` — integrate with view modes
- `src/contexts/UserPreferencesContext.tsx` — add `ledgerViewStyle` preference
- `src/contexts/KeyboardShortcutContext.tsx` — generalize chord prefix system to support `v` prefix in addition to `g`, register `v b`, `v j`, `v a` chords and right/left arrow expand/collapse

---

## 4. Bulk Account Reassignment

### Problem
There is no way to move multiple transactions' splits from one account to another. Users must edit each transaction individually to recategorize.

### Design
- Available in edit mode only, using existing checkbox multi-select (with shift-click support)
- When 1+ transactions are selected, a "Move to Account" button appears in the edit toolbar alongside the existing "Delete" button
- Clicking opens an account picker dialog:
  - Searchable
  - Shows account hierarchy (tree structure)
  - Select target account
- On confirm: for each selected transaction, the split belonging to the current account is reassigned to the target account
- After success: transactions disappear from the current account's ledger, toast confirmation shows count moved

### Split GUID Resolution
- The UI selects transactions via checkboxes (`editSelectedGuids` stores transaction GUIDs)
- Each transaction's `account_split_guid` field identifies the split belonging to the current account
- **Multi-split edge case**: if a transaction has multiple splits in the current account, all of them are moved. The API accepts split GUIDs, and the client resolves transaction GUIDs → split GUIDs by collecting all splits where `account_guid === currentAccountGuid` for each selected transaction.

### API
- New endpoint: `POST /api/splits/bulk/move`
- Request body: `{ splitGuids: string[], targetAccountGuid: string }`
- Validates:
  - Target account exists
  - Target account has the same `commodity_guid` as the splits being moved (same currency — not just same type)
  - Rejects moves to investment/stock accounts or across currencies (these require exchange rate handling which is out of scope)
- Updates `account_guid` on each split

### Files to Change
- `src/app/api/splits/bulk/move/route.ts` — new endpoint
- `src/components/AccountLedger.tsx` — add "Move to Account" button in edit toolbar, split GUID resolution logic
- `src/components/AccountPickerDialog.tsx` — new component (or reuse existing account selector patterns)

---

## 5. Investment Cost Basis Carry-Over

### Problem
When shares are transferred between brokerage accounts (e.g., Fidelity → Schwab), the receiving account shows a cost basis of $0 because it doesn't trace back to the original purchase. Users need accurate cost basis tracking across transfers for tax reporting.

### 5.1 User Preferences

- New preference: `costBasisCarryOver` (boolean, default: `true`)
- New preference: `costBasisMethod` (`'fifo' | 'lifo' | 'average'`, default: `'fifo'`)
  - **FIFO**: earliest purchased shares assigned first
  - **LIFO**: most recently purchased shares assigned first
  - **Average**: total cost / total shares in source account at time of transfer
- Added to the existing user preferences settings UI
- Toggle and method selector apply globally across all investment views

### 5.2 Cost Basis Calculation Logic

New utility: `src/lib/cost-basis.ts`

When computing cost basis for a transfer-in split (shares arrive with no cash exchange):

1. **Check lots**: if the split has a `lot_guid`, find all splits sharing the same `lot_guid` to derive the original purchase price from those splits' values. The `lots` table itself only stores `guid`, `account_guid`, and `is_closed` — actual cost data comes from the associated splits.
2. **Trace transfer chain** (no lots): find the matching transfer-out split in the source account (same transaction, same commodity, opposite quantity sign)
3. From the source account, find original purchase transactions using the selected method:
   - **FIFO**: walk purchases chronologically from earliest, allocating shares until the transferred quantity is covered
   - **LIFO**: walk purchases reverse-chronologically
   - **Average**: `(total cost of all shares in source account at time of transfer) / (total shares in source account at time of transfer)`
4. **Partial transfers**: when only a portion of shares are transferred, the method determines which shares' cost basis is assigned. E.g., FIFO with 50 shares at $10 + 50 shares at $20, transferring 30 shares → cost basis = 30 × $10 = $300
5. **Recursive tracing**: if the source account also received shares via transfer, recurse through the chain until original purchases are found
6. Return per-share cost basis for the transferred shares

### 5.3 Where It Applies

- **Investment ledger** (`AccountLedger.tsx` in investment mode): cost basis column reflects carried-over basis instead of $0 for transfer-in rows
- **Holdings page**: portfolio cost basis totals use the carried-over values
  - `src/components/HoldingsTable.tsx` (or equivalent holdings component)
  - `src/lib/commodities.ts` — `calculateCostBasis()` function needs to integrate with the new cost basis tracing
  - `/api/investments/portfolio/route.ts` — portfolio endpoint needs to use traced cost basis
- **Toggle behavior**: when off, current behavior ($0 for transfers); when on, shows traced historical basis

### 5.4 Performance

- Transfer chain tracing could be expensive for deep chains
- Cache results per commodity per account during a single API request
- Calculation runs server-side in the transaction API, not client-side

### Files to Change
- `src/lib/cost-basis.ts` — new file, cost basis tracing logic with FIFO/LIFO/average and partial transfer handling
- `src/lib/commodities.ts` — integrate `calculateCostBasis()` with new tracing logic
- `src/app/api/accounts/[guid]/transactions/route.ts` — integrate cost basis calculation for investment accounts
- `src/app/api/investments/portfolio/route.ts` — use traced cost basis in portfolio calculations
- `src/components/HoldingsTable.tsx` — display carried-over cost basis
- `src/contexts/UserPreferencesContext.tsx` — add `costBasisCarryOver` and `costBasisMethod` preferences
- User preferences settings UI — add toggle and method selector

---

## Implementation Order & Branching

Each feature gets its own branch, merged independently:

| # | Feature | Branch | Size |
|---|---------|--------|------|
| 1 | Currency selector for new book | `feat/currency-selector` | Small |
| 2 | Book deletion UI | `feat/book-deletion` | Small |
| 3 | Transaction view modes | `feat/ledger-view-modes` | Large |
| 4 | Bulk account reassignment | `feat/bulk-account-move` | Medium |
| 5 | Cost basis carry-over | `feat/cost-basis-carryover` | Medium |

All features are independent and can be implemented/merged in any order. The listed order reflects recommended priority. Features 1 and 2 can be developed in parallel. Feature 3 is the largest and should be merged before feature 4 (which shares the ledger toolbar area).
