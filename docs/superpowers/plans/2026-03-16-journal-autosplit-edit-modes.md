# Journal & Auto-Split Edit Modes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add journal and auto-split view modes to edit mode, with editable split rows below transaction lines, blank placeholder rows for new splits, and eager save with imbalance detection.

**Architecture:** The existing `EditableRow` gets a slim variant (date + description only) controlled by `ledgerViewStyle` prop. A new `EditableSplitRows` component renders editable split rows with a blank placeholder row. `AccountLedger` orchestrates saves by combining data from both components via imperative handles. Focus uses a two-level index (`focusedTxIndex` + `focusedSplitIndex`) in journal/autosplit modes only.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma ORM, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-03-16-journal-autosplit-edit-modes-design.md`

---

## Chunk 1: API & Type Changes

### Task 1: Accept client-provided split GUIDs in PUT endpoint

**Files:**
- Modify: `src/app/api/transactions/[guid]/route.ts:192-210`

- [ ] **Step 1: Update split creation loop to use client GUID when provided**

In the PUT handler's split creation loop (line 192-210), change:
```typescript
const splitGuid = generateGuid();
```
to:
```typescript
const splitGuid = split.guid && /^[0-9a-f]{32}$/.test(split.guid) ? split.guid : generateGuid();
```

If `split.guid` is provided but fails validation, return 400:
```typescript
// Add before the prisma.$transaction block (before line 164)
for (const split of body.splits) {
    if (split.guid !== undefined && !/^[0-9a-f]{32}$/.test(split.guid)) {
        return NextResponse.json({
            errors: [{ field: 'splits', message: `Invalid split GUID format: ${split.guid}. Must be 32-char hex string.` }]
        }, { status: 400 });
    }
}
```

Note: The `allSplits` array comes from `processMultiCurrencySplits` which may add trading splits. The trading splits won't have client GUIDs, so the fallback to `generateGuid()` handles them. `processMultiCurrencySplits` in `src/lib/trading-accounts.ts` uses spread syntax (`...s`) which preserves all input fields including `guid`. No changes needed in `trading-accounts.ts`.

- [ ] **Step 2: Verify the change works with existing clients**

Existing callers don't send `split.guid`, so `generateGuid()` is used as before. No behavior change for existing code paths.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/transactions/[guid]/route.ts
git commit -m "feat: accept optional client-provided split GUIDs in PUT endpoint"
```

### Task 2: Extend EditableRowHandle interface

**Files:**
- Modify: `src/components/ledger/EditableRow.tsx:14-17`

- [ ] **Step 1: Add getTransactionData to EditableRowHandle**

Update the interface at line 14-17:
```typescript
export interface EditableRowHandle {
    save: () => Promise<boolean>;
    isDirty: () => boolean;
    getTransactionData: () => { post_date: string; description: string; currency_guid: string };
}
```

- [ ] **Step 2: Implement getTransactionData in the useImperativeHandle call**

At line 127 where `useImperativeHandle` is called, add the new method. Note: the date state variable is named `postDate` (line 76 of EditableRow.tsx):
```typescript
useImperativeHandle(ref, () => ({
    save,
    isDirty,
    getTransactionData: () => ({
        post_date: postDate,
        description,
        currency_guid: transaction.currency_guid,
    }),
}), [save, isDirty, postDate, description, transaction.currency_guid]);
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ledger/EditableRow.tsx
git commit -m "feat: add getTransactionData to EditableRowHandle interface"
```

---

## Chunk 2: EditableRow Slim Mode

### Task 3: Add ledgerViewStyle prop to EditableRow

**Files:**
- Modify: `src/components/ledger/EditableRow.tsx`

- [ ] **Step 1: Add prop to EditableRowProps**

Add to the props interface (after line 44):
```typescript
ledgerViewStyle?: 'basic' | 'journal' | 'autosplit';
onTabToSplits?: () => void;
```

Add to the destructured props in the component function.

- [ ] **Step 2: Derive isSlimMode**

Inside the component body, add:
```typescript
const isSlimMode = ledgerViewStyle === 'journal' || ledgerViewStyle === 'autosplit';
```

- [ ] **Step 3: Guard the multi-split branch**

The multi-split check at line 177 currently renders a read-only "-- N splits --" row. Wrap it so this only applies in basic mode:
```typescript
if (isMultiSplit && !isSlimMode) {
    // existing multi-split read-only rendering (lines 177-205)
}
```

In slim mode, multi-split transactions render the same slim layout as any other transaction.

- [ ] **Step 4: Implement slim active row rendering**

In the active row rendering section (lines 234-332), when `isSlimMode` is true:
- Render `DateCell` and `DescriptionCell` as normal
- Render account, debit, credit columns as empty `<td>` elements (no inputs)
- The modal edit button should have `tabIndex={-1}` so it's not in the tab order

