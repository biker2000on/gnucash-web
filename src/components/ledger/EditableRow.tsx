'use client';
import { useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { AccountTransaction } from '@/components/AccountLedger';
import { DateCell } from './cells/DateCell';
import { DescriptionCell } from './cells/DescriptionCell';
import { AccountCell } from './cells/AccountCell';
import { AmountCell } from './cells/AmountCell';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

export interface EditableRowHandle {
    save: () => Promise<boolean>;
    isDirty: () => boolean;
}

interface EditableRowProps {
    transaction: AccountTransaction;
    accountGuid: string;
    accountType: string;
    isActive: boolean;
    showCheckbox: boolean;
    isChecked: boolean;
    onToggleCheck: (e?: React.MouseEvent) => void;
    onSave: (guid: string, data: {
        post_date: string;
        description: string;
        accountGuid: string;
        amount: string;
        original_enter_date?: string;
    }) => Promise<void>;
    onEditModal: (guid: string) => void;
    columnCount: number;
    onClick?: () => void;
    focusedColumn?: number;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    onColumnFocus?: (columnIndex: number) => void;
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
        onClick,
        focusedColumn,
        onEnter,
        onArrowUp,
        onArrowDown,
        onColumnFocus,
    }, ref) {
        const handleRowClick = (e: React.MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('input[type="checkbox"], button, a')) return;
            onClick?.();
        };
        const { balanceReversal } = useUserPreferences();
        const isMultiSplit = (transaction.splits?.length || 0) > 2;
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

        const checkboxCell = showCheckbox && (
            <td className="px-4 py-4 align-top">
                <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => onToggleCheck(e.nativeEvent as unknown as React.MouseEvent)}
                    tabIndex={-1}
                    className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-cyan-500 focus:ring-cyan-500/50 cursor-pointer"
                />
            </td>
        );

        const reconcileCell = (
            <td className="px-4 py-4 align-top">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">
                    {reconcileIcon}
                </span>
            </td>
        );

        const editButton = (
            <td className="px-2 py-4 align-top">
                <button onClick={() => onEditModal(transaction.guid)} className="text-foreground-muted hover:text-cyan-400 transition-colors" title="Edit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                </button>
            </td>
        );

        // Multi-split: read-only with edit button
        if (isMultiSplit) {
            const otherSplits = transaction.splits?.filter(s => s.account_guid !== accountGuid) || [];
            return (
                <tr className={rowClass} onClick={handleRowClick}>
                    {checkboxCell}
                    {reconcileCell}
                    <td className="px-6 py-4 text-xs text-foreground-secondary font-mono">
                        {new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                    </td>
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
                        {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                    </td>
                    {editButton}
                </tr>
            );
        }

        // 2-split: read-only when not active
        if (!isActive) {
            return (
                <tr className={rowClass} onClick={handleRowClick}>
                    {checkboxCell}
                    {reconcileCell}
                    <td className="px-6 py-4 text-xs text-foreground-secondary font-mono">
                        {new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                    </td>
                    <td className="px-6 py-4 text-sm text-foreground font-medium">{transaction.description}</td>
                    <td className="px-6 py-4 text-sm text-foreground-secondary">{otherSplit?.account_name || ''}</td>
                    <td className={`px-6 py-4 text-sm font-mono text-right ${parseFloat(transaction.account_split_value) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {formatCurrency(transaction.account_split_value, transaction.commodity_mnemonic)}
                    </td>
                    <td className={`px-6 py-4 text-sm font-mono text-right font-bold ${balanceValue !== null && balanceValue < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                    </td>
                    {editButton}
                </tr>
            );
        }

        // Active editable row
        return (
            <tr className={rowClass}>
                {checkboxCell}
                <td className="px-4 py-2 align-middle">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">
                        {reconcileIcon}
                    </span>
                </td>
                <td className="px-2 py-2 align-middle">
                    <DateCell
                        value={postDate}
                        onChange={setPostDate}
                        autoFocus={focusedColumn === 0}
                        onEnter={onEnter}
                        onArrowUp={onArrowUp}
                        onArrowDown={onArrowDown}
                        onFocus={() => onColumnFocus?.(0)}
                    />
                </td>
                <td className="px-2 py-2 align-middle">
                    <DescriptionCell
                        value={description}
                        onChange={setDescription}
                        autoFocus={focusedColumn === 1}
                        onEnter={onEnter}
                        onArrowUp={onArrowUp}
                        onArrowDown={onArrowDown}
                        onFocus={() => onColumnFocus?.(1)}
                    />
                </td>
                <td className="px-2 py-2 align-middle">
                    <AccountCell
                        value={otherAccountGuid}
                        onChange={setOtherAccountGuid}
                        autoFocus={focusedColumn === 2}
                        onEnter={onEnter}
                        onArrowUp={onArrowUp}
                        onArrowDown={onArrowDown}
                        onFocus={() => onColumnFocus?.(2)}
                    />
                </td>
                <td className="px-2 py-2 align-middle">
                    <AmountCell
                        value={amount}
                        onChange={setAmount}
                        autoFocus={focusedColumn === 3}
                        onEnter={onEnter}
                        onArrowUp={onArrowUp}
                        onArrowDown={onArrowDown}
                        onFocus={() => onColumnFocus?.(3)}
                    />
                </td>
                <td className="px-6 py-2 text-sm font-mono text-right align-middle opacity-40">
                    {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                </td>
                <td className="px-2 py-2 align-middle">
                    <button onClick={() => onEditModal(transaction.guid)} className="text-foreground-muted hover:text-cyan-400 transition-colors" title="Edit">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                </td>
            </tr>
        );
    }
);
