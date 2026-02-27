# Review Imported Transactions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a register-style review mode to the account ledger with TanStack Table, dedup protection on delete, and SimpleFin balance auto-fill for reconciliation.

**Architecture:** TanStack Table (`@tanstack/react-table`) replaces the manual table rendering in AccountLedger. Two modes: normal (current behavior via TanStack column defs) and review (always-edit register with checkboxes, keyboard-driven workflow). Dedup protection preserves meta rows on delete. SimpleFin balance stored during sync and auto-fills reconciliation.

**Tech Stack:** @tanstack/react-table, @tanstack/react-virtual, React 19, TypeScript, Prisma raw SQL, PostgreSQL

**Design Doc:** `docs/plans/2026-02-26-review-imported-transactions-design.md`

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install TanStack Table and Virtual**

Run:
```bash
npm install @tanstack/react-table @tanstack/react-virtual
```

**Step 2: Verify installation**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @tanstack/react-table and @tanstack/react-virtual"
```

---

## Task 2: Schema Migrations

Add `deleted_at` to `gnucash_web_transaction_meta` and `last_balance`/`last_balance_date` to `gnucash_web_simplefin_account_map`.

**Files:**
- Modify: `src/lib/db-init.ts:265-277` (transaction meta DDL)
- Modify: `src/lib/db-init.ts:356-374` (account map DDL)

**Step 1: Add `deleted_at` column to transaction meta**

In `src/lib/db-init.ts`, find the `transactionMetaTableDDL` block (line 265). After the existing DDL and indexes, add an ALTER TABLE migration:

```ts
// After line 277 (after the idx_txn_meta_simplefin_id index), add:
const transactionMetaAddDeletedAtDDL = `
    ALTER TABLE gnucash_web_transaction_meta
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
`;
```

Then find where the DDL statements are executed (look for the `$executeRawUnsafe` calls that run these DDLs) and add:
```ts
await prisma.$executeRawUnsafe(transactionMetaAddDeletedAtDDL);
```

**Step 2: Add `last_balance` columns to account map**

After the existing `simpleFinAccountMapAddInvestmentDDL` (line 371), add:

```ts
const simpleFinAccountMapAddBalanceDDL = `
    ALTER TABLE gnucash_web_simplefin_account_map
    ADD COLUMN IF NOT EXISTS last_balance DECIMAL,
    ADD COLUMN IF NOT EXISTS last_balance_date TIMESTAMP;
`;
```

And execute it alongside the other DDLs.

**Step 3: Verify migrations run**

Run: `npm run dev` (triggers `initializeDatabase()` on startup)
Check server logs for no SQL errors.

**Step 4: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "schema: add deleted_at to transaction_meta and last_balance to account_map"
```

---

## Task 3: Dedup Protection on Delete

When deleting a SimpleFin-imported transaction, preserve the meta row so the `simplefin_transaction_id` stays in the dedup set.

**Files:**
- Modify: `src/app/api/transactions/[guid]/route.ts:294-352` (DELETE handler)

**Step 1: Modify DELETE handler to preserve meta rows**

In the DELETE handler (line 294), before the Prisma transaction block (line 316), add logic to check for and preserve the meta row:

```ts
// After line 313 (after existingTx null check), add:

// Preserve meta row for SimpleFin transactions to prevent reimport
await prisma.$executeRaw`
    UPDATE gnucash_web_transaction_meta
    SET transaction_guid = NULL, deleted_at = NOW()
    WHERE transaction_guid = ${guid}
      AND simplefin_transaction_id IS NOT NULL
`;

// Clean up meta rows for non-SimpleFin transactions
await prisma.$executeRaw`
    DELETE FROM gnucash_web_transaction_meta
    WHERE transaction_guid = ${guid}
      AND simplefin_transaction_id IS NULL
`;
```

**Important:** This must run BEFORE the Prisma `$transaction` block that deletes splits and the transaction (line 316), because after deletion the `transaction_guid` won't be found.

Also, we need to drop the `NOT NULL` constraint on `transaction_guid` since we're now NULLing it out. Add a migration in `db-init.ts`:

```ts
const transactionMetaNullableGuidDDL = `
    ALTER TABLE gnucash_web_transaction_meta
    ALTER COLUMN transaction_guid DROP NOT NULL;
`;
```