Create a new branch after the `isMultiSplit && !isSlimMode` check:
```typescript
if (isActive && isSlimMode) {
    return (
        <tr className="bg-cyan-500/5 ring-2 ring-cyan-500/30 ring-inset">
            {showCheckbox && (
                <td className="px-3 py-2 align-middle w-8">
                    <input type="checkbox" checked={isChecked} onChange={() => onToggleCheck?.()} ... />
                </td>
            )}
            <td className="px-3 py-2">
                <DateCell value={date} onChange={setDate} autoFocus={focusedColumn === 0}
                    onEnter={() => onColumnFocus?.(1)} onArrowUp={onArrowUp} onArrowDown={onArrowDown}
                    onFocus={() => onColumnFocus?.(0)} />
            </td>
            <td className="px-3 py-2">
                <DescriptionCell value={description} onChange={setDescription} autoFocus={focusedColumn === 1}
                    onEnter={() => onTabToSplits?.()}
                    onTab={() => onTabToSplits?.()}
                    onArrowUp={onArrowUp} onArrowDown={onArrowDown}
                    onFocus={() => onColumnFocus?.(1)} />
            </td>
            <td className="px-3 py-2"></td> {/* account - empty */}
            <td className="px-3 py-2 text-right"></td> {/* debit - empty */}
            <td className="px-3 py-2 text-right"></td> {/* credit - empty */}
            <td className="px-3 py-2 text-right text-foreground-muted">
                {formatCurrency(parseFloat(transaction.running_balance), ...)}
            </td>
            <td className="px-3 py-2 text-right">
                <button tabIndex={-1} onClick={() => onEditModal(transaction.guid)} className="...">
                    Edit
                </button>
            </td>
        </tr>
    );
}
```

Note: `DescriptionCell` and `DescriptionAutocomplete` do not currently support an `onTab` prop. Add `onTab?: () => void` to both components' props interfaces, and in `DescriptionAutocomplete`'s keydown handler, intercept `Tab` (when not shift) and call `onTab()` + `e.preventDefault()` to coordinate with the parent's focus state. Without this, Tab moves DOM focus but `focusedSplitIndex` won't update, causing desync.

Note: Match the exact column structure from the existing active row rendering. Check the column definitions in `AccountLedger.tsx` to ensure the number of `<td>` elements matches. The existing code has conditional columns (select, expand, reconcile) — preserve the same column count.

- [ ] **Step 5: Implement slim inactive row rendering**

In the inactive row rendering section (lines 208-231), when `isSlimMode` is true:
- Show date and description as static text
- Account, debit, credit, balance columns are empty or show static values
- Clicking the row calls `onClick`

```typescript
if (!isActive && isSlimMode) {
    return (
        <tr className="hover:bg-white/[0.02] transition-colors cursor-pointer" onClick={onClick}>
            {showCheckbox && (
                <td className="px-3 py-2 align-middle w-8">
                    <input type="checkbox" checked={isChecked} onChange={() => onToggleCheck?.()} ... />
                </td>
            )}
            <td className="px-3 py-2 text-sm">{dateDisplay}</td>
            <td className="px-3 py-2 text-sm">{description || transaction.description}</td>
            <td className="px-3 py-2"></td>
            <td className="px-3 py-2"></td>
            <td className="px-3 py-2"></td>
            <td className="px-3 py-2 text-right text-sm text-foreground-muted">
                {formatCurrency(parseFloat(transaction.running_balance), ...)}
            </td>
            <td className="px-3 py-2"></td>
        </tr>
    );
}
```

- [ ] **Step 6: Prevent EditableRow.save() from firing in slim mode**

The `save()` function (lines 102-125) constructs a two-split payload. In slim mode, save should be a no-op since the parent orchestrates saves:
```typescript
const save = useCallback(async (): Promise<boolean> => {
    if (isSlimMode) return true; // Parent handles save in journal/autosplit
    if (!isDirty()) return true;
    // ... existing save logic
}, [isSlimMode, isDirty, ...]);
```

- [ ] **Step 7: Commit**

```bash
git add src/components/ledger/EditableRow.tsx
git commit -m "feat: add slim mode to EditableRow for journal/autosplit edit"
```

---

## Chunk 3: EditableSplitRows Component

### Task 4: Create EditableSplitRows component

**Files:**
- Create: `src/components/ledger/EditableSplitRows.tsx`

This is the largest task. The component renders editable split rows below a transaction line.

- [ ] **Step 1: Define interfaces and types**

```typescript
'use client';

import { useState, useCallback, useImperativeHandle, forwardRef, useEffect, useRef, useMemo } from 'react';
import { AccountTransaction } from '@/components/AccountLedger';
import { AccountCell } from './cells/AccountCell';
import { AmountCell } from './cells/AmountCell';
import { toNumDenom } from '@/lib/validation';

interface SplitState {
    guid: string;
    account_guid: string;
    account_name: string;
    memo: string;
    debit: string;
    credit: string;
    reconcile_state: string;
    isPlaceholder?: boolean;
}

export interface EditableSplitRowsHandle {
    isDirty: () => boolean;
    getSplitPayload: () => { guid?: string; account_guid: string; value_num: number; value_denom: number; quantity_num: number; quantity_denom: number; memo: string; reconcile_state: string }[];
    revert: () => void;
}

interface EditableSplitRowsProps {
    transaction: AccountTransaction;
    accountGuid: string;
    columns: number;
    isActive: boolean;
    focusedSplitIndex?: number;
    focusedColumnIndex?: number;
    onFocusedSplitChange?: (splitIndex: number) => void;
    onColumnFocus?: (colIndex: number) => void;
    onArrowUp?: () => void;  // Navigate above first split (to transaction line)
    onArrowDownPastEnd?: () => void;  // Navigate below last split (to next transaction)
    onTabToNextTransaction?: () => void;  // Tab past blank row
}
```

