'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { formatCurrency, applyBalanceReversal, BalanceReversal } from '@/lib/format';

interface InlineAmountEditorProps {
    /** Raw (GnuCash-signed) budget amount for this account/period. */
    value: number;
    budgetGuid: string;
    accountGuid: string;
    periodNum: number;
    currency?: string;
    accountType?: string;
    balanceReversal?: BalanceReversal;
    /** Optimistic parent update with the new RAW value. */
    onUpdate: (newValue: number) => void;
    /** Surface a save failure to the parent (e.g. toast). */
    onError?: (message: string) => void;
    /** True when this cell is the active (editing) cell, per parent navigation. */
    isActive?: boolean;
    /** Click → ask the parent to make this the active cell. */
    onActivate?: () => void;
    /** Tab / Shift+Tab → move the active cell by dir. */
    onNavigate?: (dir: 1 | -1) => void;
    /** Enter / Escape / blur → clear the active cell. */
    onDeactivate?: () => void;
}

export function InlineAmountEditor({
    value,
    budgetGuid,
    accountGuid,
    periodNum,
    currency = 'USD',
    accountType = 'EXPENSE',
    balanceReversal = 'none',
    onUpdate,
    onError,
    isActive = false,
    onActivate,
    onNavigate,
    onDeactivate,
}: InlineAmountEditorProps) {
    // applyBalanceReversal is an involution (negation), so the same call maps
    // raw→display and display→raw. We display the reversed value and edit in
    // that same space, converting back to raw only when persisting.
    const displayValue = applyBalanceReversal(value, accountType, balanceReversal);

    const editing = isActive;
    const [editValue, setEditValue] = useState(String(displayValue));
    const [isSaving, setIsSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    // Records why the input is unmounting so onBlur can avoid double-committing
    // or clobbering a navigation that already moved the active cell.
    const actionRef = useRef<null | 'nav' | 'commit' | 'cancel'>(null);

    // When this cell becomes active, seed the input with the display value and
    // focus/select it (supports both click-to-edit and Tab navigation).
    useEffect(() => {
        if (editing) {
            setEditValue(String(displayValue));
            const el = inputRef.current;
            if (el) {
                el.focus();
                el.select();
            }
        }
        // Only re-run when the active state flips.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing]);

    const persist = useCallback((newRaw: number) => {
        onUpdate(newRaw);
        setIsSaving(true);
        fetch(`/api/budgets/${budgetGuid}/amounts`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_guid: accountGuid, period_num: periodNum, amount: newRaw }),
        })
            .then(res => {
                if (!res.ok) throw new Error('Save failed');
            })
            .catch(() => {
                onUpdate(value); // revert optimistic update
                onError?.('Failed to save budget amount');
            })
            .finally(() => setIsSaving(false));
    }, [budgetGuid, accountGuid, periodNum, value, onUpdate, onError]);

    // Commit the current input. Returns true when a value was persisted.
    const commit = useCallback(() => {
        const parsedDisplay = editValue.trim() === '' ? 0 : parseFloat(editValue);
        if (Number.isNaN(parsedDisplay)) {
            onError?.('Invalid number');
            return false;
        }
        const newRaw = applyBalanceReversal(parsedDisplay, accountType, balanceReversal);
        if (newRaw !== value) {
            persist(newRaw);
        }
        return true;
    }, [editValue, accountType, balanceReversal, value, persist, onError]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            actionRef.current = 'commit';
            commit();
            onDeactivate?.();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            actionRef.current = 'cancel';
            onDeactivate?.();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            actionRef.current = 'nav';
            commit();
            onNavigate?.(e.shiftKey ? -1 : 1);
        }
    };

    const handleBlur = () => {
        // A keyboard action already handled this unmount; don't double-fire.
        if (actionRef.current) {
            actionRef.current = null;
            return;
        }
        commit();
        onDeactivate?.();
    };

    if (editing) {
        return (
            <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className="w-full px-2 py-1 text-right text-sm border border-primary rounded bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
            />
        );
    }

    return (
        <button
            onClick={() => onActivate?.()}
            disabled={isSaving}
            className={`w-full text-right px-2 py-1 rounded hover:bg-surface-hover/50 transition-colors ${
                isSaving ? 'opacity-50' : ''
            } ${value === 0 ? 'text-foreground-muted' : displayValue < 0 ? 'text-rose-400' : 'text-foreground'}`}
            title="Click to edit"
        >
            {value === 0 ? '—' : formatCurrency(displayValue, currency)}
        </button>
    );
}
