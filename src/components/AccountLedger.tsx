"use client";

import { Transaction, Split } from '@/lib/types';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { ReconciliationPanel } from './ReconciliationPanel';
import { TransactionModal } from './TransactionModal';
import { TransactionFormModal } from './TransactionFormModal';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { InlineEditRow } from './InlineEditRow';
import { useToast } from '@/contexts/ToastContext';
import { toNumDenom } from '@/lib/validation';
import {
    useReactTable,
    getCoreRowModel,
    flexRender,
} from '@tanstack/react-table';
import { getColumns } from './ledger/columns';

export interface AccountTransaction extends Transaction {
    running_balance: string;
    account_split_value: string;
    commodity_mnemonic: string;
    account_split_guid: string;
    account_split_reconcile_state: string;
    reviewed?: boolean;
    source?: string;
}

interface AccountLedgerProps {
    accountGuid: string;
    initialTransactions: AccountTransaction[];
    startDate?: string | null;
    endDate?: string | null;
    accountCurrency?: string;
    currentBalance?: number;
    accountType?: string;
}

export default function AccountLedger({
    accountGuid,
    initialTransactions,
    startDate,
    endDate,
    accountCurrency = 'USD',
    currentBalance = 0,
    accountType = 'ASSET',
}: AccountLedgerProps) {
    const { balanceReversal } = useUserPreferences();
    const { success, error } = useToast();
    const [transactions, setTransactions] = useState<AccountTransaction[]>(initialTransactions);
    const [offset, setOffset] = useState(initialTransactions.length);
    const [hasMore, setHasMore] = useState(initialTransactions.length >= 100);
    const [loading, setLoading] = useState(false);
    const [expandedTxs, setExpandedTxs] = useState<Record<string, boolean>>({});
    const loader = useRef<HTMLDivElement>(null);

    // Reconciliation state
    const [isReconciling, setIsReconciling] = useState(false);
    const [selectedSplits, setSelectedSplits] = useState<Set<string>>(new Set());

    // Modal state
    const [selectedTxGuid, setSelectedTxGuid] = useState<string | null>(null);
    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deletingGuid, setDeletingGuid] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // Keyboard navigation state
    const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
    const [editingGuid, setEditingGuid] = useState<string | null>(null);
    const tableRef = useRef<HTMLTableElement>(null);

    // Reviewed filter state
    const [showUnreviewedOnly, setShowUnreviewedOnly] = useState(false);

    // Listen for global 'n' key shortcut to open new transaction
    useEffect(() => {
        const handler = () => {
            setEditingTransaction(null);
            setIsEditModalOpen(true);
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, []);

    const toggleSplitSelection = useCallback((splitGuid: string) => {
        setSelectedSplits(prev => {
            const newSet = new Set(prev);
            if (newSet.has(splitGuid)) {
                newSet.delete(splitGuid);
            } else {
                newSet.add(splitGuid);
            }
            return newSet;
        });
    }, []);

    const selectAllUnreconciled = useCallback(() => {
        const unreconciledSplits = transactions
            .filter(tx => tx.account_split_reconcile_state !== 'y')
            .map(tx => tx.account_split_guid);
        setSelectedSplits(new Set(unreconciledSplits));
    }, [transactions]);

    const clearSelection = useCallback(() => {
        setSelectedSplits(new Set());
    }, []);

    // Calculate the sum of selected splits for reconciliation
    const selectedBalance = useMemo(() => {
        let sum = 0;
        for (const tx of transactions) {
            if (selectedSplits.has(tx.account_split_guid)) {
                sum += parseFloat(tx.account_split_value) || 0;
            }
        }
        return sum;
    }, [transactions, selectedSplits]);

    const handleReconcileComplete = useCallback(() => {
        // Refresh the transactions to show updated reconcile states
        setTransactions(prev => prev.map(tx => {
            if (selectedSplits.has(tx.account_split_guid)) {
                return { ...tx, account_split_reconcile_state: 'y' };
            }
            return tx;
        }));
        setSelectedSplits(new Set());
        setIsReconciling(false);
    }, [selectedSplits]);

    // Build URL params helper (needed by fetchTransactions)
    const buildUrlParams = useCallback((extraParams: Record<string, string | number> = {}) => {
        const params = new URLSearchParams();
        params.set('limit', '100');
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        if (showUnreviewedOnly) params.set('unreviewedOnly', 'true');
        Object.entries(extraParams).forEach(([key, value]) => {
            params.set(key, String(value));
        });
        return params.toString();
    }, [startDate, endDate, showUnreviewedOnly]);

    // Refresh transactions helper
    const fetchTransactions = useCallback(async () => {
        try {
            const params = buildUrlParams();
            const res = await fetch(`/api/accounts/${accountGuid}/transactions?${params}`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data: AccountTransaction[] = await res.json();
            setTransactions(data);
            setOffset(data.length);
            setHasMore(data.length >= 100);
        } catch (error) {
            console.error('Error fetching transactions:', error);
        }
    }, [accountGuid, buildUrlParams]);

    // Transaction row click handler
    const handleRowClick = useCallback((txGuid: string) => {
        setSelectedTxGuid(txGuid);
        setIsViewModalOpen(true);
    }, []);

    // Edit handler
    const handleEdit = useCallback((guid: string) => {
        const tx = transactions.find(t => t.guid === guid);
        setEditingTransaction(tx || null);
        setIsViewModalOpen(false);
        setIsEditModalOpen(true);
    }, [transactions]);

    // Delete handlers
    const handleDeleteClick = useCallback((guid: string) => {
        setDeletingGuid(guid);
        setDeleteConfirmOpen(true);
        setIsViewModalOpen(false);
    }, []);

    const handleDeleteConfirm = useCallback(async () => {
        if (!deletingGuid) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/transactions/${deletingGuid}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete');
            success('Transaction deleted successfully');
            fetchTransactions();
        } catch (err) {
            console.error('Delete failed:', err);
            error('Failed to delete transaction');
        } finally {
            setIsDeleting(false);
            setDeleteConfirmOpen(false);
            setDeletingGuid(null);
        }
    }, [deletingGuid, fetchTransactions, success, error]);

    // Inline edit save handler
    const handleInlineSave = useCallback(async (guid: string, data: {
        post_date: string;
        description: string;
        accountGuid: string;
        amount: string;
        original_enter_date?: string;
    }) => {
        try {
            // Build a PUT request to update the transaction
            // We need to find the current transaction to get the currency_guid
            const tx = transactions.find(t => t.guid === guid);
            if (!tx) return;

            const amountValue = parseFloat(data.amount);
            const { num: valueNum, denom: valueDenom } = toNumDenom(amountValue);
            const { num: negValueNum, denom: negValueDenom } = toNumDenom(-amountValue);

            const body: Record<string, unknown> = {
                currency_guid: tx.currency_guid,
                post_date: data.post_date,
                description: data.description,
                splits: [
                    {
                        account_guid: accountGuid,
                        value_num: parseFloat(tx.account_split_value) >= 0 ? valueNum : negValueNum,
                        value_denom: valueDenom,
                        quantity_num: parseFloat(tx.account_split_value) >= 0 ? valueNum : negValueNum,
                        quantity_denom: valueDenom,
                        reconcile_state: tx.account_split_reconcile_state || 'n',
                    },
                    {
                        account_guid: data.accountGuid,
                        value_num: parseFloat(tx.account_split_value) >= 0 ? negValueNum : valueNum,
                        value_denom: negValueDenom,
                        quantity_num: parseFloat(tx.account_split_value) >= 0 ? negValueNum : valueNum,
                        quantity_denom: negValueDenom,
                        reconcile_state: 'n',
                    },
                ],
            };

            if (data.original_enter_date) {
                body.original_enter_date = data.original_enter_date;
            }

            const res = await fetch(`/api/transactions/${guid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.status === 409) {
                error('Transaction was modified by another user. Refreshing...');
                await fetchTransactions();
                setEditingGuid(null);
                return;
            }

            if (!res.ok) throw new Error('Failed to update');

            success('Transaction updated');
            setEditingGuid(null);
            await fetchTransactions();
        } catch (err) {
            console.error('Inline save failed:', err);
            error('Failed to update transaction');
        }
    }, [transactions, accountGuid, fetchTransactions, success, error]);

    // Toggle reviewed status
    const toggleReviewed = useCallback(async (transactionGuid: string) => {
        try {
            const res = await fetch(`/api/transactions/${transactionGuid}/review`, {
                method: 'PATCH',
            });
            if (!res.ok) throw new Error('Failed to toggle reviewed status');
            const { reviewed } = await res.json();
            setTransactions(prev => prev.map(tx =>
                tx.guid === transactionGuid ? { ...tx, reviewed } : tx
            ));
        } catch (err) {
            console.error('Failed to toggle reviewed:', err);
            error('Failed to toggle reviewed status');
        }
    }, [error]);

    // Filter transactions based on reviewed filter
    const displayTransactions = useMemo(() => {
        if (!showUnreviewedOnly) return transactions;
        return transactions.filter(tx => tx.reviewed === false);
    }, [transactions, showUnreviewedOnly]);

    // TanStack Table setup
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

    // Keyboard navigation handler
    const handleTableKeyDown = useCallback((e: KeyboardEvent) => {
        if (editingGuid) return; // Let InlineEditRow handle keys during edit
        if (isEditModalOpen || isViewModalOpen || deleteConfirmOpen) return; // Don't navigate when modals are open

        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

        switch (e.key) {
            case 'ArrowDown':
            case 'j':
                e.preventDefault();
                setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                break;
            case 'ArrowUp':
            case 'k':
                e.preventDefault();
                setFocusedRowIndex(i => Math.max(i - 1, 0));
                break;
            case 'Enter':
                if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                    e.preventDefault();
                    const tx = displayTransactions[focusedRowIndex];
                    const isMultiSplit = (tx.splits?.length || 0) > 2;
                    if (isMultiSplit) {
                        handleRowClick(tx.guid);
                    } else {
                        setEditingGuid(tx.guid);
                    }
                }
                break;
            case 'Delete':
            case 'Backspace':
                if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                    e.preventDefault();
                    const tx = displayTransactions[focusedRowIndex];
                    setDeletingGuid(tx.guid);
                    setDeleteConfirmOpen(true);
                }
                break;
            case 'r':
                if (focusedRowIndex >= 0) {
                    e.preventDefault();
                    toggleReviewed(displayTransactions[focusedRowIndex].guid);
                }
                break;
            case 'Escape':
                setFocusedRowIndex(-1);
                break;
        }
    }, [editingGuid, isEditModalOpen, isViewModalOpen, deleteConfirmOpen, focusedRowIndex, transactions, displayTransactions, handleRowClick, toggleReviewed]);

    // Attach keyboard listener
    useEffect(() => {
        window.addEventListener('keydown', handleTableKeyDown);
        return () => window.removeEventListener('keydown', handleTableKeyDown);
    }, [handleTableKeyDown]);

    // Scroll focused row into view
    useEffect(() => {
        if (focusedRowIndex >= 0 && tableRef.current) {
            const rows = tableRef.current.querySelectorAll('tbody tr');
            rows[focusedRowIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [focusedRowIndex]);

    // Reset when initialTransactions change (e.g., date filter changed)
    useEffect(() => {
        setTransactions(initialTransactions);
        setOffset(initialTransactions.length);
        setHasMore(initialTransactions.length >= 100);
    }, [initialTransactions]);

    // Reset and re-fetch when unreviewed filter changes
    useEffect(() => {
        setOffset(0);
        setHasMore(true);
        setFocusedRowIndex(-1);
        fetchTransactions();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showUnreviewedOnly]);

    const toggleExpand = (guid: string) => {
        setExpandedTxs(prev => ({ ...prev, [guid]: !prev[guid] }));
    };

    const fetchMoreTransactions = useCallback(async () => {
        if (loading || !hasMore) return;
        setLoading(true);

        try {
            const params = buildUrlParams({ offset });
            const res = await fetch(`/api/accounts/${accountGuid}/transactions?${params}`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data: AccountTransaction[] = await res.json();

            if (data.length === 0) {
                setHasMore(false);
            } else {
                setTransactions(prev => [...prev, ...data]);
                setOffset(prev => prev + data.length);
                if (data.length < 100) setHasMore(false);
            }
        } catch (error) {
            console.error('Error fetching more transactions:', error);
        } finally {
            setLoading(false);
        }
    }, [accountGuid, offset, loading, hasMore, buildUrlParams]);

    useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
            const target = entries[0];
            if (target.isIntersecting && hasMore && !loading) {
                fetchMoreTransactions();
            }
        }, { threshold: 0.1 });

        if (loader.current) {
            observer.observe(loader.current);
        }

        return () => observer.disconnect();
    }, [fetchMoreTransactions, hasMore, loading]);

    const getReconcileIcon = (state: string) => {
        switch (state) {
            case 'y': return { icon: 'Y', color: 'text-emerald-400 bg-emerald-500/10', label: 'Reconciled' };
            case 'c': return { icon: 'C', color: 'text-amber-400 bg-amber-500/10', label: 'Cleared' };
            default: return { icon: 'N', color: 'text-foreground-muted bg-surface/10', label: 'Not Reconciled' };
        }
    };

    return (
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden shadow-2xl">
            {/* Top Bar: New Transaction + Reconciliation Panel */}
            <div className="p-4 border-b border-border flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => {
                            setEditingTransaction(null);
                            setIsEditModalOpen(true);
                        }}
                        className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors font-medium"
                    >
                        New Transaction
                    </button>
                    <button
                        onClick={() => setShowUnreviewedOnly(prev => !prev)}
                        className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                            showUnreviewedOnly
                                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                                : 'border-border text-foreground-muted hover:text-foreground'
                        }`}
                    >
                        {showUnreviewedOnly ? 'Showing Unreviewed' : 'Show Unreviewed Only'}
                    </button>
                </div>
                <ReconciliationPanel
                    accountGuid={accountGuid}
                    accountCurrency={accountCurrency}
                    currentBalance={currentBalance}
                    selectedBalance={selectedBalance}
                    onReconcileComplete={handleReconcileComplete}
                    selectedSplits={selectedSplits}
                    onToggleSplit={toggleSplitSelection}
                    onSelectAll={selectAllUnreconciled}
                    onClearSelection={clearSelection}
                    isReconciling={isReconciling}
                    onStartReconcile={() => setIsReconciling(true)}
                    onCancelReconcile={() => {
                        setIsReconciling(false);
                        setSelectedSplits(new Set());
                    }}
                />
            </div>

            <div className="overflow-x-auto">
                <table ref={tableRef} className="w-full text-left border-collapse">
                    <thead>
                        {table.getHeaderGroups().map(headerGroup => (
                            <tr key={headerGroup.id} className="bg-background-secondary/50 text-foreground-secondary text-[10px] uppercase tracking-[0.2em] font-bold">
                                {headerGroup.headers.map(header => {
                                    const colId = header.column.id;
                                    if (colId === 'select') return <th key={header.id} className="px-4 py-4 w-10"></th>;
                                    if (colId === 'reconcile') return <th key={header.id} className="px-4 py-4 w-10">R</th>;
                                    if (colId === 'date') return <th key={header.id} className="px-6 py-4">Date</th>;
                                    if (colId === 'description') return <th key={header.id} className="px-6 py-4">Description</th>;
                                    if (colId === 'transfer') return <th key={header.id} className="px-6 py-4">Transfer / Splits</th>;
                                    if (colId === 'amount') return <th key={header.id} className="px-6 py-4 text-right">Amount</th>;
                                    if (colId === 'balance') return <th key={header.id} className="px-6 py-4 text-right">Balance</th>;
                                    return <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>;
                                })}
                            </tr>
                        ))}
                    </thead>
                    <tbody className="divide-y divide-border/50">
                        {table.getRowModel().rows.map((row) => {
                            const tx = row.original;
                            const index = row.index;
                            const isMultiSplit = (tx.splits?.length || 0) > 2;
                            const isExpanded = expandedTxs[tx.guid];
                            const otherSplits = tx.splits?.filter(s => s.account_guid !== accountGuid) || [];
                            const isUnreviewed = tx.reviewed === false;
                            const amount = parseFloat(tx.account_split_value);
                            const reconcileInfo = getReconcileIcon(tx.account_split_reconcile_state);
                            const isSelected = selectedSplits.has(tx.account_split_guid);

                            if (editingGuid === tx.guid) {
                                return (
                                    <InlineEditRow
                                        key={tx.guid}
                                        transaction={tx}
                                        accountGuid={accountGuid}
                                        accountType={accountType}
                                        columnCount={row.getVisibleCells().length}
                                        onSave={handleInlineSave}
                                        onCancel={() => setEditingGuid(null)}
                                    />
                                );
                            }

                            return (
                                <tr
                                    key={row.id}
                                    className={`hover:bg-white/[0.02] transition-colors group cursor-pointer ${isSelected ? 'bg-amber-500/5' : ''} ${index === focusedRowIndex ? 'ring-2 ring-cyan-500/50 ring-inset bg-white/[0.03]' : ''} ${isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}`}
                                    onClick={(e) => {
                                        // Don't trigger on checkbox or button clicks
                                        if ((e.target as HTMLElement).closest('input, button')) return;
                                        handleRowClick(tx.guid);
                                    }}
                                >
                                    {row.getVisibleCells().map(cell => {
                                        const colId = cell.column.id;

                                        if (colId === 'select') {
                                            return (
                                                <td key={cell.id} className="px-4 py-4 align-top">
                                                    {tx.account_split_reconcile_state !== 'y' && (
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={() => toggleSplitSelection(tx.account_split_guid)}
                                                            className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-amber-500 focus:ring-amber-500/50 cursor-pointer"
                                                        />
                                                    )}
                                                </td>
                                            );
                                        }

                                        if (colId === 'reconcile') {
                                            return (
                                                <td key={cell.id} className="px-4 py-4 align-top">
                                                    <span
                                                        className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${reconcileInfo.color}`}
                                                        title={reconcileInfo.label}
                                                    >
                                                        {reconcileInfo.icon}
                                                    </span>
                                                </td>
                                            );
                                        }

                                        if (colId === 'date') {
                                            return (
                                                <td key={cell.id} className="px-6 py-4 whitespace-nowrap text-xs text-foreground-secondary align-top font-mono">
                                                    {new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                                                </td>
                                            );
                                        }

                                        if (colId === 'description') {
                                            return (
                                                <td key={cell.id} className="px-6 py-4 text-sm text-foreground align-top">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium">{tx.description}</span>
                                                        {tx.source && tx.source !== 'manual' && (
                                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider font-bold">
                                                                Imported
                                                            </span>
                                                        )}
                                                    </div>
                                                    {tx.num && <span className="text-[10px] text-foreground-muted font-mono">#{tx.num}</span>}
                                                </td>
                                            );
                                        }

                                        if (colId === 'transfer') {
                                            return (
                                                <td key={cell.id} className="px-6 py-4 text-sm align-top">
                                                    {isMultiSplit && !isExpanded ? (
                                                        <button
                                                            onClick={() => toggleExpand(tx.guid)}
                                                            className="text-foreground-muted hover:text-cyan-400 transition-colors flex items-center gap-1 italic text-xs"
                                                        >
                                                            <span>-- Multiple Splits --</span>
                                                            <span className="text-[10px]">&#9660;</span>
                                                        </button>
                                                    ) : (
                                                        <div className="space-y-1">
                                                            {otherSplits.map((split) => (
                                                                <div key={split.guid} className="flex justify-between items-center text-xs">
                                                                    <span className="text-foreground-secondary truncate max-w-[180px]">
                                                                        {split.account_name}
                                                                    </span>
                                                                    {isExpanded && (
                                                                        <span className={`font-mono ml-2 ${parseFloat(split.quantity_decimal || '0') < 0 ? 'text-rose-400/70' : 'text-emerald-400/70'}`}>
                                                                            {formatCurrency(split.quantity_decimal || '0', split.commodity_mnemonic)}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            ))}
                                                            {isMultiSplit && isExpanded && (
                                                                <button
                                                                    onClick={() => toggleExpand(tx.guid)}
                                                                    className="text-cyan-500/50 hover:text-cyan-400 transition-colors text-[10px] mt-1"
                                                                >
                                                                    &#9650; Show less
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                </td>
                                            );
                                        }

                                        if (colId === 'amount') {
                                            return (
                                                <td key={cell.id} className={`px-6 py-4 text-sm font-mono text-right align-top ${amount < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                                    {formatCurrency(tx.account_split_value, tx.commodity_mnemonic)}
                                                </td>
                                            );
                                        }

                                        if (colId === 'balance') {
                                            return (
                                                <td key={cell.id} className={`px-6 py-4 text-sm font-mono text-right align-top font-bold ${tx.running_balance ? (applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal) < 0 ? 'text-rose-400' : 'text-emerald-400') : 'text-foreground-muted'}`}>
                                                    {tx.running_balance ? formatCurrency(applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal), tx.commodity_mnemonic) : '\u2014'}
                                                </td>
                                            );
                                        }

                                        return <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>;
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                <div ref={loader} className="p-8 flex justify-center border-t border-border/50">
                    {loading ? (
                        <div className="flex items-center gap-3">
                            <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                            <span className="text-xs text-foreground-muted uppercase tracking-widest">Updating Ledger...</span>
                        </div>
                    ) : hasMore ? (
                        <span className="text-xs text-foreground-muted uppercase tracking-widest animate-pulse">Scroll for history</span>
                    ) : (
                        <span className="text-xs text-foreground-muted uppercase tracking-widest font-bold">End of Records</span>
                    )}
                </div>
            </div>

            {/* Modals */}
            <TransactionModal
                transactionGuid={selectedTxGuid}
                isOpen={isViewModalOpen}
                onClose={() => setIsViewModalOpen(false)}
                onEdit={handleEdit}
                onDelete={handleDeleteClick}
            />

            <TransactionFormModal
                isOpen={isEditModalOpen}
                onClose={() => {
                    setIsEditModalOpen(false);
                    setEditingTransaction(null);
                }}
                transaction={editingTransaction}
                defaultAccountGuid={accountGuid}
                onSuccess={() => {
                    setIsEditModalOpen(false);
                    setEditingTransaction(null);
                    fetchTransactions();
                }}
                onRefresh={fetchTransactions}
            />

            <ConfirmationDialog
                isOpen={deleteConfirmOpen}
                onConfirm={handleDeleteConfirm}
                onCancel={() => {
                    setDeleteConfirmOpen(false);
                    setDeletingGuid(null);
                }}
                title="Delete Transaction"
                message="Are you sure you want to delete this transaction? This cannot be undone."
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