- [ ] **Step 2: Initialize split state from transaction**

```typescript
const EditableSplitRows = forwardRef<EditableSplitRowsHandle, EditableSplitRowsProps>(
    function EditableSplitRows({ transaction, accountGuid, columns, isActive, focusedSplitIndex, focusedColumnIndex, onFocusedSplitChange, onColumnFocus, onArrowUp, onArrowDownPastEnd, onTabToNextTransaction }, ref) {

    const initSplits = useCallback((): SplitState[] => {
        const realSplits: SplitState[] = (transaction.splits || [])
            .filter(s => !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:'))
            .map(s => {
                const valDecimal = s.value_decimal
                    ? parseFloat(s.value_decimal)
                    : parseFloat(s.value_num?.toString() || '0') / parseFloat(s.value_denom?.toString() || '1');
                return {
                    guid: s.guid,
                    account_guid: s.account_guid,
                    account_name: s.account_fullname || s.account_name || '',
                    memo: s.memo || '',
                    debit: valDecimal > 0 ? Math.abs(valDecimal).toFixed(2) : '',
                    credit: valDecimal < 0 ? Math.abs(valDecimal).toFixed(2) : '',
                    reconcile_state: s.reconcile_state || 'n',
                };
            });

        return [...realSplits, createBlankSplit()];
    }, [transaction.splits]);

    const createBlankSplit = (): SplitState => ({
        guid: crypto.randomUUID().replace(/-/g, ''),
        account_guid: '',
        account_name: '',
        memo: '',
        debit: '',
        credit: '',
        reconcile_state: 'n',
        isPlaceholder: true,
    });

    const [splits, setSplits] = useState<SplitState[]>(initSplits);
    const originalSplitsRef = useRef<string>(JSON.stringify(initSplits()));

    // Re-init when transaction changes externally (e.g. after save)
    useEffect(() => {
        const newInit = initSplits();
        const newInitStr = JSON.stringify(newInit);
        // Only reset if the underlying transaction data changed
        if (originalSplitsRef.current !== newInitStr) {
            setSplits(newInit);
            originalSplitsRef.current = newInitStr;
        }
    }, [initSplits]);
```

- [ ] **Step 3: Implement imbalance calculation and placeholder prefill**

```typescript
    const calculateImbalance = useCallback((currentSplits: SplitState[]): number => {
        return currentSplits
            .filter(s => !s.isPlaceholder)
            .reduce((sum, s) => {
                const debit = parseFloat(s.debit) || 0;
                const credit = parseFloat(s.credit) || 0;
                return sum + debit - credit;
            }, 0);
    }, []);

    // Update placeholder row with imbalance amount
    const splitsWithImbalance = useMemo(() => splits.map((s, i) => {
        if (!s.isPlaceholder) return s;
        const imbalance = calculateImbalance(splits);
        const balancingAmount = -imbalance;
        return {
            ...s,
            debit: balancingAmount > 0 ? balancingAmount.toFixed(2) : '',
            credit: balancingAmount < 0 ? Math.abs(balancingAmount).toFixed(2) : '',
        };
    }), [splits, calculateImbalance]);
```

- [ ] **Step 4: Implement split mutation handlers**

```typescript
    const updateSplit = useCallback((index: number, field: keyof SplitState, value: string) => {
        setSplits(prev => prev.map((s, i) => {
            if (i !== index) return s;
            // Debit/credit mutual exclusivity
            if (field === 'debit' && value) return { ...s, debit: value, credit: '' };
            if (field === 'credit' && value) return { ...s, credit: value, debit: '' };
            return { ...s, [field]: value };
        }));
    }, []);

    const updateSplitAccount = useCallback((index: number, guid: string, name: string) => {
        setSplits(prev => {
            const updated = prev.map((s, i) => {
                if (i !== index) return s;
                const wasPH = s.isPlaceholder;
                const newSplit = { ...s, account_guid: guid, account_name: name };
                if (wasPH && guid) {
                    // Placeholder becomes real split
                    delete newSplit.isPlaceholder;
                }
                return newSplit;
            });
            // If the last placeholder was filled, add a new one
            const hasPlaceholder = updated.some(s => s.isPlaceholder);
            if (!hasPlaceholder) {
                updated.push(createBlankSplit());
            }
            return updated;
        });
    }, []);

    const deleteSplit = useCallback((index: number) => {
        setSplits(prev => {
            const realSplits = prev.filter(s => !s.isPlaceholder);
            if (realSplits.length <= 2) return prev; // Must keep at least 2
            return prev.filter((_, i) => i !== index);
        });
    }, []);
```

