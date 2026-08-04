'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { AccountTransaction } from './AccountLedger';
import { AccountSelector } from './ui/AccountSelector';
import { DescriptionAutocomplete } from './ui/DescriptionAutocomplete';
import { useDateShortcuts } from '@/lib/hooks/useDateShortcuts';
import { useTaxShortcut } from '@/lib/hooks/useTaxShortcut';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { toLocalDateString, toUTCDateString } from '@/lib/datePresets';
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
        accountName: string;
        amount: string;
        original_enter_date?: string | null;
        /** Double-line edit: this account's split memo. Undefined = untouched. */
        memo?: string;
        /** Double-line edit: transaction-level notes. Undefined = untouched. */
        notes?: string;
    }) => Promise<void>;
    onCancel: () => void;
    /** Render the GnuCash-style second line (notes + split memo). */
    doubleLine?: boolean;
}

export function InlineEditRow({
    transaction,
    accountGuid,
    accountType,
    columnCount,
    onSave,
    onCancel,
    doubleLine,
}: InlineEditRowProps) {
    const { defaultTaxRate, balanceReversal, dateFormat } = useUserPreferences();
    const { success } = useToast();

    // Find the account split and the "other" split for a 2-split transaction
    const otherSplit = transaction.splits?.find(s => s.account_guid !== accountGuid);
    const [postDate, setPostDate] = useState(
        transaction.post_date ? toUTCDateString(new Date(transaction.post_date)) : toLocalDateString(new Date())
    );
    const [dateDisplay, setDateDisplay] = useState(() =>
        formatDateForDisplay(transaction.post_date ? toUTCDateString(new Date(transaction.post_date)) : toLocalDateString(new Date()), dateFormat)
    );
    const [description, setDescription] = useState(transaction.description || '');
    const [otherAccountGuid, setOtherAccountGuid] = useState(otherSplit?.account_guid || '');
    const [otherAccountName, setOtherAccountName] = useState(otherSplit?.account_name || '');
    const splitValue = parseFloat(transaction.account_split_value);
    const [debit, setDebit] = useState(splitValue >= 0 ? Math.abs(splitValue).toFixed(2) : '');
    const [credit, setCredit] = useState(splitValue < 0 ? Math.abs(splitValue).toFixed(2) : '');
    const [saving, setSaving] = useState(false);

    // Double-line fields: transaction notes + this account's split memo.
    // Editing these must never reset reconcile state (only amount/account
    // edits do — see inlineTwoSplitPayload in AccountLedger).
    const ownSplit = transaction.splits?.find(s => s.guid === transaction.account_split_guid)
        ?? transaction.splits?.find(s => s.account_guid === accountGuid);
    const origNotes = transaction.notes ?? '';
    const origMemo = ownSplit?.memo ?? '';
    const [notes, setNotes] = useState(origNotes);
    const [memo, setMemo] = useState(origMemo);

    const dateRef = useRef<HTMLInputElement>(null);

    // Capture enter_date for optimistic locking (null = row had none)
    const originalEnterDate = transaction.enter_date
        ? new Date(transaction.enter_date).toISOString()
        : null;

    // Focus date field on mount
    useEffect(() => {
        const timer = setTimeout(() => dateRef.current?.focus(), 50);
        return () => clearTimeout(timer);
    }, []);

    // Hook up date shortcuts (+/- to increment/decrement, t for today)
    const { handleDateKeyDown } = useDateShortcuts(postDate, (newIso) => {
        setPostDate(newIso);
        setDateDisplay(formatDateForDisplay(newIso, dateFormat));
    });

    // Hook up tax shortcut (applies to debit field)
    const { applyTax } = useTaxShortcut(debit, defaultTaxRate, (v) => { setDebit(v); if (v) setCredit(''); }, (msg) => success(msg));

    const handleDebitKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 't' || e.key === 'T') {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            applyTax();
        }
    };

    const handleDebitBlur = () => {
        const result = evaluateMathExpression(debit);
        if (result !== null) {
            setDebit(result.toFixed(2));
        }
    };

    const handleCreditBlur = () => {
        const result = evaluateMathExpression(credit);
        if (result !== null) {
            setCredit(result.toFixed(2));
        }
    };

    const handleSave = useCallback(async () => {
        if (saving) return;
        const hasAmount = (debit && parseFloat(debit) > 0) || (credit && parseFloat(credit) > 0);
        if (!description.trim() || !otherAccountGuid || !hasAmount) return;

        setSaving(true);
        try {
            const signedAmount = debit && parseFloat(debit) > 0
                ? parseFloat(debit).toFixed(2)
                : (-parseFloat(credit)).toFixed(2);
            await onSave(transaction.guid, {
                post_date: postDate,
                description: description.trim(),
                accountGuid: otherAccountGuid,
                accountName: otherAccountName,
                amount: signedAmount,
                original_enter_date: originalEnterDate,
                // Only pass memo/notes when edited so an untouched row keeps
                // its stored values verbatim.
                ...(memo !== origMemo ? { memo } : {}),
                ...(notes !== origNotes ? { notes } : {}),
            });
        } finally {
            setSaving(false);
        }
    }, [saving, description, otherAccountGuid, debit, credit, postDate, transaction.guid, originalEnterDate, onSave, otherAccountName, memo, notes, origMemo, origNotes]);

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
    const balanceValue = applyBalanceReversal(parseFloat(transaction.running_balance), accountType, balanceReversal);

    return (
        <>
        <tr className="bg-primary/5 ring-2 ring-primary/30 ring-inset">
            {/* Reconcile checkbox column placeholder (during reconciliation) */}
            {columnCount > 6 && <td className="px-3 py-1"></td>}

            {/* Reconcile state - show existing */}
            <td className="px-3 py-1 align-middle">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">
                    {transaction.account_split_reconcile_state === 'y' ? 'Y' : transaction.account_split_reconcile_state === 'c' ? 'C' : 'N'}
                </span>
            </td>

            {/* Date */}
            <td className="px-2 py-1 align-middle">
                <input
                    ref={dateRef}
                    type="text"
                    value={dateDisplay}
                    onChange={(e) => setDateDisplay(e.target.value)}
                    onFocus={() => dateRef.current?.select()}
                    onBlur={() => {
                        const parsed = parseDateInput(dateDisplay);
                        if (parsed) {
                            setPostDate(parsed);
                            setDateDisplay(formatDateForDisplay(parsed, dateFormat));
                        } else {
                            setDateDisplay(formatDateForDisplay(postDate, dateFormat));
                        }
                    }}
                    onKeyDown={handleDateKeyDown}
                    placeholder="MM/DD/YYYY"
                    className="w-full bg-input-bg border border-border rounded px-2 py-0.5 text-xs text-foreground focus:outline-none focus:border-primary/50 font-mono leading-tight"
                />
            </td>

            {/* Description */}
            <td className="px-2 py-1 align-middle">
                <DescriptionAutocomplete
                    value={description}
                    onChange={setDescription}
                    accountGuid={accountGuid}
                    placeholder="Description..."
                    className="text-xs"
                    compact
                />
            </td>

            {/* Transfer Account */}
            <td className="px-2 py-1 align-middle">
                <AccountSelector
                    value={otherAccountGuid}
                    onChange={(guid, name) => { setOtherAccountGuid(guid); setOtherAccountName(name); }}
                    placeholder="Account..."
                    compact
                />
            </td>

            {/* Debit */}
            <td className="px-2 py-1 align-middle">
                <div className="relative">
                    <input
                        type="text"
                        inputMode="decimal"
                        value={debit}
                        onChange={(e) => { setDebit(e.target.value); if (e.target.value) setCredit(''); }}
                        onBlur={handleDebitBlur}
                        onKeyDown={handleDebitKeyDown}
                        placeholder="0.00"
                        className="w-full bg-input-bg border border-border rounded px-2 py-0.5 text-xs text-foreground text-right focus:outline-none focus:border-primary/50 font-mono leading-tight"
                    />
                    {containsMathExpression(debit) && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-primary pointer-events-none">=</span>
                    )}
                </div>
            </td>

            {/* Credit */}
            <td className="px-2 py-1 align-middle">
                <div className="relative">
                    <input
                        type="text"
                        inputMode="decimal"
                        value={credit}
                        onChange={(e) => { setCredit(e.target.value); if (e.target.value) setDebit(''); }}
                        onBlur={handleCreditBlur}
                        placeholder="0.00"
                        className="w-full bg-input-bg border border-border rounded px-2 py-0.5 text-xs text-foreground text-right focus:outline-none focus:border-primary/50 font-mono leading-tight"
                    />
                    {containsMathExpression(credit) && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-primary pointer-events-none">=</span>
                    )}
                </div>
            </td>

            {/* Running balance (stale during edit) */}
            <td className="px-4 py-1 text-xs font-mono text-right align-middle opacity-40">
                {formatCurrency(balanceValue, transaction.commodity_mnemonic)}
            </td>
        </tr>
        {doubleLine && (
            /* GnuCash double-line register: notes under Description, this
               account's split memo under Transfer */
            <tr className="bg-primary/5">
                {columnCount > 6 && <td className="px-3 py-1"></td>}
                <td className="px-3 py-1"></td>
                <td className="px-2 py-1"></td>
                <td className="px-2 py-1 align-middle">
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] uppercase tracking-wider text-foreground-muted flex-shrink-0">Notes</span>
                        <input
                            type="text"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Transaction notes..."
                            aria-label="Transaction notes"
                            className="flex-1 min-w-0 bg-transparent text-xs text-foreground-secondary placeholder-foreground-muted/60 outline-none border-b border-transparent focus:border-primary/50"
                        />
                    </div>
                </td>
                <td className="px-2 py-1 align-middle">
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] uppercase tracking-wider text-foreground-muted flex-shrink-0">Memo</span>
                        <input
                            type="text"
                            value={memo}
                            onChange={(e) => setMemo(e.target.value)}
                            placeholder="Split memo..."
                            aria-label="Split memo"
                            className="flex-1 min-w-0 bg-transparent text-xs text-foreground-secondary placeholder-foreground-muted/60 outline-none border-b border-transparent focus:border-primary/50"
                        />
                    </div>
                </td>
                <td className="px-2 py-1"></td>
                <td className="px-2 py-1"></td>
                <td className="px-4 py-1"></td>
            </tr>
        )}
        </>
    );
}
