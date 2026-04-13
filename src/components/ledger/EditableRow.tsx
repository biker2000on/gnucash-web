'use client';
import React, { useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { AccountTransaction } from '@/components/AccountLedger';
import { DateCell } from './cells/DateCell';
import { DescriptionCell } from './cells/DescriptionCell';
import { AccountCell } from './cells/AccountCell';
import { AmountCell } from './cells/AmountCell';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { formatDisplayAccountPath } from '@/lib/account-path';
import { toLocalDateString } from '@/lib/datePresets';
import { isMultiSplitTransaction } from './investment-utils';

export interface EditableRowHandle {
    save: () => Promise<boolean>;
    isDirty: () => boolean;
    getTransactionData: () => { post_date: string; description: string; currency_guid: string };
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
        accountName: string;
        amount: string;
        original_enter_date?: string;
    }) => Promise<void>;
    onEditModal: (guid: string) => void;
    onDuplicate?: (guid: string) => void;
    columnCount: number;
    onClick?: () => void;
    focusedColumn?: number;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    onColumnFocus?: (columnIndex: number) => void;
    onTabFromActions?: (direction: 'next' | 'previous') => void;
    ledgerViewStyle?: 'basic' | 'journal' | 'autosplit';
    onTabToSplits?: () => void;
    onShiftTabFromDate?: () => void;
    columnIds?: string[];
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
        onDuplicate,
        onClick,
        focusedColumn,
        onEnter,
        onArrowUp,
        onArrowDown,
        onColumnFocus,
        onTabFromActions,
        ledgerViewStyle,
        onTabToSplits,
        onShiftTabFromDate,
        columnIds,
    }, ref) {
        const handleRowClick = (e: React.MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('input[type="checkbox"], button, a')) return;
            onClick?.();
        };
        const { balanceReversal } = useUserPreferences();
        const isSlimMode = ledgerViewStyle === 'journal' || ledgerViewStyle === 'autosplit';
        const isMultiSplit = isMultiSplitTransaction(transaction.splits);
        const otherSplit = transaction.splits?.find(s => s.account_guid !== accountGuid);

        const [postDate, setPostDate] = useState(
            transaction.post_date ? toLocalDateString(new Date(transaction.post_date)) : ''
        );
        const [description, setDescription] = useState(transaction.description || '');
        const [otherAccountGuid, setOtherAccountGuid] = useState(otherSplit?.account_guid || '');
        const [otherAccountName, setOtherAccountName] = useState(otherSplit?.account_name || '');
        const splitValue = parseFloat(transaction.account_split_value);
        const [debit, setDebit] = useState(splitValue >= 0 ? Math.abs(splitValue).toFixed(2) : '');
        const [credit, setCredit] = useState(splitValue < 0 ? Math.abs(splitValue).toFixed(2) : '');
        const [saveError, setSaveError] = useState(false);

        const originalEnterDate = transaction.enter_date
            ? new Date(transaction.enter_date).toISOString()
            : undefined;

        const isDirty = useCallback(() => {
            const origDate = transaction.post_date ? toLocalDateString(new Date(transaction.post_date)) : '';
            const origDebit = splitValue >= 0 ? Math.abs(splitValue).toFixed(2) : '';
            const origCredit = splitValue < 0 ? Math.abs(splitValue).toFixed(2) : '';
            return postDate !== origDate
                || description !== (transaction.description || '')
                || otherAccountGuid !== (otherSplit?.account_guid || '')
                || debit !== origDebit
                || credit !== origCredit;
        }, [postDate, description, otherAccountGuid, debit, credit, splitValue, transaction, otherSplit]);

        const save = useCallback(async (): Promise<boolean> => {
            if (isSlimMode) return true; // Parent handles save in journal/autosplit
            if (!isDirty()) return true;
            const hasAmount = (debit && parseFloat(debit) > 0) || (credit && parseFloat(credit) > 0);
            if (!description.trim() || !otherAccountGuid || !hasAmount) return false;
            try {
                setSaveError(false);
                // Pass signed amount: positive for debit, negative for credit
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
                });
                return true;
            } catch {
                setSaveError(true);
                return false;
            }
        }, [isDirty, description, otherAccountGuid, debit, credit, postDate, transaction.guid, originalEnterDate, onSave, otherAccountName]);

        useImperativeHandle(ref, () => ({
            save,
            isDirty,
            getTransactionData: () => ({
                post_date: postDate,
                description,
                currency_guid: transaction.currency_guid,
            }),
        }), [save, isDirty, postDate, description, transaction.currency_guid]);

        const reconcileState = transaction.account_split_reconcile_state;
        const reconcileIcon = reconcileState === 'y' ? 'Y' : reconcileState === 'c' ? 'C' : 'N';
        const balanceValue = transaction.running_balance
            ? applyBalanceReversal(parseFloat(transaction.running_balance), accountType, balanceReversal)
            : null;

        const rowClass = `transition-colors ${isActive ? 'ring-2 ring-primary/30 ring-inset bg-primary/5' : 'hover:bg-white/[0.02]'} ${saveError ? 'ring-2 ring-rose-500/50 ring-inset' : ''} ${transaction.reviewed === false ? 'border-l-2 border-l-amber-500' : ''}`;

        const sourceBadge = (
            <>
                {transaction.source === 'payslip' && transaction.match_type === 'payslip_verified' && (
                    <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wider font-bold">Payslip Verified</span>
                )}
                {transaction.source === 'payslip' && transaction.match_type !== 'payslip_verified' && (
                    <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wider font-bold">Payslip</span>
                )}
                {transaction.source && transaction.source !== 'manual' && transaction.source !== 'payslip' && (
                    <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider font-bold">Imported</span>
                )}
            </>
        );

        // Build cell map keyed by column ID, then render in columnIds order.
        // Any column ID not in the map gets an empty <td>.
        const renderCells = (cellMap: Record<string, React.ReactNode>) => {
            if (!columnIds) {
                // Fallback: render cells in map order (legacy behavior)
                return Object.entries(cellMap).map(([id, cell]) => (
                    <React.Fragment key={id}>{cell}</React.Fragment>
                ));
            }
            return columnIds.map(id => {
                if (id in cellMap) return <React.Fragment key={id}>{cellMap[id]}</React.Fragment>;
                return <td key={id} className="px-2 py-2"></td>;
            });
        };

        const selectCell = showCheckbox ? (
            <td className="px-3 py-2 align-middle">
                <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => onToggleCheck(e.nativeEvent as unknown as React.MouseEvent)}
                    tabIndex={-1}
                    className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-primary focus:ring-primary/50 cursor-pointer"
                />
            </td>
        ) : <td className="px-3 py-2"></td>;

        const reconcileCell = (
            <td className="px-3 py-2 align-middle">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">
                    {reconcileIcon}
                </span>
            </td>
        );

        const reconcileCellCompact = (
            <td className="px-3 py-1 align-middle">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">
                    {reconcileIcon}
                </span>
            </td>
        );

        const actionsCellReadOnly = (
            <td className="px-2 py-2 align-middle">
                <div className="flex items-center gap-1">
                    {onDuplicate && (
                        <button onClick={() => onDuplicate(transaction.guid)} className="text-foreground-muted hover:text-primary transition-colors" title="Duplicate (d)">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                        </button>
                    )}
                    <button onClick={() => onEditModal(transaction.guid)} className="text-foreground-muted hover:text-primary transition-colors" title="Edit in modal">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                </div>
            </td>
        );

        const actionsCellNoTab = (
            <td className="px-2 py-1 align-middle">
                <div className="flex items-center gap-1">
                    {onDuplicate && (
                        <button onClick={() => onDuplicate(transaction.guid)} className="text-foreground-muted hover:text-primary transition-colors" title="Duplicate (d)" tabIndex={-1}>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                        </button>
                    )}
                    <button onClick={() => onEditModal(transaction.guid)} className="text-foreground-muted hover:text-primary transition-colors" title="Edit in modal" tabIndex={-1}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                </div>
            </td>
        );

        const actionsCellWithTab = (
            <td className="px-2 py-1 align-middle">
                <div className="flex items-center gap-1">
                    {onDuplicate && (
                        <button onClick={() => onDuplicate(transaction.guid)} className="text-foreground-muted hover:text-primary transition-colors" title="Duplicate (d)">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                        </button>
                    )}
                    <button
                        onClick={() => onEditModal(transaction.guid)}
                        onKeyDown={(e) => {
                            if (e.key === 'Tab') {
                                e.preventDefault();
                                onTabFromActions?.(e.shiftKey ? 'previous' : 'next');
                            }
                        }}
                        className="text-foreground-muted hover:text-primary transition-colors"
                        title="Edit in modal"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                </div>
            </td>
        );

        // Multi-split: read-only with edit button (skip in slim mode where all splits are rendered below)
        if (isMultiSplit && !isSlimMode) {
            const otherSplits = transaction.splits?.filter(s => s.account_guid !== accountGuid) || [];
            return (
                <tr className={rowClass} onClick={handleRowClick}>
                    {renderCells({
                        select: selectCell,
                        reconcile: reconcileCell,
                        date: (
                            <td className="px-4 py-2 text-[11px] text-foreground-secondary font-mono">
                                {new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                            </td>
                        ),
                        description: (
                            <td className="px-4 py-2 text-sm text-foreground leading-tight">
                                <span className="font-medium">{transaction.description}</span>
                                {sourceBadge}
                            </td>
                        ),
                        transfer: <td className="px-4 py-2 text-xs text-foreground-muted italic">-- {otherSplits.length + 1} splits --</td>,
                        debit: (
                            <td className="px-4 py-2 text-sm font-mono text-right text-emerald-400">
                                {splitValue >= 0 ? formatCurrency(splitValue, transaction.commodity_mnemonic) : ''}
                            </td>
                        ),
                        credit: (
                            <td className="px-4 py-2 text-sm font-mono text-right text-rose-400">
                                {splitValue < 0 ? formatCurrency(Math.abs(splitValue), transaction.commodity_mnemonic) : ''}
                            </td>
                        ),
                        balance: (
                            <td className={`px-4 py-2 text-sm font-mono text-right font-bold ${balanceValue !== null && balanceValue < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                            </td>
                        ),
                        actions: actionsCellReadOnly,
                    })}
                </tr>
            );
        }

        // Slim inactive row (journal/autosplit): show date + description, empty account/amount cells
        if (!isActive && isSlimMode) {
            return (
                <tr className={rowClass} onClick={handleRowClick}>
                    {renderCells({
                        select: selectCell,
                        reconcile: reconcileCell,
                        date: (
                            <td className="px-4 py-2 text-[11px] text-foreground-secondary font-mono">
                                {new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                            </td>
                        ),
                        description: (
                            <td className="px-4 py-2 text-sm text-foreground font-medium leading-tight">
                                {transaction.description}
                                {sourceBadge}
                            </td>
                        ),
                        transfer: <td className="px-4 py-2"></td>,
                        debit: <td className="px-4 py-2"></td>,
                        credit: <td className="px-4 py-2"></td>,
                        balance: (
                            <td className={`px-4 py-2 text-sm font-mono text-right font-bold ${balanceValue !== null && balanceValue < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                            </td>
                        ),
                        actions: actionsCellReadOnly,
                    })}
                </tr>
            );
        }

        // 2-split: read-only when not active
        if (!isActive) {
            return (
                <tr className={rowClass} onClick={handleRowClick}>
                    {renderCells({
                        select: selectCell,
                        reconcile: reconcileCell,
                        date: (
                            <td className="px-4 py-2 text-[11px] text-foreground-secondary font-mono">
                                {new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                            </td>
                        ),
                        description: (
                            <td className="px-4 py-2 text-sm text-foreground font-medium leading-tight">
                                {transaction.description}
                                {sourceBadge}
                            </td>
                        ),
                        transfer: (
                            <td className="px-4 py-2 text-sm text-foreground-secondary leading-tight">
                                {formatDisplayAccountPath(otherSplit?.account_fullname, otherSplit?.account_name)}
                            </td>
                        ),
                        debit: (
                            <td className="px-4 py-2 text-sm font-mono text-right text-emerald-400">
                                {splitValue >= 0 ? formatCurrency(splitValue, transaction.commodity_mnemonic) : ''}
                            </td>
                        ),
                        credit: (
                            <td className="px-4 py-2 text-sm font-mono text-right text-rose-400">
                                {splitValue < 0 ? formatCurrency(Math.abs(splitValue), transaction.commodity_mnemonic) : ''}
                            </td>
                        ),
                        balance: (
                            <td className={`px-4 py-2 text-sm font-mono text-right font-bold ${balanceValue !== null && balanceValue < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                            </td>
                        ),
                        actions: actionsCellReadOnly,
                    })}
                </tr>
            );
        }

        // Slim active row (journal/autosplit): editable date + description, empty account/amount cells
        if (isActive && isSlimMode) {
            return (
                <tr className="bg-primary/5 ring-2 ring-primary/30 ring-inset">
                    {renderCells({
                        select: selectCell,
                        reconcile: reconcileCellCompact,
                        date: (
                            <td className="px-2 py-1 align-middle">
                                <DateCell
                                    value={postDate}
                                    onChange={setPostDate}
                                    autoFocus={focusedColumn === 0}
                                    onEnter={onEnter}
                                    onArrowUp={onArrowUp}
                                    onArrowDown={onArrowDown}
                                    onFocus={() => onColumnFocus?.(0)}
                                    onShiftTab={onShiftTabFromDate}
                                />
                            </td>
                        ),
                        description: (
                            <td className="px-2 py-1 align-middle">
                                <DescriptionCell
                                    value={description}
                                    onChange={setDescription}
                                    autoFocus={focusedColumn === 1}
                                    onEnter={onEnter}
                                    onTab={() => onTabToSplits?.()}
                                    onShiftTab={() => onColumnFocus?.(0)}
                                    onArrowUp={onArrowUp}
                                    onArrowDown={onArrowDown}
                                    onFocus={() => onColumnFocus?.(1)}
                                />
                            </td>
                        ),
                        transfer: <td className="px-2 py-1 align-middle"></td>,
                        debit: <td className="px-2 py-1 align-middle"></td>,
                        credit: <td className="px-2 py-1 align-middle"></td>,
                        balance: (
                            <td className="px-4 py-1 text-xs font-mono text-right align-middle opacity-40">
                                {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                            </td>
                        ),
                        actions: actionsCellNoTab,
                    })}
                </tr>
            );
        }

        // Active editable row
        return (
            <tr className={rowClass}>
                {renderCells({
                    select: selectCell,
                    reconcile: reconcileCellCompact,
                    date: (
                        <td className="px-2 py-1 align-middle">
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
                    ),
                    description: (
                        <td className="px-2 py-1 align-middle">
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
                    ),
                    transfer: (
                        <td className="px-2 py-1 align-middle">
                            <AccountCell
                                value={otherAccountGuid}
                                onChange={(guid, name) => { setOtherAccountGuid(guid); setOtherAccountName(name); }}
                                autoFocus={focusedColumn === 2}
                                onEnter={onEnter}
                                onArrowUp={onArrowUp}
                                onArrowDown={onArrowDown}
                                onFocus={() => onColumnFocus?.(2)}
                            />
                        </td>
                    ),
                    debit: (
                        <td className="px-2 py-1 align-middle">
                            <AmountCell
                                value={debit}
                                onChange={(v) => { setDebit(v); if (v) setCredit(''); }}
                                autoFocus={focusedColumn === 3}
                                onEnter={onEnter}
                                onArrowUp={onArrowUp}
                                onArrowDown={onArrowDown}
                                onFocus={() => onColumnFocus?.(3)}
                            />
                        </td>
                    ),
                    credit: (
                        <td className="px-2 py-1 align-middle">
                            <AmountCell
                                value={credit}
                                onChange={(v) => { setCredit(v); if (v) setDebit(''); }}
                                autoFocus={focusedColumn === 4}
                                onEnter={onEnter}
                                onArrowUp={onArrowUp}
                                onArrowDown={onArrowDown}
                                onFocus={() => onColumnFocus?.(4)}
                            />
                        </td>
                    ),
                    balance: (
                        <td className="px-4 py-1 text-xs font-mono text-right align-middle opacity-40">
                            {balanceValue !== null ? formatCurrency(balanceValue, transaction.commodity_mnemonic) : '\u2014'}
                        </td>
                    ),
                    actions: actionsCellWithTab,
                })}
            </tr>
        );
    }
);
