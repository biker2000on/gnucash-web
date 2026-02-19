'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { AccountTransaction } from './AccountLedger';
import { AccountSelector } from './ui/AccountSelector';
import { DescriptionAutocomplete } from './ui/DescriptionAutocomplete';
import { useDateShortcuts } from '@/lib/hooks/useDateShortcuts';
import { useTaxShortcut } from '@/lib/hooks/useTaxShortcut';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { evaluateMathExpression, containsMathExpression } from '@/lib/math-eval';

interface InlineEditRowProps {
    transaction: AccountTransaction;
    accountGuid: string;
    accountType: string;
    columnCount: number;
    onSave: (guid: string, data: {
        post_date: string;
        description: string;
        accountGuid: string;
        amount: string;
        original_enter_date?: string;
    }) => Promise<void>;
    onCancel: () => void;
}

export function InlineEditRow({
    transaction,
    accountGuid,
    accountType,
    columnCount,
    onSave,
    onCancel,
}: InlineEditRowProps) {
    const { defaultTaxRate, balanceReversal } = useUserPreferences();
    const { success } = useToast();

    // Find the account split and the "other" split for a 2-split transaction
    const accountSplit = transaction.splits?.find(s => s.account_guid === accountGuid);
    const otherSplit = transaction.splits?.find(s => s.account_guid !== accountGuid);

    const [postDate, setPostDate] = useState(
        transaction.post_date ? new Date(transaction.post_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
    );
    const [description, setDescription] = useState(transaction.description || '');
    const [otherAccountGuid, setOtherAccountGuid] = useState(otherSplit?.account_guid || '');
    const [amount, setAmount] = useState(
        Math.abs(parseFloat(transaction.account_split_value)).toFixed(2)
    );
    const [saving, setSaving] = useState(false);

    const dateRef = useRef<HTMLInputElement>(null);

    // Capture enter_date for optimistic locking
    const originalEnterDate = transaction.enter_date
        ? new Date(transaction.enter_date).toISOString()
        : undefined;

    // Focus date field on mount
    useEffect(() => {
        const timer = setTimeout(() => dateRef.current?.focus(), 50);
        return () => clearTimeout(timer);
    }, []);

    // Hook up date shortcuts (+/- to increment/decrement, t for today)
    const { handleDateKeyDown } = useDateShortcuts(postDate, setPostDate);

    // Hook up tax shortcut
    const { applyTax } = useTaxShortcut(amount, defaultTaxRate, setAmount, (msg) => success(msg));

    const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 't' || e.key === 'T') {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            applyTax();
        }
    };

    const handleAmountBlur = () => {
        const result = evaluateMathExpression(amount);
        if (result !== null) {
            setAmount(result.toFixed(2));
        }
    };

    const handleSave = useCallback(async () => {
        if (saving) return;
        if (!description.trim() || !otherAccountGuid || !amount || parseFloat(amount) <= 0) return;

        setSaving(true);
        try {
            await onSave(transaction.guid, {
                post_date: postDate,
                description: description.trim(),
                accountGuid: otherAccountGuid,
                amount,
                original_enter_date: originalEnterDate,
            });
        } finally {
            setSaving(false);
        }
    }, [saving, description, otherAccountGuid, amount, postDate, transaction.guid, originalEnterDate, onSave]);

    // Global key handler for Enter (save) and Escape (cancel)
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
            } else if (e.key === 'Enter' && !e.shiftKey) {
                // Only save on Enter if not inside a dropdown
                const target = e.target as HTMLElement;
                const isInDropdown = target.closest('[role="listbox"], [data-autocomplete-dropdown]');
                if (!isInDropdown) {
                    e.preventDefault();
                    handleSave();
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [handleSave, onCancel]);

    // Determine if original amount was negative (debit to this account)
    const originalAmount = parseFloat(transaction.account_split_value);
    const balanceValue = applyBalanceReversal(parseFloat(transaction.running_balance), accountType, balanceReversal);

    return (
        <tr className="bg-cyan-500/5 ring-2 ring-cyan-500/30 ring-inset">
            {/* Reconcile checkbox column placeholder (during reconciliation) */}
            {columnCount > 6 && <td className="px-4 py-2"></td>}

            {/* Reconcile state - show existing */}
            <td className="px-4 py-2 align-middle">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">
                    {transaction.account_split_reconcile_state === 'y' ? 'Y' : transaction.account_split_reconcile_state === 'c' ? 'C' : 'N'}
                </span>
            </td>

            {/* Date */}
            <td className="px-2 py-2 align-middle">
                <input
                    ref={dateRef}
                    type="date"
                    value={postDate}
                    onChange={(e) => setPostDate(e.target.value)}
                    onKeyDown={handleDateKeyDown}
                    className="w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-cyan-500/50 font-mono"
                />
            </td>

            {/* Description */}
            <td className="px-2 py-2 align-middle">
                <DescriptionAutocomplete
                    value={description}
                    onChange={setDescription}
                    placeholder="Description..."
                    className="text-sm"
                />
            </td>

            {/* Transfer Account */}
            <td className="px-2 py-2 align-middle">
                <AccountSelector
                    value={otherAccountGuid}
                    onChange={(guid) => setOtherAccountGuid(guid)}
                    placeholder="Account..."
                />
            </td>

            {/* Amount */}
            <td className="px-2 py-2 align-middle">
                <div className="relative">
                    <input
                        type="text"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        onBlur={handleAmountBlur}
                        onKeyDown={handleAmountKeyDown}
                        placeholder="0.00"
                        className="w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-foreground text-right focus:outline-none focus:border-cyan-500/50 font-mono"
                    />
                    {containsMathExpression(amount) && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-cyan-400 pointer-events-none">=</span>
                    )}
                </div>
            </td>

            {/* Running balance (stale during edit) */}
            <td className="px-6 py-2 text-sm font-mono text-right align-middle opacity-40">
                {formatCurrency(balanceValue, transaction.commodity_mnemonic)}
            </td>
        </tr>
    );
}