- [ ] **Step 5: Implement imperative handle**

```typescript
    const isDirty = useCallback((): boolean => {
        const current = JSON.stringify(splits.filter(s => !s.isPlaceholder));
        const original = JSON.stringify(
            JSON.parse(originalSplitsRef.current).filter((s: SplitState) => !s.isPlaceholder)
        );
        return current !== original;
    }, [splits]);

    const getSplitPayload = useCallback(() => {
        return splits
            .filter(s => !s.isPlaceholder && s.account_guid)
            .map(s => {
                const debit = parseFloat(s.debit) || 0;
                const credit = parseFloat(s.credit) || 0;
                const signedAmount = debit - credit;
                const { num, denom } = toNumDenom(signedAmount);
                return {
                    guid: s.guid,
                    account_guid: s.account_guid,
                    value_num: num,
                    value_denom: denom,
                    quantity_num: num,
                    quantity_denom: denom,
                    memo: s.memo || '',
                    reconcile_state: s.reconcile_state || 'n',
                };
            });
    }, [splits]);

    const revert = useCallback(() => {
        setSplits(JSON.parse(originalSplitsRef.current));
    }, []);

    useImperativeHandle(ref, () => ({
        isDirty,
        getSplitPayload,
        revert,
    }), [isDirty, getSplitPayload, revert]);
```

- [ ] **Step 6: Implement row rendering**

Use column alignment logic from `SplitRows.tsx`:
```typescript
    const contentCols = 4; // memo, account, debit, credit
    const trailingEmpty = 1; // balance
    const leadingEmpty = Math.max(0, columns - contentCols - trailingEmpty);
    const actualTrailing = columns - leadingEmpty - contentCols;
    const realSplitCount = splits.filter(s => !s.isPlaceholder).length;

    return (
        <>
            {splitsWithImbalance.map((split, index) => {
                const isFocused = isActive && focusedSplitIndex === index;
                return (
                    <tr
                        key={split.guid}
                        data-split-row
                        className={`border-b border-border/30 ${
                            isFocused
                                ? 'bg-cyan-500/5 ring-1 ring-cyan-500/30 ring-inset'
                                : 'bg-background-secondary/30'
                        } ${split.isPlaceholder ? 'opacity-60' : ''}`}
                        onClick={() => onFocusedSplitChange?.(index)}
                    >
                        {leadingEmpty > 0 && <td colSpan={leadingEmpty}></td>}

                        {/* Memo */}
                        <td className="px-3 py-1">
                            {isFocused ? (
                                <input
                                    type="text"
                                    value={split.memo}
                                    onChange={e => updateSplit(index, 'memo', e.target.value)}
                                    placeholder="Memo"
                                    autoFocus={focusedColumnIndex === 0}
                                    onFocus={() => onColumnFocus?.(0)}
                                    onKeyDown={e => {
                                        if (e.key === 'ArrowUp') { e.preventDefault(); index === 0 ? onArrowUp?.() : onFocusedSplitChange?.(index - 1); }
                                        if (e.key === 'ArrowDown') { e.preventDefault(); index < splitsWithImbalance.length - 1 ? onFocusedSplitChange?.(index + 1) : onArrowDownPastEnd?.(); }
                                        if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); onColumnFocus?.(1); }
                                    }}
                                    className="w-full bg-transparent text-xs text-foreground-muted outline-none border-b border-transparent focus:border-cyan-500/50"
                                />
                            ) : (
                                <span className="text-xs text-foreground-muted">{split.memo}</span>
                            )}
                        </td>

                        {/* Account */}
                        <td className="px-3 py-1">
                            {isFocused ? (
                                <AccountCell
                                    value={split.account_guid}
                                    onChange={(guid, name) => updateSplitAccount(index, guid, name)}
                                    autoFocus={focusedColumnIndex === 1}
                                    onFocus={() => onColumnFocus?.(1)}
                                    onEnter={() => onColumnFocus?.(2)}
                                    onArrowUp={() => index === 0 ? onArrowUp?.() : onFocusedSplitChange?.(index - 1)}
                                    onArrowDown={() => index < splitsWithImbalance.length - 1 ? onFocusedSplitChange?.(index + 1) : onArrowDownPastEnd?.()}
                                />
                            ) : (
                                <span className="text-xs text-cyan-400">{split.account_name}</span>
                            )}
                        </td>

                        {/* Debit */}
                        <td className="px-3 py-1 text-right">
                            {isFocused && !split.isPlaceholder ? (
                                <AmountCell
                                    value={split.debit}
                                    onChange={v => updateSplit(index, 'debit', v)}
                                    autoFocus={focusedColumnIndex === 2}
                                    onFocus={() => onColumnFocus?.(2)}
                                    onEnter={() => onColumnFocus?.(3)}
                                    onArrowUp={() => index === 0 ? onArrowUp?.() : onFocusedSplitChange?.(index - 1)}
                                    onArrowDown={() => index < splitsWithImbalance.length - 1 ? onFocusedSplitChange?.(index + 1) : onArrowDownPastEnd?.()}
                                />
                            ) : (
                                <span className="text-xs text-right">{split.debit}</span>
                            )}
                        </td>

                        {/* Credit */}
                        <td className="px-3 py-1 text-right">
                            {isFocused && !split.isPlaceholder ? (
                                <AmountCell
                                    value={split.credit}
                                    onChange={v => updateSplit(index, 'credit', v)}
                                    autoFocus={focusedColumnIndex === 3}
                                    onFocus={() => onColumnFocus?.(3)}
                                    onEnter={() => {
                                        // Tab/Enter from credit: move to next split or next transaction
                                        if (index < splitsWithImbalance.length - 1) {
                                            onFocusedSplitChange?.(index + 1);
                                            onColumnFocus?.(0);
                                        } else {
                                            onTabToNextTransaction?.();
                                        }
                                    }}
                                    onArrowUp={() => index === 0 ? onArrowUp?.() : onFocusedSplitChange?.(index - 1)}
                                    onArrowDown={() => index < splitsWithImbalance.length - 1 ? onFocusedSplitChange?.(index + 1) : onArrowDownPastEnd?.()}
                                />
                            ) : (
                                <span className="text-xs text-right">{split.credit}</span>
                            )}
                        </td>

                        {/* Trailing: balance + delete button */}
                        <td colSpan={actualTrailing} className="px-3 py-1 text-right">
                            {!split.isPlaceholder && realSplitCount > 2 && (
                                <button
                                    tabIndex={-1}
                                    onClick={() => deleteSplit(index)}
                                    className="text-xs text-foreground-tertiary hover:text-rose-400 transition-colors"
                                    title="Remove split"
                                >
                                    &times;
                                </button>
                            )}
                        </td>
                    </tr>
                );
            })}
        </>
    );
});

export default EditableSplitRows;
```

