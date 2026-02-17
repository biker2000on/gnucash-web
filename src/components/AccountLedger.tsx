"use client";

import { Transaction, Split } from '@/lib/types';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { ReconciliationPanel } from './ReconciliationPanel';
import { TransactionModal } from './TransactionModal';
import { TransactionFormModal } from './TransactionFormModal';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { useToast } from '@/contexts/ToastContext';

export interface AccountTransaction extends Transaction {
    running_balance: string;
    account_split_value: string;
    commodity_mnemonic: string;
    account_split_guid: string;
    account_split_reconcile_state: string;
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
        Object.entries(extraParams).forEach(([key, value]) => {
            params.set(key, String(value));
        });
        return params.toString();
    }, [startDate, endDate]);

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

    // Reset when initialTransactions change (e.g., date filter changed)
    useEffect(() => {
        setTransactions(initialTransactions);
        setOffset(initialTransactions.length);
        setHasMore(initialTransactions.length >= 100);
    }, [initialTransactions]);

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
                <button
                    onClick={() => {
                        setEditingTransaction(null);
                        setIsEditModalOpen(true);
                    }}
                    className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors font-medium"
                >
                    New Transaction
                </button>
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
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-background-secondary/50 text-foreground-secondary text-[10px] uppercase tracking-[0.2em] font-bold">
                            {isReconciling && <th className="px-4 py-4 w-10"></th>}
                            <th className="px-4 py-4 w-10">R</th>
                            <th className="px-6 py-4">Date</th>
                            <th className="px-6 py-4">Description</th>
                            <th className="px-6 py-4">Transfer / Splits</th>
                            <th className="px-6 py-4 text-right">Amount</th>
                            <th className="px-6 py-4 text-right">Balance</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                        {transactions.map(tx => {
                            const isMultiSplit = (tx.splits?.length || 0) > 2;
                            const isExpanded = expandedTxs[tx.guid];
                            const otherSplits = tx.splits?.filter(s => s.account_guid !== accountGuid) || [];
                            const amount = parseFloat(tx.account_split_value);
                            const reconcileInfo = getReconcileIcon(tx.account_split_reconcile_state);
                            const isSelected = selectedSplits.has(tx.account_split_guid);

                            return (
                                <tr
                                    key={tx.guid}
                                    className={`hover:bg-white/[0.02] transition-colors group cursor-pointer ${isSelected ? 'bg-amber-500/5' : ''}`}
                                    onClick={(e) => {
                                        // Don't trigger on checkbox or button clicks
                                        if ((e.target as HTMLElement).closest('input, button')) return;
                                        handleRowClick(tx.guid);
                                    }}
                                >
                                    {isReconciling && (
                                        <td className="px-4 py-4 align-top">
                                            {tx.account_split_reconcile_state !== 'y' && (
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => toggleSplitSelection(tx.account_split_guid)}
                                                    className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-amber-500 focus:ring-amber-500/50 cursor-pointer"
                                                />
                                            )}
                                        </td>
                                    )}
                                    <td className="px-4 py-4 align-top">
                                        <span
                                            className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${reconcileInfo.color}`}
                                            title={reconcileInfo.label}
                                        >
                                            {reconcileInfo.icon}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-xs text-foreground-secondary align-top font-mono">
                                        {new Date(tx.post_date).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4 text-sm text-foreground align-top">
                                        <div className="font-medium">{tx.description}</div>
                                        {tx.num && <span className="text-[10px] text-foreground-muted font-mono">#{tx.num}</span>}
                                    </td>
                                    <td className="px-6 py-4 text-sm align-top">
                                        {isMultiSplit && !isExpanded ? (
                                            <button
                                                onClick={() => toggleExpand(tx.guid)}
                                                className="text-foreground-muted hover:text-cyan-400 transition-colors flex items-center gap-1 italic text-xs"
                                            >
                                                <span>-- Multiple Splits --</span>
                                                <span className="text-[10px]">▼</span>
                                            </button>
                                        ) : (
                                            <div className="space-y-1">
                                                {otherSplits.map((split, idx) => (
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
                                                        ▲ Show less
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    <td className={`px-6 py-4 text-sm font-mono text-right align-top ${amount < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                        {formatCurrency(tx.account_split_value, tx.commodity_mnemonic)}
                                    </td>
                                    <td className={`px-6 py-4 text-sm font-mono text-right align-top font-bold ${applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                        {formatCurrency(applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal), tx.commodity_mnemonic)}
                                    </td>
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