And keep the UNIQUE constraint (NULL values are unique in PostgreSQL, so multiple NULLed rows won't conflict).

**Step 2: Verify the existing dedup query in sync still works**

Check `src/lib/services/simplefin-sync.service.ts:147-154`. The dedup query is:
```sql
SELECT meta.simplefin_transaction_id
FROM gnucash_web_transaction_meta meta
WHERE meta.simplefin_transaction_id IS NOT NULL
  AND meta.source = 'simplefin'
```

This query does NOT filter by `transaction_guid IS NOT NULL`, so preserved meta rows (with NULLed `transaction_guid`) will still be found. No changes needed to the sync service.

**Step 3: Also update the `unreviewedOnly` query in the account transactions API**

In `src/app/api/accounts/[guid]/transactions/route.ts`, the `unreviewedOnly` filter joins meta with splits:
```sql
SELECT m.transaction_guid
FROM gnucash_web_transaction_meta m
JOIN splits s ON s.tx_guid = m.transaction_guid
WHERE s.account_guid = ${accountGuid} AND m.reviewed = false
```

Since `m.transaction_guid` is NULLed for deleted transactions, the JOIN on `s.tx_guid = m.transaction_guid` will naturally exclude them (NULL doesn't match anything in a JOIN). No changes needed.

**Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/app/api/transactions/[guid]/route.ts src/lib/db-init.ts
git commit -m "fix: preserve SimpleFin meta rows on transaction delete to prevent reimport"
```

---

## Task 4: Store SimpleFin Balance During Sync

**Files:**
- Modify: `src/lib/services/simplefin-sync.service.ts` (after per-account sync, update balance)

**Step 1: Update account map balance after syncing each account**

In `simplefin-sync.service.ts`, find the per-account loop (look for `for (const mappedAccount of mappedAccounts)`). At the END of each account's sync iteration (after all transactions are imported), add:

```ts
// Update last synced balance from SimpleFin
if (sfAccount.balance !== undefined) {
    await prisma.$executeRaw`
        UPDATE gnucash_web_simplefin_account_map
        SET last_balance = ${parseFloat(sfAccount.balance)},
            last_balance_date = NOW(),
            last_sync_at = NOW()
        WHERE id = ${mappedAccount.id}
    `;
}
```

The `sfAccount` variable is the `SimpleFinAccount` object which has a `balance: string` field (defined in `simplefin.service.ts:91`).

**Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts
git commit -m "feat: store SimpleFin account balance during sync for reconciliation"
```

---

## Task 5: SimpleFin Balance API Endpoint

**Files:**
- Modify: `src/app/api/simplefin/status/route.ts` (add balance to response)

**Step 1: Add balance data to the status endpoint**

The existing `/api/simplefin/status` route already returns connection info and mapped accounts. Modify it to also return the stored balance for each mapped account.

In the query that fetches mapped accounts, ensure `last_balance` and `last_balance_date` are included in the result. The status route likely queries `gnucash_web_simplefin_account_map` -- add those columns to the SELECT.

Add a new endpoint or extend the existing one so the account page can fetch the SimpleFin balance for a specific GnuCash account GUID:

Create `src/app/api/simplefin/balance/[accountGuid]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ accountGuid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { accountGuid } = await params;

        const result = await prisma.$queryRaw<{
            last_balance: number | null;
            last_balance_date: Date | null;
        }[]>`
            SELECT last_balance, last_balance_date
            FROM gnucash_web_simplefin_account_map
            WHERE gnucash_account_guid = ${accountGuid}
              AND last_balance IS NOT NULL
            LIMIT 1
        `;

        if (result.length === 0) {
            return NextResponse.json({ hasBalance: false });
        }

        return NextResponse.json({
            hasBalance: true,
            balance: Number(result[0].last_balance),
            balanceDate: result[0].last_balance_date,
        });
    } catch (error) {
        console.error('Error fetching SimpleFin balance:', error);
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/app/api/simplefin/balance/
git commit -m "feat: add SimpleFin balance API endpoint for reconciliation auto-fill"
```

---

## Task 6: ReconciliationPanel Auto-fill

**Files:**
- Modify: `src/components/ReconciliationPanel.tsx:6-19` (add prop), `src/components/ReconciliationPanel.tsx:33` (use balance)
- Modify: `src/components/AccountLedger.tsx` (fetch and pass SimpleFin balance)
- Modify: `src/app/(main)/accounts/[guid]/page.tsx` (pass accountGuid to AccountLedger for balance fetch)

**Step 1: Add `simpleFinBalance` prop to ReconciliationPanel**

In `ReconciliationPanel.tsx`, add to the props interface (line 6):

```ts
interface ReconciliationPanelProps {
    accountGuid: string;
    accountCurrency: string;
    currentBalance: number;
    selectedBalance: number;
    simpleFinBalance?: { balance: number; balanceDate: string } | null; // NEW
    onReconcileComplete?: () => void;
    // ... rest unchanged
}
```

Destructure in the function signature (line 21):
```ts
export function ReconciliationPanel({
    accountCurrency,
    currentBalance,
    selectedBalance,
    simpleFinBalance, // NEW
    onReconcileComplete,
    // ...
})
```

**Step 2: Auto-fill statement balance when reconciliation starts**

Add a `useEffect` that sets `statementBalance` when `isReconciling` becomes true and `simpleFinBalance` is available:

```ts
useEffect(() => {
    if (isReconciling && simpleFinBalance && !statementBalance) {
        setStatementBalance(simpleFinBalance.balance.toFixed(2));
    }
}, [isReconciling, simpleFinBalance]);
```

**Step 3: Show SimpleFin balance source label**

After the statement balance input (line 138), add:

```tsx
{simpleFinBalance && (
    <p className="text-[10px] text-foreground-muted mt-1">
        from SimpleFin, synced {new Date(simpleFinBalance.balanceDate).toLocaleDateString()}
    </p>
)}
```

**Step 4: Fetch SimpleFin balance in AccountLedger**

In `AccountLedger.tsx`, add state and fetch:

```ts
const [simpleFinBalance, setSimpleFinBalance] = useState<{ balance: number; balanceDate: string } | null>(null);

useEffect(() => {
    fetch(`/api/simplefin/balance/${accountGuid}`)
        .then(res => res.json())
        .then(data => {
            if (data.hasBalance) {
                setSimpleFinBalance({ balance: data.balance, balanceDate: data.balanceDate });
            }
        })
        .catch(() => {}); // silently fail -- not all accounts have SimpleFin
}, [accountGuid]);
```

Pass it to ReconciliationPanel:
```tsx
<ReconciliationPanel
    // ... existing props
    simpleFinBalance={simpleFinBalance}
/>
```

**Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src/components/ReconciliationPanel.tsx src/components/AccountLedger.tsx
git commit -m "feat: auto-fill reconciliation statement balance from SimpleFin"
```

---

## Task 7: TanStack Table Column Definitions

Set up the TanStack Table instance and column definitions for normal mode. This task creates the foundation; the next task swaps rendering.

**Files:**
- Create: `src/components/ledger/columns.tsx` (column definitions)
- Create: `src/components/ledger/types.ts` (shared types)

**Step 1: Create shared types**

Create `src/components/ledger/types.ts`:

```ts
import { AccountTransaction } from '../AccountLedger';

export interface LedgerMeta {
    accountGuid: string;
    accountType: string;
    isReconciling: boolean;
    isReviewMode: boolean;
    focusedRowIndex: number;
    editingGuid: string | null;
    balanceReversal: string;
}

export type { AccountTransaction };
```

**Step 2: Create column definitions**

Create `src/components/ledger/columns.tsx`. Define columns using `createColumnHelper<AccountTransaction>()`:

```tsx
import { createColumnHelper, ColumnDef } from '@tanstack/react-table';
import { AccountTransaction } from './types';

const columnHelper = createColumnHelper<AccountTransaction>();

export function getColumns(meta: {
    accountGuid: string;
    isReconciling: boolean;
    isReviewMode: boolean;
}): ColumnDef<AccountTransaction, any>[] {
    const columns: ColumnDef<AccountTransaction, any>[] = [];

    // Checkbox column (reconciliation or review mode)
    if (meta.isReconciling || meta.isReviewMode) {
        columns.push(
            columnHelper.display({
                id: 'select',
                header: 'select',
                size: 40,
            })
        );
    }

    // Reconcile state
    columns.push(
        columnHelper.accessor('account_split_reconcile_state', {
            id: 'reconcile',
            header: 'R',
            size: 40,
        })
    );

    // Date
    columns.push(
        columnHelper.accessor('post_date', {
            id: 'date',
            header: 'Date',
        })
    );

    // Description
    columns.push(
        columnHelper.accessor('description', {
            id: 'description',
            header: 'Description',
        })
    );

    // Transfer / Splits
    columns.push(
        columnHelper.display({
            id: 'transfer',
            header: 'Transfer / Splits',
        })
    );

    // Amount
    columns.push(
        columnHelper.accessor('account_split_value', {
            id: 'amount',
            header: 'Amount',
        })
    );

    // Balance
    columns.push(
        columnHelper.accessor('running_balance', {
            id: 'balance',
            header: 'Balance',
        })
    );

    // Edit button (review mode)
    if (meta.isReviewMode) {
        columns.push(
            columnHelper.display({
                id: 'actions',
                header: '',
                size: 40,
            })
        );
    }

    return columns;
}
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds (files created but not yet imported)

**Step 4: Commit**

```bash
git add src/components/ledger/
git commit -m "feat: add TanStack Table column definitions for account ledger"
```

---

## Task 8: Migrate AccountLedger Normal Mode to TanStack Table

Replace the manual `<table>` rendering in AccountLedger with TanStack Table while keeping the visual output identical.

**Files:**
- Modify: `src/components/AccountLedger.tsx` (replace table rendering)

**Step 1: Add TanStack Table imports and instance**

At the top of `AccountLedger.tsx`, add:

```ts
import {
    useReactTable,
    getCoreRowModel,
    flexRender,
} from '@tanstack/react-table';
import { getColumns } from './ledger/columns';
```

Inside the component, after the existing state declarations, create the table instance:

```ts
const columns = useMemo(() => getColumns({
    accountGuid,
    isReconciling,
    isReviewMode: false, // will be wired up in review mode task
}), [accountGuid, isReconciling]);

const table = useReactTable({
    data: displayTransactions,
    columns,
    getCoreRowModel: getCoreRowModel(),
});
```

**Step 2: Replace the `<table>` rendering**

Replace the `<table ref={tableRef}>` block (the `<thead>` and `<tbody>` with `.map()`) with TanStack Table's `flexRender` pattern. The visual output should be identical -- same class names, same conditional rendering, same expand/collapse, same inline edit row.

The key mapping:
- `table.getHeaderGroups()` -> `<thead>` rows
- `table.getRowModel().rows` -> `<tbody>` rows
- Each row's `row.getVisibleCells()` -> `<td>` cells
- Custom cell rendering uses `flexRender(cell.column.columnDef.cell, cell.getContext())`

For the normal mode, the cell renderers reproduce the exact existing rendering logic (date formatting, description with badges, splits display, amount coloring, balance coloring). The existing `InlineEditRow` integration stays the same (when `editingGuid === tx.guid`, render `<InlineEditRow>` instead of the normal row).

**Important:** Keep `tableRef` on the `<table>` element for keyboard scroll-into-view. Keep the `loader` ref div below the table.

**Step 3: Verify visual parity**

Run: `npm run dev`
Navigate to an account page. Verify:
- Table looks identical to before
- Inline edit (Enter) works
- Keyboard navigation (j/k/arrows) works
- Reconciliation checkboxes work
- Expand/collapse multi-split rows works
- Infinite scroll works
- Show Unreviewed toggle works

**Step 4: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "refactor: migrate AccountLedger to TanStack Table for normal mode"
```

---

## Task 9: Review Mode Toggle and State

Add the review mode toggle button and state management.

**Files:**
- Modify: `src/components/AccountLedger.tsx` (add toggle, state, mutual exclusivity)

**Step 1: Add review mode state**

```ts
const [isReviewMode, setIsReviewMode] = useState(false);
const [reviewedCount, setReviewedCount] = useState(0); // session counter for empty state
```

**Step 2: Add mutual exclusivity with reconciliation**

```ts
const handleToggleReviewMode = useCallback(() => {
    setIsReviewMode(prev => {
        const next = !prev;
        if (next) {
            // Entering review mode: exit reconciliation, enable unreviewed filter
            setIsReconciling(false);
            setSelectedSplits(new Set());
            setShowUnreviewedOnly(true);
        }
        return next;
    });
}, []);

// Also modify onStartReconcile to exit review mode:
const handleStartReconcile = useCallback(() => {
    setIsReviewMode(false);
    setIsReconciling(true);
}, []);
```

**Step 3: Add review mode toggle button**

In the top bar (near the existing "Show Unreviewed Only" button), add:

```tsx
<button
    onClick={handleToggleReviewMode}
    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
        isReviewMode
            ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
            : 'border-border text-foreground-muted hover:text-foreground'
    }`}
>
    {isReviewMode ? 'Exit Review Mode' : 'Review Mode'}
</button>
```

**Step 4: Update column definitions to use review mode**

Update the `getColumns` call:
```ts
const columns = useMemo(() => getColumns({
    accountGuid,
    isReconciling,
    isReviewMode,
}), [accountGuid, isReconciling, isReviewMode]);
```

**Step 5: Verify build and test toggle**

Run: `npm run dev`
Verify: Toggle button appears, clicking it activates/deactivates. Entering review mode exits reconciliation. Entering reconciliation exits review mode.

**Step 6: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add review mode toggle with reconciliation mutual exclusivity"
```

---

## Task 10: Editable Cell Components

Create the individual cell editor components reusing existing hooks and components.

**Files:**
- Create: `src/components/ledger/cells/DateCell.tsx`
- Create: `src/components/ledger/cells/DescriptionCell.tsx`
- Create: `src/components/ledger/cells/AccountCell.tsx`
- Create: `src/components/ledger/cells/AmountCell.tsx`

**Step 1: DateCell**

```tsx
'use client';
import { useRef, useEffect } from 'react';
import { useDateShortcuts } from '@/lib/hooks/useDateShortcuts';

interface DateCellProps {
    value: string;
    onChange: (value: string) => void;
    autoFocus?: boolean;
}

export function DateCell({ value, onChange, autoFocus }: DateCellProps) {
    const ref = useRef<HTMLInputElement>(null);
    const { handleDateKeyDown } = useDateShortcuts(value, onChange);

    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);

    return (
        <input
            ref={ref}
            type="date"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleDateKeyDown}
            className="w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-cyan-500/50 font-mono"
        />
    );
}
```

**Step 2: DescriptionCell**

```tsx
'use client';
import { DescriptionAutocomplete } from '@/components/ui/DescriptionAutocomplete';