- [ ] **Step 7: Commit**

```bash
git add src/components/ledger/EditableSplitRows.tsx
git commit -m "feat: create EditableSplitRows component for journal/autosplit edit"
```

---

## Chunk 4: AccountLedger Integration

### Task 5: Add two-level focus state

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Add new state variables**

Near the existing `focusedRowIndex` state (around line 125), add:
```typescript
const [focusedSplitIndex, setFocusedSplitIndex] = useState<number>(-1); // -1 = transaction line
const [imbalanceDialogTx, setImbalanceDialogTx] = useState<string | null>(null);
```

Add a ref map for split row handles (near `editableRowRefs`):
```typescript
const editableSplitRowRefs = useRef<Map<string, EditableSplitRowsHandle>>(new Map());
```

Import `EditableSplitRows` and its handle type:
```typescript
import EditableSplitRows, { EditableSplitRowsHandle } from '@/components/ledger/EditableSplitRows';
```

- [ ] **Step 2: Derive isSlimEditMode helper**

```typescript
const isSlimEditMode = isEditMode && (ledgerViewStyle === 'journal' || ledgerViewStyle === 'autosplit');
```

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add two-level focus state and split row refs to AccountLedger"
```

### Task 6: Implement save orchestration for journal/autosplit

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Create handleJournalSave function**

Add near `handleInlineSave` (around line 334):
```typescript
const handleJournalSave = useCallback(async (txGuid: string): Promise<boolean> => {
    const tx = transactions.find(t => t.guid === txGuid);
    if (!tx) return false;

    const rowHandle = editableRowRefs.current.get(txGuid);
    const splitHandle = editableSplitRowRefs.current.get(txGuid);
    if (!rowHandle || !splitHandle) return false;

    // Check if anything changed
    if (!rowHandle.isDirty() && !splitHandle.isDirty()) return true;

    const splitPayload = splitHandle.getSplitPayload();

    // Check balance
    const sum = splitPayload.reduce((acc, s) => acc + s.value_num / s.value_denom, 0);
    if (Math.abs(sum) > 0.001) {
        // Unbalanced — show dialog
        setImbalanceDialogTx(txGuid);
        return false;
    }

    const txData = rowHandle.getTransactionData();
    const body = {
        currency_guid: txData.currency_guid,
        post_date: txData.post_date,
        description: txData.description,
        original_enter_date: tx.enter_date ? new Date(tx.enter_date as unknown as string).toISOString() : undefined,
        splits: splitPayload,
    };

    try {
        const res = await fetch(`/api/transactions/${txGuid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.status === 409) {
            error('Transaction was modified by another user. Refreshing...');
            await fetchTransactions();
            return false;
        }
        if (!res.ok) throw new Error('Failed to update');

        success('Transaction updated');
        await fetchTransactions();
        return true;
    } catch {
        error('Failed to save transaction');
        return false;
    }
}, [transactions, fetchTransactions, success, error]);
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add handleJournalSave for journal/autosplit edit save orchestration"
```

### Task 7: Update keyboard handler for two-level focus

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Add journal/autosplit branch to handleTableKeyDown**

In the `handleTableKeyDown` callback (around line 784), the existing edit mode handler starts at `if (isEditMode) {`. Add a branch at the top of the edit mode section:

```typescript
if (isEditMode) {
    // Journal/autosplit two-level navigation
    if (isSlimEditMode) {
        switch (e.key) {
            case 'ArrowDown':
            case 'j': {
                e.preventDefault();
                if (focusedSplitIndex === -1) {
                    // On transaction line → move to first split
                    const tx = displayTransactions[focusedRowIndex];
                    const splitHandle = editableSplitRowRefs.current.get(tx?.guid);
                    if (splitHandle) {
                        setFocusedSplitIndex(0);
                    } else {
                        // No splits visible (shouldn't happen in journal), move to next tx
                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                    }
                } else {
                    // On a split row → move to next split or next transaction
                    const tx = displayTransactions[focusedRowIndex];
                    const splits = tx?.splits?.filter(s => !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')) || [];
                    const totalSplitRows = splits.length + 1; // +1 for placeholder
                    if (focusedSplitIndex < totalSplitRows - 1) {
                        setFocusedSplitIndex(i => i + 1);
                    } else {
                        // Past last split → save and move to next transaction
                        await handleJournalSave(tx.guid);
                        if (!imbalanceDialogTx) {
                            setFocusedSplitIndex(-1);
                            setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                        }
                    }
                }
                break;
            }
            case 'ArrowUp':
            case 'k': {
                e.preventDefault();
                if (focusedSplitIndex > 0) {
                    setFocusedSplitIndex(i => i - 1);
                } else if (focusedSplitIndex === 0) {
                    setFocusedSplitIndex(-1); // Back to transaction line
                } else {
                    // On transaction line → save and move to previous transaction's last split
                    const prevIndex = focusedRowIndex - 1;
                    if (prevIndex >= 0) {
                        const currentTx = displayTransactions[focusedRowIndex];
                        await handleJournalSave(currentTx.guid);
                        if (!imbalanceDialogTx) {
                            setFocusedRowIndex(prevIndex);
                            // Will land on transaction line; user can arrow down into splits
                            setFocusedSplitIndex(-1);
                        }
                    }
                }
                break;
            }
            case 'n': {
                e.preventDefault();
                e.stopImmediatePropagation();
                // Save any dirty transaction first
                if (focusedRowIndex >= 0) {
                    const currentTx = displayTransactions[focusedRowIndex];
                    if (currentTx) await handleJournalSave(currentTx.guid);
                }
                // Reuse the existing createNewTransaction() helper (extract the 'n' handler
                // logic from the basic edit mode branch into a shared function called
                // `createNewTransaction()` that both branches call). The function creates
                // a blank AccountTransaction with client-generated GUIDs, inserts it at
                // the top of `transactions`, and sets focus to index 0.
                createNewTransaction();
                setFocusedSplitIndex(-1);
                break;
            }
            case 'm': {
                if (editSelectedGuids.size > 0) {
                    e.preventDefault();
                    setShowMoveDialog(true);
                }
                break;
            }
            case 'Escape':
                setFocusedSplitIndex(-1);
                setFocusedRowIndex(-1);
                break;
        }
        return;
    }

    // ... existing basic edit mode switch statement
```

Note: The `n` key handler can share the existing new-transaction logic. Extract it into a helper function `createNewTransaction()` and call from both branches.

- [ ] **Step 2: Add handleJournalSave and imbalanceDialogTx to the dependency array**

Update the `useCallback` dependency array for `handleTableKeyDown` to include `isSlimEditMode`, `focusedSplitIndex`, `handleJournalSave`, `imbalanceDialogTx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add two-level keyboard navigation for journal/autosplit edit"
```

### Task 8: Render EditableSplitRows in edit mode

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Update edit mode rendering to show split rows**

In the edit mode branch (lines 1483-1589), the current code renders `EditableRow` or `InvestmentEditRow` per transaction. For non-investment accounts when `isSlimEditMode`, wrap the `EditableRow` in a `React.Fragment` and add `EditableSplitRows` below it.

Replace the `EditableRow` rendering (lines 1537-1587) with:
```typescript
<React.Fragment key={tx.guid}>
    <EditableRow
        ref={(handle) => {
            if (handle) editableRowRefs.current.set(tx.guid, handle);
            else editableRowRefs.current.delete(tx.guid);
        }}
        transaction={tx}
        accountGuid={accountGuid}
        accountType={accountType}
        isActive={index === focusedRowIndex && focusedSplitIndex === -1}
        showCheckbox={true}
        isChecked={editSelectedGuids.has(tx.guid)}
        onToggleCheck={(e) => handleEditCheckToggle(index, tx.guid, (e as unknown as MouseEvent)?.shiftKey || false)}
        onSave={handleInlineSave}
        onEditModal={handleEditDirect}
        onDuplicate={handleDuplicate}
        columnCount={table.getVisibleFlatColumns().length}
        onClick={() => { setFocusedRowIndex(index); setFocusedSplitIndex(-1); }}
        focusedColumn={index === focusedRowIndex && focusedSplitIndex === -1 ? focusedColumnIndex : undefined}
        ledgerViewStyle={ledgerViewStyle}
        onTabToSplits={() => { setFocusedSplitIndex(0); setFocusedColumnIndex(0); }}
        onEnter={async () => { /* ... existing */ }}
        onArrowUp={async () => { /* ... existing */ }}
        onArrowDown={async () => {
            if (isSlimEditMode) {
                setFocusedSplitIndex(0);
                setFocusedColumnIndex(0);
            } else {
                const handle = editableRowRefs.current.get(tx.guid);
                if (handle?.isDirty()) await handle.save();
                setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
            }
        }}
        onColumnFocus={(col) => setFocusedColumnIndex(col)}
        onTabFromActions={async (direction) => { /* ... existing */ }}
    />
    {isSlimEditMode && (
        ledgerViewStyle === 'journal' ||
        (ledgerViewStyle === 'autosplit' && index === focusedRowIndex)
    ) && (
        <EditableSplitRows
            ref={(handle) => {
                if (handle) editableSplitRowRefs.current.set(tx.guid, handle);
                else editableSplitRowRefs.current.delete(tx.guid);
            }}
            transaction={tx}
            accountGuid={accountGuid}
            columns={table.getVisibleFlatColumns().length}
            isActive={index === focusedRowIndex}
            focusedSplitIndex={index === focusedRowIndex ? focusedSplitIndex : undefined}
            focusedColumnIndex={index === focusedRowIndex && focusedSplitIndex >= 0 ? focusedColumnIndex : undefined}
            onFocusedSplitChange={(si) => { setFocusedRowIndex(index); setFocusedSplitIndex(si); }}
            onColumnFocus={(col) => setFocusedColumnIndex(col)}
            onArrowUp={() => { setFocusedSplitIndex(-1); setFocusedColumnIndex(1); }}
            onArrowDownPastEnd={async () => {
                await handleJournalSave(tx.guid);
                if (!imbalanceDialogTx) {
                    setFocusedSplitIndex(-1);
                    setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                    setFocusedColumnIndex(0);
                }
            }}
            onTabToNextTransaction={async () => {
                await handleJournalSave(tx.guid);
                if (!imbalanceDialogTx) {
                    setFocusedSplitIndex(-1);
                    setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                    setFocusedColumnIndex(0);
                }
            }}
        />
    )}
</React.Fragment>
```

For basic edit mode (`!isSlimEditMode`), the existing `EditableRow` rendering stays unchanged (no `React.Fragment`, no split rows, no `ledgerViewStyle` prop needed since it defaults to undefined/basic).

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: render EditableSplitRows in journal/autosplit edit mode"
```

### Task 9: Add imbalance dialog

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Add the imbalance dialog JSX**

First, add the `Modal` import at the top of `AccountLedger.tsx` (it is not currently imported):
```typescript
import { Modal } from '@/components/ui/Modal';
```

Also add state to track the imbalance amount for display:
```typescript
const [imbalanceAmount, setImbalanceAmount] = useState<number>(0);
```

Update `handleJournalSave` to set `imbalanceAmount` when showing the dialog:
```typescript
// In the imbalance branch of handleJournalSave:
setImbalanceAmount(Math.abs(sum));
setImbalanceDialogTx(txGuid);
```

Near the other dialogs in AccountLedger's return JSX (near the `AccountPickerDialog` around line 1979), add:
```typescript
{/* Imbalance dialog for journal/autosplit save */}
<Modal
    isOpen={!!imbalanceDialogTx}
    onClose={() => setImbalanceDialogTx(null)}
    title="Unbalanced Transaction"
    size="sm"
>
    <div className="p-4 space-y-4">
        <p className="text-sm text-foreground-secondary">
            Transaction is unbalanced by {imbalanceAmount.toFixed(2)}. What would you like to do?
        </p>
        <div className="flex gap-3 justify-end">
            <button
                onClick={() => {
                    // Revert
                    if (imbalanceDialogTx) {
                        const splitHandle = editableSplitRowRefs.current.get(imbalanceDialogTx);
                        splitHandle?.revert();
                    }
                    setImbalanceDialogTx(null);
                }}
                className="px-3 py-2 text-sm rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            >
                Revert Changes
            </button>
            <button
                onClick={() => {
                    // Continue editing — return focus to the transaction
                    const txIndex = displayTransactions.findIndex(t => t.guid === imbalanceDialogTx);
                    if (txIndex >= 0) {
                        setFocusedRowIndex(txIndex);
                        setFocusedSplitIndex(0);
                    }
                    setImbalanceDialogTx(null);
                }}
                className="px-3 py-2 text-sm rounded-lg bg-accent-primary text-white hover:bg-accent-primary/90 transition-colors"
            >
                Continue Editing
            </button>
        </div>
    </div>
</Modal>
```

- [ ] **Step 2: Block focus changes while dialog is open**

The imbalanceDialogTx check is already in `handleTableKeyDown` guard (from Task 7). Also add it to the existing modal guard at line 786:
```typescript
if (isEditModalOpen || isViewModalOpen || deleteConfirmOpen || showMoveDialog || imbalanceDialogTx) return;
```

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add imbalance dialog for journal/autosplit save flow"
```

---

## Chunk 5: Polish & Edge Cases

### Task 10: Handle auto-split collapse with dirty state

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Auto-save on focus change in auto-split mode**

When `ledgerViewStyle === 'autosplit'` and `focusedRowIndex` changes, the split rows for the previous transaction should be saved if dirty. Add an effect:

```typescript
const prevFocusedTxIndexRef = useRef(focusedRowIndex);
useEffect(() => {
    if (!isSlimEditMode || ledgerViewStyle !== 'autosplit') return;
    const prevIndex = prevFocusedTxIndexRef.current;
    prevFocusedTxIndexRef.current = focusedRowIndex;

    if (prevIndex === focusedRowIndex || prevIndex < 0) return;

    const prevTx = displayTransactions[prevIndex];
    if (!prevTx) return;

    const splitHandle = editableSplitRowRefs.current.get(prevTx.guid);
    const rowHandle = editableRowRefs.current.get(prevTx.guid);
    if ((splitHandle?.isDirty() || rowHandle?.isDirty())) {
        handleJournalSave(prevTx.guid);
    }
}, [focusedRowIndex, isSlimEditMode, ledgerViewStyle, displayTransactions, handleJournalSave]);
```

- [ ] **Step 2: Reset focusedSplitIndex when focusedRowIndex changes**

```typescript
useEffect(() => {
    setFocusedSplitIndex(-1);
}, [focusedRowIndex]);
```

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: auto-save on focus change in auto-split edit mode"
```

### Task 11: Scroll-into-view for split rows

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Update scroll-into-view logic for two-level focus**

The existing scroll-into-view effect (around line 1091) uses `focusedRowIndex`. Add a parallel effect for split rows:

```typescript
useEffect(() => {
    if (!isSlimEditMode || focusedSplitIndex < 0) return;
    const tableEl = document.querySelector('[data-ledger-table]');
    if (!tableEl) return;
    const splitRows = tableEl.querySelectorAll('[data-split-row]');
    // Find the correct split row — need to count per-transaction
    // The EditableSplitRows already has data-split-row on each tr
    // We need the ones belonging to the focused transaction
    const txGuid = displayTransactions[focusedRowIndex]?.guid;
    if (!txGuid) return;
    // The split rows follow the transaction row in DOM order
    // Find the transaction row first, then its following split rows
    const allRows = tableEl.querySelectorAll('tr');
    let foundTx = false;
    let splitCount = 0;
    for (const row of allRows) {
        if (foundTx) {
            if (row.hasAttribute('data-split-row')) {
                if (splitCount === focusedSplitIndex) {
                    row.scrollIntoView({ block: 'nearest' });
                    return;
                }
                splitCount++;
            } else {
                break; // Hit next transaction row
            }
        }
        if (row.getAttribute('data-tx-guid') === txGuid) {
            foundTx = true;
        }
    }
}, [focusedSplitIndex, focusedRowIndex, isSlimEditMode, displayTransactions]);
```

Note: This requires adding `data-tx-guid={tx.guid}` and `data-ledger-table` attributes to the relevant elements in the render. Add `data-tx-guid` to the `<tr>` rendered by `EditableRow` (pass as a prop or add in the Fragment wrapper). Add `data-ledger-table` to the `<table>` element.

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: scroll-into-view for split rows in journal/autosplit edit"
```

### Task 12: Manual testing and integration verification

- [ ] **Step 1: Verify basic edit mode is unchanged**

Open an account ledger, enter edit mode with view style "basic". Verify:
- EditableRow renders with all 5 columns (date, description, account, debit, credit)
- Arrow keys navigate between transactions
- Tab navigates between columns
- Save works on focus change
- Multi-split transactions show "-- N splits --"

- [ ] **Step 2: Verify journal edit mode**

Switch to journal view (`v j`), ensure edit mode is active. Verify:
- Transaction lines show only date + description
- All splits are visible as editable rows below every transaction
- Blank placeholder row shows imbalance amount
- Selecting an account on the blank row creates a new split + new blank row
- Arrow keys navigate through transaction lines AND split rows
- Tab navigates: date → description → first split memo → account → debit → credit → next split
- Focus change triggers save when balanced
- Focus change shows imbalance dialog when unbalanced
- Revert discards changes, Continue Editing returns focus

- [ ] **Step 3: Verify auto-split edit mode**

Switch to auto-split view (`v a`), ensure edit mode is active. Verify:
- Split rows only appear under focused transaction
- Moving focus away auto-saves and collapses splits
- Same editing behavior as journal mode when focused

- [ ] **Step 4: Verify bulk operations still work**

In journal/autosplit edit mode:
- Checkbox selection works
- `m` opens move dialog
- `Ctrl+R` marks reviewed (bulk or single)
- `x` deletes selected
- `n` creates new transaction

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: polish journal/autosplit edit mode edge cases"
```
