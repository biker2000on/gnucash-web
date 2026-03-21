'use client';

import { useState, useRef, useMemo, useCallback, forwardRef, useImperativeHandle, useEffect } from 'react';
import { AccountTransaction } from '@/components/AccountLedger';
import { AccountCell } from '@/components/ledger/cells/AccountCell';
import { AmountCell } from '@/components/ledger/cells/AmountCell';
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
    // Investment fields
    shares: string;
    price: string;
    commodity_mnemonic?: string;
}

export interface EditableSplitRowsHandle {
    isDirty: () => boolean;
    getSplitPayload: () => {
        guid?: string;
        account_guid: string;
        value_num: number;
        value_denom: number;
        quantity_num: number;
        quantity_denom: number;
        memo: string;
        reconcile_state: string;
    }[];
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
    onArrowUp?: () => void;
    onArrowDownPastEnd?: () => void;
    onTabToNextTransaction?: () => void;
    onShiftTabToTransaction?: () => void; // Shift-tab from first split → transaction description
    /** Override trailing column count for investment accounts (default: 2 for balance + actions) */
    trailingColumns?: number;
    /** If true, render investment-style columns: memo, account, shares, price, buy, sell */
    isInvestmentAccount?: boolean;
}

function initSplitsFromTransaction(transaction: AccountTransaction, includeTrading = false): SplitState[] {
    const splits: SplitState[] = (transaction.splits || [])
        .filter(s => includeTrading || !(s.account_fullname || s.account_name || '').startsWith('Trading:'))
        .map(s => {
            const val = parseFloat(String(s.value_decimal ?? 0));
            const qty = parseFloat(String(s.quantity_decimal ?? 0));
            const hasQty = Math.abs(qty) > 0.0001 && qty !== val;
            return {
                guid: s.guid,
                account_guid: s.account_guid,
                account_name: s.account_fullname || s.account_name || '',
                memo: s.memo || '',
                debit: val > 0 ? Math.abs(val).toFixed(2) : '',
                credit: val < 0 ? Math.abs(val).toFixed(2) : '',
                reconcile_state: s.reconcile_state || 'n',
                shares: hasQty ? Math.abs(qty).toFixed(4) : '',
                price: hasQty && Math.abs(qty) > 0.0001 ? Math.abs(val / qty).toFixed(2) : '',
                commodity_mnemonic: s.commodity_mnemonic || transaction.commodity_mnemonic || '',
            };
        });
    // Always append a placeholder
    splits.push({
        guid: crypto.randomUUID().replace(/-/g, ''),
        account_guid: '',
        account_name: '',
        memo: '',
        debit: '',
        credit: '',
        shares: '',
        price: '',
        reconcile_state: 'n',
        isPlaceholder: true,
    });
    return splits;
}