interface DescriptionCellProps {
    value: string;
    onChange: (value: string) => void;
    onSelectSuggestion?: (suggestion: { accountGuid?: string; amount?: string }) => void;
}

export function DescriptionCell({ value, onChange, onSelectSuggestion }: DescriptionCellProps) {
    return (
        <DescriptionAutocomplete
            value={value}
            onChange={onChange}
            onSelectSuggestion={onSelectSuggestion}
            placeholder="Description..."
            className="text-sm"
        />
    );
}
```

**Step 3: AccountCell**

```tsx
'use client';
import { AccountSelector } from '@/components/ui/AccountSelector';

interface AccountCellProps {
    value: string;
    onChange: (guid: string) => void;
}

export function AccountCell({ value, onChange }: AccountCellProps) {
    return (
        <AccountSelector
            value={value}
            onChange={(guid) => onChange(guid)}
            placeholder="Account..."
        />
    );
}
```

**Step 4: AmountCell**

```tsx
'use client';
import { useRef, useEffect } from 'react';
import { useTaxShortcut } from '@/lib/hooks/useTaxShortcut';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useToast } from '@/contexts/ToastContext';
import { evaluateMathExpression, containsMathExpression } from '@/lib/math-eval';

interface AmountCellProps {
    value: string;
    onChange: (value: string) => void;
    autoFocus?: boolean;
}

