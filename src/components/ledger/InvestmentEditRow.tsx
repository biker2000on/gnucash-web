'use client';
import { useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { AccountTransaction } from '@/components/AccountLedger';
import { DateCell } from './cells/DateCell';
import { DescriptionCell } from './cells/DescriptionCell';
import { AccountCell } from './cells/AccountCell';
import { AmountCell } from './cells/AmountCell';
import { formatCurrency } from '@/lib/format';
import { formatDisplayAccountPath } from '@/lib/account-path';
import { toLocalDateString } from '@/lib/datePresets';
import { transformToInvestmentRow, isMultiSplitTransaction } from './investment-utils';

export interface InvestmentEditRowHandle {
    save: () => Promise<boolean>;
    isDirty: () => boolean;
}

export interface InvestmentSaveData {
    post_date: string;
    description: string;
    transferAccountGuid: string;
    transferAccountName: string;
    shares: string;
    price: string;
    total: string;
    isBuy: boolean;
    original_enter_date?: string;
}

interface InvestmentEditRowProps {
    transaction: AccountTransaction;
    accountGuid: string;
    isActive: boolean;
    showCheckbox: boolean;
    isChecked: boolean;
    onToggleCheck: (e?: React.MouseEvent) => void;
    onSave: (guid: string, data: InvestmentSaveData) => Promise<void>;
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
}

export const InvestmentEditRow = forwardRef<InvestmentEditRowHandle, InvestmentEditRowProps>(
    function InvestmentEditRow({
        transaction,
        accountGuid,
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
    }, ref) {
        const handleRowClick = (e: React.MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('input[type="checkbox"], button, a')) return;
            onClick?.();
        };

        const isMultiSplit = isMultiSplitTransaction(transaction.splits);
        const invRow = transformToInvestmentRow(
            transaction as AccountTransaction & { share_balance?: string; cost_basis?: string },
            accountGuid,
        );

        // Initial values from existing transaction
        const initShares = invRow.shares != null ? Math.abs(invRow.shares).toFixed(4) : '';
        const initPrice = invRow.price != null ? invRow.price.toFixed(4) : '';
        const initTotal = (invRow.buyAmount ?? invRow.sellAmount ?? 0);
        const initTotalStr = initTotal > 0 ? initTotal.toFixed(2) : '';
        const initIsBuy = invRow.transactionType !== 'sell';

        const [postDate, setPostDate] = useState(
            transaction.post_date ? toLocalDateString(new Date(transaction.post_date)) : ''
        );
        const [description, setDescription] = useState(transaction.description || '');
        const [transferAccountGuid, setTransferAccountGuid] = useState(invRow.transferAccountGuid);
        const [transferAccountName, setTransferAccountName] = useState(invRow.transferAccount);
        const [userSharesStr, setUserSharesStr] = useState(initShares);
        const [userPriceStr, setUserPriceStr] = useState(initPrice);
        const [userTotalStr, setUserTotalStr] = useState(initTotalStr);
        const [isBuy, setIsBuy] = useState(initIsBuy);
        // 'price' means price is auto-calculated from shares+total
        // 'total' means total is auto-calculated from shares+price
        const [autoCalcField, setAutoCalcField] = useState<'price' | 'total'>('price');
        const [saveError, setSaveError] = useState(false);

        const originalEnterDate = transaction.enter_date
            ? new Date(transaction.enter_date).toISOString()
            : undefined;

        // Derived auto-calc values (computed during render, no useEffect)
        const sharesNum = parseFloat(userSharesStr);
        const userPrice = parseFloat(userPriceStr);
        const userTotal = parseFloat(userTotalStr);

        let displayPrice: string;
        let displayTotal: string;

        if (autoCalcField === 'price') {
            displayTotal = userTotalStr;
            displayPrice = (!isNaN(sharesNum) && sharesNum > 0 && !isNaN(userTotal) && userTotal > 0)
                ? (userTotal / sharesNum).toFixed(4)
                : userPriceStr;
        } else {
            displayPrice = userPriceStr;
            displayTotal = (!isNaN(sharesNum) && sharesNum > 0 && !isNaN(userPrice) && userPrice > 0)
                ? (sharesNum * userPrice).toFixed(2)
                : userTotalStr;
        }

        const isDirty = useCallback(() => {
            const origDate = transaction.post_date ? toLocalDateString(new Date(transaction.post_date)) : '';
            return postDate !== origDate
                || description !== (transaction.description || '')
                || transferAccountGuid !== invRow.transferAccountGuid
                || userSharesStr !== initShares
                || userPriceStr !== initPrice
                || userTotalStr !== initTotalStr
                || isBuy !== initIsBuy;
        }, [postDate, description, transferAccountGuid, userSharesStr, userPriceStr, userTotalStr, isBuy,
            transaction, invRow.transferAccountGuid, initShares, initPrice, initTotalStr, initIsBuy]);

        const save = useCallback(async (): Promise<boolean> => {
            if (!isDirty()) return true;
            const shares = parseFloat(userSharesStr);
            const finalTotal = autoCalcField === 'total' ? parseFloat(displayTotal) : parseFloat(userTotalStr);
            const finalPrice = autoCalcField === 'price' ? parseFloat(displayPrice) : parseFloat(userPriceStr);
            if (!description.trim() || !transferAccountGuid || isNaN(shares) || shares <= 0) return false;
            if (isNaN(finalTotal) || finalTotal <= 0) return false;
            try {
                setSaveError(false);
                await onSave(transaction.guid, {
                    post_date: postDate,
                    description: description.trim(),
                    transferAccountGuid,
                    transferAccountName,
                    shares: shares.toFixed(4),
                    price: (isNaN(finalPrice) ? 0 : finalPrice).toFixed(4),
                    total: finalTotal.toFixed(2),
                    isBuy,
                    original_enter_date: originalEnterDate,
                });
                return true;
            } catch {
                setSaveError(true);
                return false;
            }
        }, [isDirty, description, transferAccountGuid, transferAccountName, userSharesStr,
            userPriceStr, userTotalStr, displayPrice, displayTotal, autoCalcField,
            postDate, transaction.guid, originalEnterDate, onSave, isBuy]);

        useImperativeHandle(ref, () => ({ save, isDirty }), [save, isDirty]);

        const reconcileState = transaction.account_split_reconcile_state;
        const reconcileIcon = reconcileState === 'y' ? 'Y' : reconcileState === 'c' ? 'C' : 'N';

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
            <td className="px-4 py-2 align-middle">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-foreground-muted bg-surface/10">
                    {reconcileIcon}
                </span>
            </td>
        );

        const actionsCell = (
            <td className="px-2 py-2 align-middle">
                <div className="flex items-center gap-1">
                    {onDuplicate && (
                        <button
                            onClick={() => onDuplicate(transaction.guid)}
                            className="text-foreground-muted hover:text-emerald-400 transition-colors"
                            title="Duplicate (d)"
                        >
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
                        className="text-foreground-muted hover:text-cyan-400 transition-colors"
                        title="Edit in modal"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                </div>
            </td>
        );

        // Multi-split: read-only row with "click to edit in modal" hint
        if (isMultiSplit) {
            return (
                <tr className={rowClass} onClick={handleRowClick}>
                    {checkboxCell}
                    {reconcileCell}
                    <td className="px-6 py-4 text-xs text-foreground-secondary font-mono">
                        {new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                    </td>
                    <td className="px-6 py-4 text-sm text-foreground">
                        <span className="font-medium">{transaction.description}</span>
                    </td>
                    <td className="px-6 py-4 text-sm text-foreground-muted italic text-xs">
                        {invRow.transferAccount || '\u2014'}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right">
                        {invRow.shares != null ? invRow.shares.toFixed(4) : '\u2014'}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right">
                        {invRow.price != null ? formatCurrency(invRow.price, invRow.currencyMnemonic) : '\u2014'}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right text-emerald-400">
                        {invRow.buyAmount != null ? formatCurrency(invRow.buyAmount, invRow.currencyMnemonic) : ''}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right text-rose-400">
                        {invRow.sellAmount != null ? formatCurrency(invRow.sellAmount, invRow.currencyMnemonic) : ''}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right font-bold text-foreground">
                        {invRow.shareBalance.toFixed(4)}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right font-bold text-foreground">
                        {formatCurrency(invRow.costBasis, invRow.currencyMnemonic)}
                    </td>
                    <td className="px-2 py-4 align-top">
                        <div className="flex items-center gap-1">
                            {onDuplicate && (
                                <button
                                    onClick={() => onDuplicate(transaction.guid)}
                                    className="text-foreground-muted hover:text-emerald-400 transition-colors"
                                    title="Duplicate (d)"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                </button>
                            )}
                            <button
                                onClick={() => onEditModal(transaction.guid)}
                                className="text-amber-400 hover:text-amber-300 transition-colors text-xs italic"
                                title="Multi-split: edit in modal"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                            </button>
                        </div>
                    </td>
                </tr>
            );
        }

        // Non-active: read-only display
        if (!isActive) {
            return (
                <tr className={rowClass} onClick={handleRowClick}>
                    {checkboxCell}
                    {reconcileCell}
                    <td className="px-6 py-4 text-xs text-foreground-secondary font-mono">
                        {new Date(transaction.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                    </td>
                    <td className="px-6 py-4 text-sm text-foreground font-medium">{transaction.description}</td>
                    <td className="px-6 py-4 text-sm text-foreground-secondary">
                        {formatDisplayAccountPath(invRow.transferAccount, invRow.transferAccount)}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right">
                        {invRow.shares != null ? (
                            <span className={invRow.shares > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                {invRow.shares.toFixed(4)}
                            </span>
                        ) : <span className="opacity-30">&mdash;</span>}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right text-foreground">
                        {invRow.price != null ? formatCurrency(invRow.price, invRow.currencyMnemonic) : <span className="opacity-30">&mdash;</span>}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right text-emerald-400">
                        {invRow.buyAmount != null ? formatCurrency(invRow.buyAmount, invRow.currencyMnemonic) : <span className="opacity-30">&mdash;</span>}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right text-rose-400">
                        {invRow.sellAmount != null ? formatCurrency(invRow.sellAmount, invRow.currencyMnemonic) : <span className="opacity-30">&mdash;</span>}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right font-bold text-foreground">
                        {invRow.shareBalance.toFixed(4)}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono text-right font-bold text-foreground">
                        {formatCurrency(invRow.costBasis, invRow.currencyMnemonic)}
                    </td>
                    {actionsCell}
                </tr>
            );
        }

        // Active editable row with auto-calc triangle
        return (
            <tr className={rowClass}>
                {checkboxCell}
                {reconcileCell}
                {/* Date */}
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
                {/* Description */}
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
                {/* Transfer Account */}
                <td className="px-2 py-2 align-middle">
                    <AccountCell
                        value={transferAccountGuid}
                        onChange={(guid, name) => { setTransferAccountGuid(guid); setTransferAccountName(name); }}
                        autoFocus={focusedColumn === 2}
                        onEnter={onEnter}
                        onArrowUp={onArrowUp}
                        onArrowDown={onArrowDown}
                        onFocus={() => onColumnFocus?.(2)}
                    />
                </td>
                {/* Shares */}
                <td className="px-2 py-2 align-middle">
                    <AmountCell
                        value={userSharesStr}
                        onChange={setUserSharesStr}
                        autoFocus={focusedColumn === 3}
                        onEnter={onEnter}
                        onArrowUp={onArrowUp}
                        onArrowDown={onArrowDown}
                        onFocus={() => onColumnFocus?.(3)}
                    />
                </td>
                {/* Price (may be auto-calculated) */}
                <td className="px-2 py-2 align-middle">
                    <div className="relative">
                        <input
                            type="text"
                            inputMode="decimal"
                            value={displayPrice}
                            onChange={(e) => {
                                setUserPriceStr(e.target.value);
                                setAutoCalcField('total');
                            }}
                            onFocus={() => {
                                onColumnFocus?.(4);
                                // If user focuses price, switch to calc total
                                if (autoCalcField === 'price') {
                                    // Keep current displayed price as user value
                                    setUserPriceStr(displayPrice);
                                    setAutoCalcField('total');
                                }
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
                                else if (e.key === 'ArrowUp') { e.preventDefault(); onArrowUp?.(); }
                                else if (e.key === 'ArrowDown') { e.preventDefault(); onArrowDown?.(); }
                            }}
                            placeholder="0.0000"
                            className={`w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-right focus:outline-none focus:border-cyan-500/50 font-mono ${autoCalcField === 'price' ? 'italic text-foreground-muted' : 'text-foreground'}`}
                        />
                    </div>
                </td>
                {/* Buy total */}
                <td className="px-2 py-2 align-middle">
                    {isBuy ? (
                        <div className="relative">
                            <input
                                type="text"
                                inputMode="decimal"
                                value={autoCalcField === 'total' ? displayTotal : userTotalStr}
                                onChange={(e) => {
                                    setUserTotalStr(e.target.value);
                                    setAutoCalcField('price');
                                }}
                                onFocus={() => {
                                    onColumnFocus?.(5);
                                    if (autoCalcField === 'total') {
                                        setUserTotalStr(displayTotal);
                                        setAutoCalcField('price');
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
                                    else if (e.key === 'ArrowUp') { e.preventDefault(); onArrowUp?.(); }
                                    else if (e.key === 'ArrowDown') { e.preventDefault(); onArrowDown?.(); }
                                }}
                                placeholder="0.00"
                                className={`w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-right focus:outline-none focus:border-cyan-500/50 font-mono ${autoCalcField === 'total' ? 'italic text-foreground-muted' : 'text-emerald-400'}`}
                            />
                        </div>
                    ) : (
                        <button
                            onClick={() => {
                                setIsBuy(true);
                                // Move total value to buy
                                setAutoCalcField('price');
                            }}
                            className="w-full text-center text-foreground-muted hover:text-emerald-400 transition-colors text-xs py-1"
                            tabIndex={-1}
                        >
                            &mdash;
                        </button>
                    )}
                </td>
                {/* Sell total */}
                <td className="px-2 py-2 align-middle">
                    {!isBuy ? (
                        <div className="relative">
                            <input
                                type="text"
                                inputMode="decimal"
                                value={autoCalcField === 'total' ? displayTotal : userTotalStr}
                                onChange={(e) => {
                                    setUserTotalStr(e.target.value);
                                    setAutoCalcField('price');
                                }}
                                onFocus={() => {
                                    onColumnFocus?.(6);
                                    if (autoCalcField === 'total') {
                                        setUserTotalStr(displayTotal);
                                        setAutoCalcField('price');
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
                                    else if (e.key === 'ArrowUp') { e.preventDefault(); onArrowUp?.(); }
                                    else if (e.key === 'ArrowDown') { e.preventDefault(); onArrowDown?.(); }
                                }}
                                placeholder="0.00"
                                className={`w-full bg-input-bg border border-border rounded px-2 py-1 text-xs text-right focus:outline-none focus:border-cyan-500/50 font-mono ${autoCalcField === 'total' ? 'italic text-foreground-muted' : 'text-rose-400'}`}
                            />
                        </div>
                    ) : (
                        <button
                            onClick={() => {
                                setIsBuy(false);
                                setAutoCalcField('price');
                            }}
                            className="w-full text-center text-foreground-muted hover:text-rose-400 transition-colors text-xs py-1"
                            tabIndex={-1}
                        >
                            &mdash;
                        </button>
                    )}
                </td>
                {/* Share Balance (read-only) */}
                <td className="px-6 py-2 text-sm font-mono text-right align-middle opacity-40 font-bold">
                    {invRow.shareBalance.toFixed(4)}
                </td>
                {/* Cost Basis (read-only) */}
                <td className="px-6 py-2 text-sm font-mono text-right align-middle opacity-40 font-bold">
                    {formatCurrency(invRow.costBasis, invRow.currencyMnemonic)}
                </td>
                {actionsCell}
            </tr>
        );
    }
);