const EditableSplitRows = forwardRef<EditableSplitRowsHandle, EditableSplitRowsProps>(function EditableSplitRows(
    {
        transaction,
        accountGuid: _accountGuid,
        columns,
        isActive,
        focusedSplitIndex,
        focusedColumnIndex,
        onFocusedSplitChange,
        onColumnFocus,
        onArrowUp,
        onArrowDownPastEnd,
        onTabToNextTransaction,
        onShiftTabToTransaction,
        trailingColumns: trailingColumnsProp,
        isInvestmentAccount,
    },
    ref
) {
    const [splits, setSplits] = useState<SplitState[]>(() => initSplitsFromTransaction(transaction, isInvestmentAccount));
    const originalRef = useRef<string>(JSON.stringify(splits.filter(s => !s.isPlaceholder)));

    // Re-init when transaction changes externally (after save)
    const txGuidRef = useRef(transaction.guid);
    useEffect(() => {
        if (transaction.guid !== txGuidRef.current) {
            txGuidRef.current = transaction.guid;
            const newSplits = initSplitsFromTransaction(transaction, isInvestmentAccount);
            setSplits(newSplits);
            originalRef.current = JSON.stringify(newSplits.filter(s => !s.isPlaceholder));
        }
    }, [transaction]);

    // Also re-init if the transaction's splits change (e.g., after save with same guid)
    const txSplitsKeyRef = useRef(
        (transaction.splits || []).map(s => `${s.guid}:${s.value_num}/${s.value_denom}`).join(',')
    );
    useEffect(() => {
        const newKey = (transaction.splits || []).map(s => `${s.guid}:${s.value_num}/${s.value_denom}`).join(',');
        if (newKey !== txSplitsKeyRef.current) {
            txSplitsKeyRef.current = newKey;
            const newSplits = initSplitsFromTransaction(transaction, isInvestmentAccount);
            setSplits(newSplits);
            originalRef.current = JSON.stringify(newSplits.filter(s => !s.isPlaceholder));
        }
    }, [transaction]);

    // Imbalance calculation
    const splitsWithImbalance = useMemo(() => {
        const realSplits = splits.filter(s => !s.isPlaceholder);
        const sum = realSplits.reduce((acc, s) => {
            const debit = parseFloat(s.debit) || 0;
            const credit = parseFloat(s.credit) || 0;
            return acc + debit - credit;
        }, 0);

        return splits.map(s => {
            if (!s.isPlaceholder) return s;
            // Placeholder shows the negation of the sum to balance
            const balanceNeeded = -sum;
            return {
                ...s,
                debit: balanceNeeded > 0 ? balanceNeeded.toFixed(2) : '',
                credit: balanceNeeded < 0 ? Math.abs(balanceNeeded).toFixed(2) : '',
            };
        });
    }, [splits]);

    const createBlankSplit = useCallback((): SplitState => ({
        guid: crypto.randomUUID().replace(/-/g, ''),
        account_guid: '',
        account_name: '',
        memo: '',
        debit: '',
        credit: '',
        shares: '',
        price: '',
        reconcile_state: 'n',
        isPlaceholder: true,
    }), []);

    const updateSplit = useCallback((index: number, field: keyof SplitState, value: string) => {
        setSplits(prev => {
            const next = [...prev];
            const updated = { ...next[index] };
            if (field === 'debit') {
                updated.debit = value;
                if (value) updated.credit = '';
            } else if (field === 'credit') {
                updated.credit = value;
                if (value) updated.debit = '';
            } else {
                (updated as Record<string, unknown>)[field] = value;
            }
            next[index] = updated;
            return next;
        });
    }, []);

    const updateSplitAccount = useCallback((index: number, guid: string, name: string) => {
        setSplits(prev => {
            const updated = prev.map((s, i) => {
                if (i !== index) return s;
                const newSplit = { ...s, account_guid: guid, account_name: name };
                if (s.isPlaceholder && guid) {
                    // Calculate imbalance to carry over to promoted split
                    const imbalance = prev
                        .filter(sp => !sp.isPlaceholder)
                        .reduce((sum, sp) => sum + (parseFloat(sp.debit) || 0) - (parseFloat(sp.credit) || 0), 0);
                    const balancingAmount = -imbalance;
                    delete newSplit.isPlaceholder;
                    newSplit.debit = balancingAmount > 0 ? balancingAmount.toFixed(2) : '';
                    newSplit.credit = balancingAmount < 0 ? Math.abs(balancingAmount).toFixed(2) : '';
                }
                return newSplit;
            });
            const hasPlaceholder = updated.some(s => s.isPlaceholder);
            if (!hasPlaceholder) {
                updated.push(createBlankSplit());
            }
            return updated;
        });
    }, [createBlankSplit]);

    const deleteSplit = useCallback((index: number) => {
        setSplits(prev => {
            const realCount = prev.filter(s => !s.isPlaceholder).length;
            if (realCount <= 2) return prev; // Must keep at least 2 real splits
            return prev.filter((_, i) => i !== index);
        });
    }, []);

    // Imperative handle
    useImperativeHandle(ref, () => ({
        isDirty() {
            const current = JSON.stringify(splits.filter(s => !s.isPlaceholder));
            return current !== originalRef.current;
        },
        getSplitPayload() {
            return splits
                .filter(s => !s.isPlaceholder)
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
                        memo: s.memo,
                        reconcile_state: s.reconcile_state,
                    };
                });
        },
        revert() {
            const reverted = initSplitsFromTransaction(transaction, isInvestmentAccount);
            setSplits(reverted);
        },
    }), [splits, transaction]);

    // Column alignment:
    // Standard: memo(description), account(transfer), debit, credit = 4 content cols
    // Investment: memo(description), account(transfer), shares, price, buy, sell = 6 content cols
    const contentCols = isInvestmentAccount ? 6 : 4;
    const trailingEmpty = trailingColumnsProp ?? 2;
    const leadingEmpty = Math.max(0, columns - contentCols - trailingEmpty);
    const actualTrailing = columns - leadingEmpty - contentCols;

    const realSplitCount = splits.filter(s => !s.isPlaceholder).length;
    const lastSplitIndex = splitsWithImbalance.length - 1;
    // Column indices: standard = 0:memo,1:account,2:debit,3:credit
    // Investment = 0:memo,1:account,2:shares,3:price,4:buy,5:sell
    const lastColIndex = isInvestmentAccount ? 5 : 3;
    const debitColIndex = isInvestmentAccount ? 4 : 2;
    const creditColIndex = isInvestmentAccount ? 5 : 3;

    return (
        <>
            {splitsWithImbalance.map((split, index) => {
                const isFocused = isActive && focusedSplitIndex === index;
                const isPlaceholder = split.isPlaceholder;

                return (
                    <tr
                        key={split.guid}
                        data-split-row
                        className={`border-b border-border/30 ${
                            isFocused
                                ? 'bg-cyan-500/5 ring-1 ring-cyan-500/30 ring-inset'
                                : 'bg-background-secondary/30'
                        } ${isPlaceholder ? 'opacity-60' : ''}`}
                        onClick={() => onFocusedSplitChange?.(index)}
                    >
                        {/* Leading empty columns */}
                        {Array.from({ length: leadingEmpty }, (_, i) => (
                            <td key={`lead-${i}`} className="px-3 py-1.5" />
                        ))}

                        {/* Memo column */}
                        <td className="px-3 py-1.5 pl-8">
                            {isFocused ? (
                                <input
                                    type="text"
                                    value={split.memo}
                                    onChange={e => updateSplit(index, 'memo', e.target.value)}
                                    onFocus={() => onColumnFocus?.(0)}
                                    autoFocus={focusedColumnIndex === 0}
                                    placeholder="Memo..."
                                    className="w-full bg-transparent text-xs outline-none border-b border-transparent focus:border-cyan-500/50"
                                    onKeyDown={e => {
                                        if (e.key === 'ArrowUp') {
                                            e.preventDefault();
                                            if (index === 0) {
                                                onArrowUp?.();
                                            } else {
                                                onFocusedSplitChange?.(index - 1);
                                            }
                                        } else if (e.key === 'ArrowDown') {
                                            e.preventDefault();
                                            if (index === lastSplitIndex) {
                                                onArrowDownPastEnd?.();
                                            } else {
                                                onFocusedSplitChange?.(index + 1);
                                            }
                                        } else if (e.key === 'Tab' && !e.shiftKey) {
                                            e.preventDefault();
                                            onColumnFocus?.(1);
                                        } else if (e.key === 'Tab' && e.shiftKey) {
                                            e.preventDefault();
                                            if (index === 0) {
                                                onShiftTabToTransaction?.();
                                            } else {
                                                onFocusedSplitChange?.(index - 1);
                                                onColumnFocus?.(lastColIndex);
                                            }
                                        }
                                    }}
                                />
                            ) : (
                                <span className="text-xs text-foreground-muted">{split.memo || ''}</span>
                            )}
                        </td>

                        {/* Account column */}
                        <td className="px-3 py-1.5">
                            {isFocused ? (
                                <AccountCell
                                    value={split.account_guid}
                                    onChange={(guid, name) => updateSplitAccount(index, guid, name)}
                                    autoFocus={focusedColumnIndex === 1}
                                    onFocus={() => onColumnFocus?.(1)}
                                    onEnter={() => isPlaceholder ? onTabToNextTransaction?.() : onColumnFocus?.(isInvestmentAccount ? 2 : debitColIndex)}
                                    onTab={() => isPlaceholder ? onTabToNextTransaction?.() : onColumnFocus?.(isInvestmentAccount ? 2 : debitColIndex)}
                                    onShiftTab={() => onColumnFocus?.(0)}
                                    onArrowUp={() => {
                                        if (index === 0) {
                                            onArrowUp?.();
                                        } else {
                                            onFocusedSplitChange?.(index - 1);
                                        }
                                    }}
                                    onArrowDown={() => {
                                        if (index === lastSplitIndex) {
                                            onArrowDownPastEnd?.();
                                        } else {
                                            onFocusedSplitChange?.(index + 1);
                                        }
                                    }}
                                />
                            ) : (
                                <span className="text-xs text-cyan-400">
                                    {split.account_name || ''}
                                </span>
                            )}
                        </td>

                        {/* Investment: Shares column */}
                        {isInvestmentAccount && (
                            <td className="px-3 py-1.5 text-right">
                                {isFocused && !isPlaceholder ? (
                                    <AmountCell
                                        value={split.shares}
                                        onChange={v => updateSplit(index, 'shares' as keyof SplitState, v)}
                                        autoFocus={focusedColumnIndex === 2}
                                        onFocus={() => onColumnFocus?.(2)}
                                        onEnter={() => onColumnFocus?.(3)}
                                        onTab={() => onColumnFocus?.(3)}
                                        onShiftTab={() => onColumnFocus?.(1)}
                                        onArrowUp={() => { if (index === 0) onArrowUp?.(); else onFocusedSplitChange?.(index - 1); }}
                                        onArrowDown={() => { if (index === lastSplitIndex) onArrowDownPastEnd?.(); else onFocusedSplitChange?.(index + 1); }}
                                    />
                                ) : (
                                    <span className={`text-xs font-mono ${split.shares ? 'text-foreground-secondary' : ''}`}>
                                        {split.shares || ''}
                                    </span>
                                )}
                            </td>
                        )}
                        {/* Investment: Price column */}
                        {isInvestmentAccount && (
                            <td className="px-3 py-1.5 text-right">
                                {isFocused && !isPlaceholder ? (
                                    <AmountCell
                                        value={split.price}
                                        onChange={v => updateSplit(index, 'price' as keyof SplitState, v)}
                                        autoFocus={focusedColumnIndex === 3}
                                        onFocus={() => onColumnFocus?.(3)}
                                        onEnter={() => onColumnFocus?.(4)}
                                        onTab={() => onColumnFocus?.(4)}
                                        onShiftTab={() => onColumnFocus?.(2)}
                                        onArrowUp={() => { if (index === 0) onArrowUp?.(); else onFocusedSplitChange?.(index - 1); }}
                                        onArrowDown={() => { if (index === lastSplitIndex) onArrowDownPastEnd?.(); else onFocusedSplitChange?.(index + 1); }}
                                    />
                                ) : (
                                    <span className="text-xs font-mono text-foreground-secondary">
                                        {split.price || ''}
                                    </span>
                                )}
                            </td>
                        )}
                        {/* Debit/Buy column */}
                        <td className="px-3 py-1.5 text-right">
                            {isFocused && !isPlaceholder ? (
                                <AmountCell
                                    value={split.debit}
                                    onChange={v => updateSplit(index, 'debit', v)}
                                    autoFocus={focusedColumnIndex === debitColIndex}
                                    onFocus={() => onColumnFocus?.(debitColIndex)}
                                    onEnter={() => onColumnFocus?.(creditColIndex)}
                                    onTab={() => onColumnFocus?.(creditColIndex)}
                                    onShiftTab={() => onColumnFocus?.(debitColIndex - 1)}
                                    onArrowUp={() => {
                                        if (index === 0) {
                                            onArrowUp?.();
                                        } else {
                                            onFocusedSplitChange?.(index - 1);
                                        }
                                    }}
                                    onArrowDown={() => {
                                        if (index === lastSplitIndex) {
                                            onArrowDownPastEnd?.();
                                        } else {
                                            onFocusedSplitChange?.(index + 1);
                                        }
                                    }}
                                />
                            ) : (
                                <span className="text-xs text-foreground-secondary font-mono">
                                    {split.debit || ''}
                                </span>
                            )}
                        </td>

                        {/* Credit/Sell column */}
                        <td className="px-3 py-1.5 text-right">
                            {isFocused && !isPlaceholder ? (
                                <AmountCell
                                    value={split.credit}
                                    onChange={v => updateSplit(index, 'credit', v)}
                                    autoFocus={focusedColumnIndex === creditColIndex}
                                    onFocus={() => onColumnFocus?.(creditColIndex)}
                                    onShiftTab={() => onColumnFocus?.(debitColIndex)}
                                    onEnter={() => {
                                        // Enter from credit: move to next split's memo, or next transaction
                                        if (index === lastSplitIndex) {
                                            onTabToNextTransaction?.();
                                        } else {
                                            onFocusedSplitChange?.(index + 1);
                                            onColumnFocus?.(0);
                                        }
                                    }}
                                    onTab={() => {
                                        // Tab from credit: move to next split's memo, or next transaction
                                        if (index === lastSplitIndex) {
                                            onTabToNextTransaction?.();
                                        } else {
                                            onFocusedSplitChange?.(index + 1);
                                            onColumnFocus?.(0);
                                        }
                                    }}
                                    onArrowUp={() => {
                                        if (index === 0) {
                                            onArrowUp?.();
                                        } else {
                                            onFocusedSplitChange?.(index - 1);
                                        }
                                    }}
                                    onArrowDown={() => {
                                        if (index === lastSplitIndex) {
                                            onArrowDownPastEnd?.();
                                        } else {
                                            onFocusedSplitChange?.(index + 1);
                                        }
                                    }}
                                />
                            ) : (
                                <span className="text-xs text-foreground-secondary font-mono">
                                    {split.credit || ''}
                                </span>
                            )}
                        </td>

                        {/* Trailing columns (balance, actions, etc.) */}
                        {Array.from({ length: actualTrailing }, (_, i) => (
                            <td key={`trail-${i}`} className="px-3 py-1.5">
                                {i === 0 && !isPlaceholder && realSplitCount > 2 && (
                                    <button
                                        tabIndex={-1}
                                        onClick={e => {
                                            e.stopPropagation();
                                            deleteSplit(index);
                                        }}
                                        className="text-xs text-foreground-muted hover:text-red-400 transition-colors"
                                        title="Delete split"
                                    >
                                        &times;
                                    </button>
                                )}
                            </td>
                        ))}
                    </tr>
                );
            })}
        </>
    );
});

export default EditableSplitRows;