export function AmountCell({ value, onChange, autoFocus }: AmountCellProps) {
    const ref = useRef<HTMLInputElement>(null);
    const { defaultTaxRate } = useUserPreferences();
    const { success } = useToast();
    const { applyTax } = useTaxShortcut(value, defaultTaxRate, onChange, (msg) => success(msg));

    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            applyTax();
        }
    };

    const handleBlur = () => {
        const result = evaluateMathExpression(value);
        if (result !== null) {
            onChange(result.toFixed(2));
        }
    };

    return (
        <div className="relative">
            <input
                ref={ref}
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                placeholder="0.00"
                className="w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-cyan-500/50 font-mono"
            />
            {containsMathExpression(value) && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
            )}
        </div>
    );
}
```

**Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src/components/ledger/cells/
git commit -m "feat: add editable cell components for review mode (Date, Description, Account, Amount)"
```

---

## Task 11: EditableRow Component

The always-edit row used in review mode. Manages per-row edit state and auto-save.

**Files:**
- Create: `src/components/ledger/EditableRow.tsx`

**Step 1: Create EditableRow**

This component wraps the cell editors and manages the row's edit state. It receives the transaction data and callbacks for save/review.

Key behaviors:
- Initializes cell values from the transaction
- Tracks dirty state (any field changed from original)
- Exposes `save()` method via `useImperativeHandle` so the parent can trigger auto-save
- Calls `onSave` with changed data when saving
- For multi-split transactions, renders read-only with an edit button instead

```tsx
'use client';
import { useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { AccountTransaction } from '@/components/AccountLedger';
import { DateCell } from './cells/DateCell';
import { DescriptionCell } from './cells/DescriptionCell';
import { AccountCell } from './cells/AccountCell';
import { AmountCell } from './cells/AmountCell';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

export interface EditableRowHandle {
    save: () => Promise<boolean>; // returns true if saved successfully
    isDirty: () => boolean;
}

interface EditableRowProps {
    transaction: AccountTransaction;
    accountGuid: string;
    accountType: string;
    isActive: boolean; // true = currently focused/editable
    showCheckbox: boolean;
    isChecked: boolean;
    onToggleCheck: () => void;
    onSave: (guid: string, data: {
        post_date: string;
        description: string;
        accountGuid: string;
        amount: string;
        original_enter_date?: string;
    }) => Promise<void>;
    onEditModal: (guid: string) => void;
    columnCount: number;
}

export const EditableRow = forwardRef<EditableRowHandle, EditableRowProps>(
    function EditableRow({
        transaction,
        accountGuid,
        accountType,
        isActive,
        showCheckbox,
        isChecked,
        onToggleCheck,
        onSave,
        onEditModal,
    }, ref) {
        const { balanceReversal } = useUserPreferences();
        const isMultiSplit = (transaction.splits?.length || 0) > 2;
        const accountSplit = transaction.splits?.find(s => s.account_guid === accountGuid);
        const otherSplit = transaction.splits?.find(s => s.account_guid !== accountGuid);

        const [postDate, setPostDate] = useState(
            transaction.post_date ? new Date(transaction.post_date).toISOString().split('T')[0] : ''
        );
        const [description, setDescription] = useState(transaction.description || '');
        const [otherAccountGuid, setOtherAccountGuid] = useState(otherSplit?.account_guid || '');
        const [amount, setAmount] = useState(
            Math.abs(parseFloat(transaction.account_split_value)).toFixed(2)
        );
        const [saveError, setSaveError] = useState(false);

        const originalEnterDate = transaction.enter_date
            ? new Date(transaction.enter_date).toISOString()
            : undefined;

        const isDirty = useCallback(() => {
            const origDate = transaction.post_date ? new Date(transaction.post_date).toISOString().split('T')[0] : '';
            return postDate !== origDate
                || description !== (transaction.description || '')
                || otherAccountGuid !== (otherSplit?.account_guid || '')
                || amount !== Math.abs(parseFloat(transaction.account_split_value)).toFixed(2);
        }, [postDate, description, otherAccountGuid, amount, transaction, otherSplit]);

        const save = useCallback(async (): Promise<boolean> => {
            if (!isDirty()) return true;
            if (!description.trim() || !otherAccountGuid || !amount || parseFloat(amount) <= 0) return false;
            try {
                setSaveError(false);
                await onSave(transaction.guid, {
                    post_date: postDate,
                    description: description.trim(),
                    accountGuid: otherAccountGuid,
                    amount,
                    original_enter_date: originalEnterDate,
                });
                return true;
            } catch {
                setSaveError(true);
                return false;
            }
        }, [isDirty, description, otherAccountGuid, amount, postDate, transaction.guid, originalEnterDate, onSave]);

        useImperativeHandle(ref, () => ({ save, isDirty }), [save, isDirty]);

        const reconcileState = transaction.account_split_reconcile_state;
        const reconcileIcon = reconcileState === 'y' ? 'Y' : reconcileState === 'c' ? 'C' : 'N';
        const balanceValue = transaction.running_balance
            ? applyBalanceReversal(parseFloat(transaction.running_balance), accountType, balanceReversal)
            : null;

        const rowClass = `transition-colors ${isActive ? 'ring-2 ring-cyan-500/30 ring-inset bg-cyan-500/5' : 'hover:bg-white/[0.02]'} ${saveError ? 'ring-2 ring-rose-500/50 ring-inset' : ''} ${transaction.reviewed === false ? 'border-l-2 border-l-amber-500' : ''}`;

        // Multi-split: read-only with edit button
        if (isMultiSplit) {
            const otherSplits = transaction.splits?.filter(s => s.account_guid !== accountGuid) || [];
            return (
                <tr className={rowClass}>
                    {showCheckbox && (
                        <td className="px-4 py-4 align-top">
                            <input type="checkbox" checked={isChecked} onChange={onToggleCheck} tabIndex={-1}
                                className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-cyan-500 focus:ring-cyan-500/50 cursor-pointer" />
                        </td>
                    )}
                    <td className="px-4 py-4 align-top">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">{reconcileIcon}</span>
                    </td>
                    <td className="px-6 py-4 text-xs text-foreground-secondary font-mono">{new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}</td>
                    <td className="px-6 py-4 text-sm text-foreground">
                        <span className="font-medium">{transaction.description}</span>
                        {transaction.source && transaction.source !== 'manual' && (
                            <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider font-bold">Imported</span>
                        )}
                    </td>
                    <td className="px-6 py-4 text-sm text-foreground-muted italic text-xs">-- {otherSplits.length + 1} splits --</td>
                    <td className={`px-6 py-4 text-sm font-mono text-right ${parseFloat(transaction.account_split_value) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {formatCurrency(transaction.account_split_value, transaction.commodity_mnemonic)}
                    </td>
                    <td className={`px-6 py-4 text-sm font-mono text-right font-bold ${balanceValue !== null && balanceValue < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '—'}
                    </td>
                    <td className="px-2 py-4 align-top">
                        <button onClick={() => onEditModal(transaction.guid)} className="text-foreground-muted hover:text-cyan-400 transition-colors" title="Edit splits">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                    </td>
                </tr>
            );
        }

        // 2-split: editable when active, read-only when not
        if (!isActive) {
            return (
                <tr className={rowClass}>
                    {showCheckbox && (
                        <td className="px-4 py-4 align-top">
                            <input type="checkbox" checked={isChecked} onChange={onToggleCheck} tabIndex={-1}
                                className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-cyan-500 focus:ring-cyan-500/50 cursor-pointer" />
                        </td>
                    )}
                    <td className="px-4 py-4 align-top">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">{reconcileIcon}</span>
                    </td>
                    <td className="px-6 py-4 text-xs text-foreground-secondary font-mono">{new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}</td>
                    <td className="px-6 py-4 text-sm text-foreground font-medium">{transaction.description}</td>
                    <td className="px-6 py-4 text-sm text-foreground-secondary">{otherSplit?.account_name || ''}</td>
                    <td className={`px-6 py-4 text-sm font-mono text-right ${parseFloat(transaction.account_split_value) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {formatCurrency(transaction.account_split_value, transaction.commodity_mnemonic)}
                    </td>
                    <td className={`px-6 py-4 text-sm font-mono text-right font-bold ${balanceValue !== null && balanceValue < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '—'}
                    </td>
                    <td className="px-2 py-4 align-top">
                        <button onClick={() => onEditModal(transaction.guid)} className="text-foreground-muted hover:text-cyan-400 transition-colors" title="Edit">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                    </td>
                </tr>
            );
        }

        // Active editable row
        return (
            <tr className={rowClass}>
                {showCheckbox && (
                    <td className="px-4 py-2 align-middle">
                        <input type="checkbox" checked={isChecked} onChange={onToggleCheck} tabIndex={-1}
                            className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-cyan-500 focus:ring-cyan-500/50 cursor-pointer" />
                    </td>
                )}
                <td className="px-4 py-2 align-middle">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">{reconcileIcon}</span>
                </td>
                <td className="px-2 py-2 align-middle">
                    <DateCell value={postDate} onChange={setPostDate} autoFocus />
                </td>
                <td className="px-2 py-2 align-middle">
                    <DescriptionCell value={description} onChange={setDescription} />
                </td>
                <td className="px-2 py-2 align-middle">
                    <AccountCell value={otherAccountGuid} onChange={setOtherAccountGuid} />
                </td>
                <td className="px-2 py-2 align-middle">
                    <AmountCell value={amount} onChange={setAmount} />
                </td>
                <td className="px-6 py-2 text-sm font-mono text-right align-middle opacity-40">
                    {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '—'}
                </td>
                <td className="px-2 py-2 align-middle">
                    <button onClick={() => onEditModal(transaction.guid)} className="text-foreground-muted hover:text-cyan-400 transition-colors" title="Edit">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                    </button>
                </td>
            </tr>
        );
    }
);
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/ledger/EditableRow.tsx
git commit -m "feat: add EditableRow component with always-edit behavior for review mode"
```

---

## Task 12: Review Mode Rendering in AccountLedger

Wire up the review mode rendering using EditableRow, replacing normal rows when review mode is active.

**Files:**
- Modify: `src/components/AccountLedger.tsx` (review mode tbody rendering)

**Step 1: Import EditableRow and add refs**

```ts
import { EditableRow, EditableRowHandle } from './ledger/EditableRow';
```

Add a ref map to track editable row handles:
```ts
const editableRowRefs = useRef<Map<string, EditableRowHandle>>(new Map());
```

**Step 2: Add review mode checkbox state**

Reuse the existing `selectedSplits` Set pattern but scoped to review mode. Add:

```ts
const [reviewSelectedGuids, setReviewSelectedGuids] = useState<Set<string>>(new Set());
const [lastCheckedIndex, setLastCheckedIndex] = useState<number | null>(null);
```

Checkbox toggle with shift+click range selection:
```ts
const handleReviewCheckToggle = useCallback((index: number, guid: string, shiftKey: boolean) => {
    setReviewSelectedGuids(prev => {
        const next = new Set(prev);
        if (shiftKey && lastCheckedIndex !== null) {
            const start = Math.min(lastCheckedIndex, index);
            const end = Math.max(lastCheckedIndex, index);
            for (let i = start; i <= end; i++) {
                next.add(displayTransactions[i].guid);
            }
        } else {
            if (next.has(guid)) {
                next.delete(guid);
            } else {
                next.add(guid);
            }
        }
        return next;
    });
    setLastCheckedIndex(index);
}, [lastCheckedIndex, displayTransactions]);
```

Select all:
```ts
const handleSelectAllReview = useCallback(() => {
    const allGuids = new Set(displayTransactions.map(tx => tx.guid));
    setReviewSelectedGuids(allGuids);
}, [displayTransactions]);
```

**Step 3: Review mode tbody rendering**

In the table body rendering, when `isReviewMode` is true, render `EditableRow` components instead of the normal rows:

```tsx
{isReviewMode ? (
    displayTransactions.map((tx, index) => (
        <EditableRow
            key={tx.guid}
            ref={(handle) => {
                if (handle) editableRowRefs.current.set(tx.guid, handle);
                else editableRowRefs.current.delete(tx.guid);
            }}
            transaction={tx}
            accountGuid={accountGuid}
            accountType={accountType}
            isActive={index === focusedRowIndex}
            showCheckbox={true}
            isChecked={reviewSelectedGuids.has(tx.guid)}
            onToggleCheck={() => handleReviewCheckToggle(index, tx.guid, false)}
            onSave={handleInlineSave}
            onEditModal={handleEditDirect}
            columnCount={8}
        />
    ))
) : (
    // ... existing normal mode rendering
)}
```

Add `handleEditDirect` that opens TransactionFormModal directly:
```ts
const handleEditDirect = useCallback((guid: string) => {
    const tx = transactions.find(t => t.guid === guid);
    setEditingTransaction(tx || null);
    setIsEditModalOpen(true);
}, [transactions]);
```

**Step 4: Verify build and test**

Run: `npm run dev`
Verify: Toggle review mode, rows render with edit button and checkboxes, active row is editable.

**Step 5: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: wire review mode rendering with EditableRow and checkbox selection"
```

---

## Task 13: Review Mode Keyboard Navigation

Add the full keyboard navigation for review mode: Enter saves+advances, arrow keys move between rows, Ctrl+R marks reviewed, Escape discards.

**Files:**
- Modify: `src/components/AccountLedger.tsx` (keyboard handler for review mode)

**Step 1: Modify the keyboard handler**

In the `handleTableKeyDown` callback, add review mode-specific behavior:

```ts
const handleTableKeyDown = useCallback(async (e: KeyboardEvent) => {
    if (isEditModalOpen || isViewModalOpen || deleteConfirmOpen) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        // In review mode, still handle Ctrl+R and Escape even in input fields
        if (isReviewMode) {
            if (e.key === 'r' && e.ctrlKey) {
                e.preventDefault();
                if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                    const tx = displayTransactions[focusedRowIndex];
                    await toggleReviewed(tx.guid);
                    setReviewedCount(prev => prev + 1);
                    // Auto-advance to next row
                    if (focusedRowIndex < displayTransactions.length - 1) {
                        // First auto-save current row if dirty
                        const handle = editableRowRefs.current.get(tx.guid);
                        if (handle?.isDirty()) await handle.save();
                        setFocusedRowIndex(prev => prev + 1);
                    }
                }
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                // Escape in an input field: just blur the input, don't exit review mode
                (e.target as HTMLElement).blur();
                return;
            }
        }
        return; // Let input fields handle other keys normally
    }

    if (isReviewMode) {
        switch (e.key) {
            case 'ArrowDown':
            case 'j': {
                e.preventDefault();
                if (focusedRowIndex >= 0) {
                    const currentTx = displayTransactions[focusedRowIndex];
                    const handle = editableRowRefs.current.get(currentTx.guid);
                    if (handle?.isDirty()) await handle.save();
                }
                setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                break;
            }
            case 'ArrowUp':
            case 'k': {
                e.preventDefault();
                if (focusedRowIndex >= 0) {
                    const currentTx = displayTransactions[focusedRowIndex];
                    const handle = editableRowRefs.current.get(currentTx.guid);
                    if (handle?.isDirty()) await handle.save();
                }
                setFocusedRowIndex(i => Math.max(i - 1, 0));
                break;
            }
            case 'Enter': {
                e.preventDefault();
                if (focusedRowIndex >= 0) {
                    const currentTx = displayTransactions[focusedRowIndex];
                    const isMultiSplit = (currentTx.splits?.length || 0) > 2;
                    if (isMultiSplit) {
                        handleEditDirect(currentTx.guid);
                    } else {
                        const handle = editableRowRefs.current.get(currentTx.guid);
                        const saved = await handle?.save();
                        if (saved !== false) {
                            setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                        }
                    }
                }
                break;
            }
            case 'r': {
                if (e.ctrlKey && focusedRowIndex >= 0) {
                    e.preventDefault();
                    const tx = displayTransactions[focusedRowIndex];
                    await toggleReviewed(tx.guid);
                    setReviewedCount(prev => prev + 1);
                }
                break;
            }
            case 'Escape':
                setFocusedRowIndex(-1);
                break;
        }
        return;
    }

    // ... existing normal mode keyboard handling (unchanged)
}, [/* dependencies */]);
```

**Step 2: Auto-focus first row when entering review mode**

```ts
useEffect(() => {
    if (isReviewMode && displayTransactions.length > 0 && focusedRowIndex < 0) {
        setFocusedRowIndex(0);
    }
}, [isReviewMode, displayTransactions.length]);
```

**Step 3: Verify keyboard behavior**

Run: `npm run dev`
Test: Arrow keys move focus, Enter saves and advances, Ctrl+R marks reviewed, Escape in field blurs.

**Step 4: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add review mode keyboard navigation (Enter/arrows/Ctrl+R/Escape)"
```

---

## Task 14: Bulk Review Button and Select All

Add the bulk "Mark Reviewed" button and select-all checkbox.

**Files:**
- Modify: `src/components/AccountLedger.tsx` (top bar, select-all in header)

**Step 1: Add bulk review handler**

```ts
const handleBulkReview = useCallback(async () => {
    const guids = Array.from(reviewSelectedGuids);
    for (const guid of guids) {
        await fetch(`/api/transactions/${guid}/review`, { method: 'PATCH' });
    }
    // Refresh after bulk review
    setReviewedCount(prev => prev + guids.length);
    setReviewSelectedGuids(new Set());
    await fetchTransactions();
}, [reviewSelectedGuids, fetchTransactions]);
```

**Step 2: Add bulk review button to top bar**

When review mode is active, show the bulk review controls:

```tsx
{isReviewMode && (
    <div className="flex items-center gap-2">
        <button
            onClick={handleSelectAllReview}
            className="text-xs text-foreground-secondary hover:text-foreground transition-colors"
        >
            Select All
        </button>
        <span className="text-foreground-muted">|</span>
        <button
            onClick={() => setReviewSelectedGuids(new Set())}
            className="text-xs text-foreground-secondary hover:text-foreground transition-colors"
        >
            Clear
        </button>
        <button
            onClick={handleBulkReview}
            disabled={reviewSelectedGuids.size === 0}
            className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
            Mark Reviewed ({reviewSelectedGuids.size})
        </button>
    </div>
)}
```

**Step 3: Wire shift+click on checkboxes**

In the `EditableRow` usage, pass the click event through so we can detect shiftKey:

```tsx
onToggleCheck={(e?: React.MouseEvent) => handleReviewCheckToggle(index, tx.guid, e?.shiftKey || false)}
```

Update `EditableRowProps.onToggleCheck` to accept the mouse event and pass it through from the `<input onChange>`.

**Step 4: Add select-all checkbox in table header**

In the TanStack Table header rendering, for the 'select' column, render a checkbox:

```tsx
<input
    type="checkbox"
    checked={reviewSelectedGuids.size === displayTransactions.length && displayTransactions.length > 0}
    onChange={(e) => {
        if (e.target.checked) handleSelectAllReview();
        else setReviewSelectedGuids(new Set());
    }}
    tabIndex={-1}
    className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-cyan-500 cursor-pointer"
/>
```

**Step 5: Verify**

Run: `npm run dev`
Test: Select all, clear, shift+click range, bulk review button.

**Step 6: Commit**

```bash
git add src/components/AccountLedger.tsx src/components/ledger/EditableRow.tsx
git commit -m "feat: add bulk review with select-all and shift+click range selection"
```

---

## Task 15: Empty State and Polish

Add the "All caught up!" empty state and final polish.

**Files:**
- Modify: `src/components/AccountLedger.tsx` (empty state, cleanup)

**Step 1: Add empty state for review mode**

When review mode is active and `displayTransactions.length === 0`:

```tsx
{isReviewMode && displayTransactions.length === 0 && (
    <div className="p-12 text-center">
        <div className="text-4xl mb-4">&#10003;</div>
        <h3 className="text-lg font-semibold text-emerald-400 mb-2">All caught up!</h3>
        <p className="text-sm text-foreground-muted">
            {reviewedCount > 0
                ? `You reviewed ${reviewedCount} transaction${reviewedCount !== 1 ? 's' : ''} this session.`
                : 'No unreviewed transactions.'}
        </p>
        <button
            onClick={handleToggleReviewMode}
            className="mt-4 px-4 py-2 text-sm border border-border text-foreground-secondary hover:text-foreground rounded-lg transition-colors"
        >
            Exit Review Mode
        </button>
    </div>
)}
```

**Step 2: Reset review state when exiting review mode**

```ts
const handleToggleReviewMode = useCallback(() => {
    setIsReviewMode(prev => {
        const next = !prev;
        if (next) {
            setIsReconciling(false);
            setSelectedSplits(new Set());
            setShowUnreviewedOnly(true);
            setReviewedCount(0);
        } else {
            setReviewSelectedGuids(new Set());
            setFocusedRowIndex(-1);
        }
        return next;
    });
}, []);
```

**Step 3: Final build verification**

Run: `npm run build`
Expected: Build succeeds with zero errors

**Step 4: Manual integration test**

Run: `npm run dev`
Full test checklist:
- [ ] Normal mode: table renders identically to before
- [ ] Normal mode: inline edit (Enter) works
- [ ] Normal mode: keyboard nav (j/k/arrows) works
- [ ] Normal mode: reconciliation works
- [ ] Review mode: toggle activates, unreviewed filter auto-enabled
- [ ] Review mode: first row auto-focused and editable
- [ ] Review mode: arrow keys move between rows with auto-save
- [ ] Review mode: Enter saves and advances
- [ ] Review mode: Tab moves between cells
- [ ] Review mode: Ctrl+R marks reviewed and advances
- [ ] Review mode: Escape discards changes
- [ ] Review mode: checkboxes work (click, shift+click range)
- [ ] Review mode: select all / clear / bulk review
- [ ] Review mode: edit button opens TransactionFormModal directly
- [ ] Review mode: multi-split rows show read-only with edit button
- [ ] Review mode: empty state shows when all reviewed
- [ ] Reconciliation and review mode are mutually exclusive
- [ ] Deleting a SimpleFin transaction preserves meta row
- [ ] Deleting and re-syncing does NOT reimport the deleted transaction
- [ ] Reconciliation auto-fills SimpleFin balance

**Step 5: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add review mode empty state and polish"
```

---

## Summary of All Files

**New files:**
- `src/components/ledger/types.ts`
- `src/components/ledger/columns.tsx`
- `src/components/ledger/cells/DateCell.tsx`
- `src/components/ledger/cells/DescriptionCell.tsx`
- `src/components/ledger/cells/AccountCell.tsx`
- `src/components/ledger/cells/AmountCell.tsx`
- `src/components/ledger/EditableRow.tsx`
- `src/app/api/simplefin/balance/[accountGuid]/route.ts`

**Modified files:**
- `package.json` (new deps)
- `src/lib/db-init.ts` (schema migrations)
- `src/app/api/transactions/[guid]/route.ts` (dedup on delete)
- `src/lib/services/simplefin-sync.service.ts` (store balance)
- `src/components/ReconciliationPanel.tsx` (auto-fill balance)
- `src/components/AccountLedger.tsx` (TanStack Table, review mode, keyboard nav)
