"use client";

import { Transaction, Split } from '@/lib/types';
import { useState, useEffect, useRef, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import { formatDisplayAccountPath } from '@/lib/account-path';
import { FilterPanel, AccountTypeFilter, AmountFilter, ReconcileFilter } from './filters';
import { TransactionModal } from './TransactionModal';
import { TransactionFormModal } from './TransactionFormModal';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { useToast } from '@/contexts/ToastContext';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from './ui/MobileCard';
import { ReceiptIndicator } from '@/components/receipts/ReceiptIndicator';

function getReconcileStatus(splits: Split[] | undefined): {
    hasReconciled: boolean;
    hasCleared: boolean;
} {
    if (!splits || splits.length === 0) return { hasReconciled: false, hasCleared: false };
    return {
        hasReconciled: splits.some(s => s.reconcile_state === 'y'),
        hasCleared: splits.some(s => s.reconcile_state === 'c'),
    };
}

interface TransactionFilters {
    accountTypes: string[];
    minAmount: string;
    maxAmount: string;
    reconcileStates: string[];
}

interface TransactionJournalProps {
    initialTransactions: Transaction[];
    startDate?: string | null;
    endDate?: string | null;
}

export default function TransactionJournal({ initialTransactions, startDate, endDate }: TransactionJournalProps) {
    const { success, error } = useToast();
    const isMobile = useIsMobile();
    const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions);
    const [offset, setOffset] = useState(initialTransactions.length);
    const [hasMore, setHasMore] = useState(initialTransactions.length >= 100);
    const [loading, setLoading] = useState(false);
    const [filterText, setFilterText] = useState('');
    const [debouncedFilter, setDebouncedFilter] = useState('');
    const loader = useRef<HTMLDivElement>(null);
    const filterInputRef = useRef<HTMLInputElement>(null);

    // Modal state
    const [selectedTxGuid, setSelectedTxGuid] = useState<string | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);

    // Edit modal state
    const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);

    // Listen for global 'n' key shortcut to open new transaction
    useEffect(() => {
        const handler = () => {
            setEditingTransaction(null);
            setIsEditModalOpen(true);
        };
        window.addEventListener('open-new-transaction', handler);
        return () => window.removeEventListener('open-new-transaction', handler);
    }, []);

    // '/' to focus filter input, Esc to clear/blur
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            const isInInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

            if (isInInput && e.key === 'Escape' && e.target === filterInputRef.current) {
                e.preventDefault();
                if (filterText) {
                    setFilterText('');
                } else {
                    filterInputRef.current?.blur();
                }
                return;
            }

            if (!isInInput && e.key === '/') {
                e.preventDefault();
                filterInputRef.current?.focus();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [filterText]);

    // Reconcile warning state
    const [reconcileWarningOpen, setReconcileWarningOpen] = useState(false);
    const [pendingAction, setPendingAction] = useState<'edit' | 'delete' | null>(null);
    const [pendingGuid, setPendingGuid] = useState<string | null>(null);

    // Delete confirmation state
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deletingGuid, setDeletingGuid] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // Advanced filters
    const [filters, setFilters] = useState<TransactionFilters>({
        accountTypes: [],
        minAmount: '',
        maxAmount: '',
        reconcileStates: [],
    });
    const [debouncedFilters, setDebouncedFilters] = useState<TransactionFilters>(filters);

    // Track if filters were previously active (to detect clearing)
    const prevFiltersRef = useRef<{ hadTextFilter: boolean; hadAdvancedFilters: boolean }>({
        hadTextFilter: false,
        hadAdvancedFilters: false,
    });

    const handleRowClick = (guid: string) => {
        setSelectedTxGuid(guid);
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setSelectedTxGuid(null);
    };

    // Reset when initialTransactions change (e.g., date filter changed)
    useEffect(() => {
        setTransactions(initialTransactions);
        setOffset(initialTransactions.length);
        setHasMore(initialTransactions.length >= 100);
    }, [initialTransactions]);

    // Debounce filter input
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedFilter(filterText);
        }, 300);
        return () => clearTimeout(timer);
    }, [filterText]);

    // Debounce advanced filters
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedFilters(filters);
        }, 300);
        return () => clearTimeout(timer);
    }, [filters]);

    // Count active filters
    const activeFilterCount = [
        filters.accountTypes.length > 0,
        filters.minAmount !== '',
        filters.maxAmount !== '',
        filters.reconcileStates.length > 0,
    ].filter(Boolean).length;

    // Clear all filters
    const clearAllFilters = () => {
        setFilters({
            accountTypes: [],
            minAmount: '',
            maxAmount: '',
            reconcileStates: [],
        });
    };

    // Build URL params helper
    const buildUrlParams = useCallback((extraParams: Record<string, string | number> = {}) => {
        const params = new URLSearchParams();
        params.set('limit', '100');
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        if (debouncedFilters.accountTypes.length > 0) {
            params.set('accountTypes', debouncedFilters.accountTypes.join(','));
        }
        if (debouncedFilters.minAmount) {
            params.set('minAmount', debouncedFilters.minAmount);
        }
        if (debouncedFilters.maxAmount) {
            params.set('maxAmount', debouncedFilters.maxAmount);
        }
        if (debouncedFilters.reconcileStates.length > 0) {
            params.set('reconcileStates', debouncedFilters.reconcileStates.join(','));
        }
        Object.entries(extraParams).forEach(([key, value]) => {
            params.set(key, String(value));
        });
        return params.toString();
    }, [startDate, endDate, debouncedFilters]);

    // Reset and fetch helper
    const fetchTransactions = useCallback(async () => {
        setLoading(true);
        try {
            const params = buildUrlParams({ offset: 0, search: debouncedFilter });
            const res = await fetch(`/api/transactions?${params}`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data: Transaction[] = await res.json();
            setTransactions(data);
            setOffset(data.length);
            setHasMore(data.length >= 100);
        } catch (error) {
            console.error('Error fetching transactions:', error);
        } finally {
            setLoading(false);
        }
    }, [buildUrlParams, debouncedFilter]);

    const handleEdit = useCallback((guid: string) => {
        // Find the transaction by guid
        const tx = transactions.find(t => t.guid === guid);
        if (tx) {
            const { hasReconciled, hasCleared } = getReconcileStatus(tx.splits);
            if (hasReconciled || hasCleared) {
                setPendingAction('edit');
                setPendingGuid(guid);
                setReconcileWarningOpen(true);
            } else {
                setEditingTransaction(tx);
                setIsEditModalOpen(true);
                setIsModalOpen(false); // Close view modal
            }
        }
    }, [transactions]);

    const handleDelete = useCallback((guid: string) => {
        const tx = transactions.find(t => t.guid === guid);
        if (tx) {
            const { hasReconciled, hasCleared } = getReconcileStatus(tx.splits);
            if (hasReconciled || hasCleared) {
                setPendingAction('delete');
                setPendingGuid(guid);
                setReconcileWarningOpen(true);
            } else {
                // Show basic confirmation for un-reconciled transactions
                setDeletingGuid(guid);
                setDeleteConfirmOpen(true);
            }
        }
    }, [transactions]);

    const performDelete = async (guid: string) => {
        // Optimistically remove from local state
        const prevTransactions = transactions;
        setTransactions(prev => prev.filter(t => t.guid !== guid));
        setDeleteConfirmOpen(false);
        setDeletingGuid(null);
        setIsModalOpen(false);

        try {
            const res = await fetch(`/api/transactions/${guid}`, {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('Failed to delete');
            success('Transaction deleted successfully');
        } catch (err) {
            console.error('Delete failed:', err);
            error('Failed to delete transaction');
            // Rollback on failure
            setTransactions(prevTransactions);
        }
    };

    const handleDeleteConfirm = async () => {
        if (!deletingGuid) return;
        await performDelete(deletingGuid);
    };

    const handleReconcileWarningConfirm = () => {
        setReconcileWarningOpen(false);
        if (!pendingGuid) return;

        if (pendingAction === 'edit') {
            const tx = transactions.find(t => t.guid === pendingGuid);
            if (tx) {
                setEditingTransaction(tx);
                setIsEditModalOpen(true);
                setIsModalOpen(false); // Close view modal
            }
        } else if (pendingAction === 'delete') {
            // Show final confirmation before deleting
            setDeletingGuid(pendingGuid);
            setDeleteConfirmOpen(true);
        }

        setPendingAction(null);
        setPendingGuid(null);
    };

    const handleReconcileWarningCancel = () => {
        setReconcileWarningOpen(false);
        setPendingAction(null);
        setPendingGuid(null);
    };

    // Get reconcile status for warning dialog
    const pendingTx = pendingGuid ? transactions.find(t => t.guid === pendingGuid) : null;
    const { hasReconciled } = getReconcileStatus(pendingTx?.splits);

    // Reset and fetch when filter changes
    useEffect(() => {
        const resetAndFetch = async () => {
            setLoading(true);
            try {
                const params = buildUrlParams({ offset: 0, search: debouncedFilter });
                const res = await fetch(`/api/transactions?${params}`);
                if (!res.ok) throw new Error('Failed to fetch');
                const data: Transaction[] = await res.json();
                setTransactions(data);
                setOffset(data.length);
                setHasMore(data.length >= 100);
            } catch (error) {
                console.error('Error filtering transactions:', error);
            } finally {
                setLoading(false);
            }
        };

        // Check current filter state
        const hasTextFilter = debouncedFilter !== '';
        const hasAdvancedFilters = debouncedFilters.accountTypes.length > 0 ||
            debouncedFilters.minAmount !== '' ||
            debouncedFilters.maxAmount !== '' ||
            debouncedFilters.reconcileStates.length > 0;

        // Check if filters were just cleared (had filters before, none now)
        const filtersWereCleared =
            (prevFiltersRef.current.hadTextFilter || prevFiltersRef.current.hadAdvancedFilters) &&
            !hasTextFilter && !hasAdvancedFilters;

        // Update the ref for next comparison
        prevFiltersRef.current = { hadTextFilter: hasTextFilter, hadAdvancedFilters: hasAdvancedFilters };

        // Run when any filter is active OR when filters were just cleared
        if (hasTextFilter || hasAdvancedFilters || filtersWereCleared) {
            resetAndFetch();
        }
    }, [debouncedFilter, debouncedFilters, buildUrlParams]);

    const fetchMoreTransactions = useCallback(async () => {
        if (loading || !hasMore) return;
        setLoading(true);

        try {
            const params = buildUrlParams({ offset, search: debouncedFilter });
            const res = await fetch(`/api/transactions?${params}`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data: Transaction[] = await res.json();

            if (data.length === 0) {
                setHasMore(false);
            } else {
                setTransactions(prev => [...prev, ...data]);
                setOffset(prev => prev + data.length);
            }
        } catch (error) {
            console.error('Error fetching more transactions:', error);
        } finally {
            setLoading(false);
        }
    }, [offset, loading, hasMore, debouncedFilter, buildUrlParams]);

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

    return (
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-border flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="flex items-center gap-3">
                    <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
                        <span className="w-2 h-6 bg-primary rounded-full" />
                        General Ledger
                    </h2>
                    <span className="text-xs text-foreground-muted uppercase tracking-widest pt-1">
                        {transactions.length} Loaded
                    </span>
                </div>

                <div className="flex flex-wrap gap-2 w-full md:w-auto">
                    <button
                        onClick={() => {
                            setEditingTransaction(null);
                            setIsEditModalOpen(true);
                        }}
                        className="w-full md:w-auto px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors font-medium flex items-center gap-2 whitespace-nowrap"
                    >
                        <span>+</span>
                        New Transaction
                    </button>

                    <FilterPanel
                        activeFilterCount={activeFilterCount}
                        onClearAll={clearAllFilters}
                    >
                        <AccountTypeFilter
                            selectedTypes={filters.accountTypes}
                            onChange={(types) => setFilters(f => ({ ...f, accountTypes: types }))}
                        />
                        <AmountFilter
                            minAmount={filters.minAmount}
                            maxAmount={filters.maxAmount}
                            onMinChange={(val) => setFilters(f => ({ ...f, minAmount: val }))}
                            onMaxChange={(val) => setFilters(f => ({ ...f, maxAmount: val }))}
                        />
                        <ReconcileFilter
                            selectedStates={filters.reconcileStates}
                            onChange={(states) => setFilters(f => ({ ...f, reconcileStates: states }))}
                        />
                    </FilterPanel>

                    <div className="relative w-full md:w-64 md:flex-1">
                        <input
                            ref={filterInputRef}
                            type="text"
                            placeholder="Search... (press / to focus)"
                            className="w-full bg-input-bg border border-border rounded-xl px-4 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 transition-all pl-10"
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                        />
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-lg">
                            🔍
                        </span>
                        {filterText && (
                            <button
                                onClick={() => setFilterText('')}
                                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground-secondary min-h-[44px] min-w-[44px] flex items-center justify-center"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </div>
            </div>
            {isMobile ? (
                <div>
                    {transactions.length === 0 ? (
                        <div className="px-4 py-12 text-center text-foreground-muted">
                            {loading ? 'Loading...' : 'No transactions found matching your filters.'}
                        </div>
                    ) : (
                        transactions.map(tx => {
                            const debits = tx.splits?.filter(s => parseFloat(s.quantity_decimal || '0') >= 0) || [];
                            const credits = tx.splits?.filter(s => parseFloat(s.quantity_decimal || '0') < 0) || [];
                            const debitTotal = debits.reduce((sum, s) => sum + parseFloat(s.quantity_decimal || '0'), 0);
                            const creditTotal = credits.reduce((sum, s) => sum + Math.abs(parseFloat(s.quantity_decimal || '0')), 0);
                            return (
                                <MobileCard
                                    key={tx.guid}
                                    onClick={() => handleRowClick(tx.guid)}
                                    fields={[
                                        { label: 'Date', value: new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' }) },
                                        { label: 'Description', value: <><span className="font-medium">{tx.description}</span>{tx.num && <span className="text-xs text-foreground-muted ml-1">#{tx.num}</span>}</> },
                                        { label: 'Accounts', value: <div className="text-right">{tx.splits?.map(s => <div key={s.guid} className="text-foreground-secondary text-xs">{s.account_name}</div>)}</div> },
                                        ...(debitTotal > 0 ? [{ label: 'Debit', value: <span className="text-emerald-400 font-mono">{formatCurrency(debitTotal)}</span> }] : []),
                                        ...(creditTotal > 0 ? [{ label: 'Credit', value: <span className="text-rose-400 font-mono">{formatCurrency(creditTotal)}</span> }] : []),
                                    ]}
                                />
                            );
                        })
                    )}
                    <div ref={loader} className="p-6 flex justify-center border-t border-border">
                        {loading ? (
                            <div className="flex items-center gap-3">
                                <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                                <span className="text-sm text-foreground-secondary">Loading more...</span>
                            </div>
                        ) : hasMore ? (
                            <span className="text-sm text-foreground-muted italic">Scroll for more</span>
                        ) : (
                            <span className="text-sm text-foreground-muted italic font-medium">All transactions loaded</span>
                        )}
                    </div>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-4 py-2 font-semibold">Date</th>
                                <th className="px-4 py-2 font-semibold">Description</th>
                                <th className="px-2 py-2 w-10 font-semibold"></th>
                                <th className="px-4 py-2 font-semibold">Account</th>
                                <th className="px-4 py-2 font-semibold text-right">Debit</th>
                                <th className="px-4 py-2 font-semibold text-right">Credit</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {transactions.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-4 py-10 text-center text-foreground-muted">
                                        {loading ? 'Loading...' : 'No transactions found matching your filters.'}
                                    </td>
                                </tr>
                            ) : (
                                transactions.map(tx => (
                                    <tr key={tx.guid} className="hover:bg-white/[0.02] transition-colors group cursor-pointer" onClick={() => handleRowClick(tx.guid)}>
                                        <td className="px-4 py-2 whitespace-nowrap text-sm text-foreground-secondary align-middle">
                                            {new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-foreground align-middle max-w-xs leading-tight">
                                            <div className="font-medium">{tx.description}</div>
                                            {tx.num && <span className="text-xs text-foreground-muted">#{tx.num}</span>}
                                        </td>
                                        <td className="px-1 py-1 align-middle" onClick={(e) => e.stopPropagation()}>
                                            <ReceiptIndicator
                                                transactionGuid={tx.guid}
                                                transactionDescription={tx.description}
                                                receiptCount={(tx as any).receipt_count || 0}
                                            />
                                        </td>
                                        <td className="px-4 py-2 text-sm align-top">
                                            <div className="space-y-1">
                                                {tx.splits?.map(split => (
                                                    <div key={split.guid} className="text-foreground-secondary whitespace-normal break-words">
                                                        {formatDisplayAccountPath(split.account_fullname, split.account_name)}
                                                    </div>
                                                ))}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2 text-sm font-mono text-right align-top">
                                            <div className="space-y-1">
                                                {tx.splits?.map(split => {
                                                    const val = parseFloat(split.quantity_decimal || '0');
                                                    return (
                                                        <div key={split.guid} className="text-emerald-400">
                                                            {val >= 0 ? formatCurrency(val, split.commodity_mnemonic) : '\u00A0'}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2 text-sm font-mono text-right align-top">
                                            <div className="space-y-1">
                                                {tx.splits?.map(split => {
                                                    const val = parseFloat(split.quantity_decimal || '0');
                                                    return (
                                                        <div key={split.guid} className="text-rose-400">
                                                            {val < 0 ? formatCurrency(Math.abs(val), split.commodity_mnemonic) : '\u00A0'}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>

                    {/* Loader trigger */}
                    <div ref={loader} className="p-8 flex justify-center border-t border-border">
                        {loading ? (
                            <div className="flex items-center gap-3">
                                <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                                <span className="text-sm text-foreground-secondary">Loading more transactions...</span>
                            </div>
                        ) : hasMore ? (
                            <span className="text-sm text-foreground-muted italic">Scroll for more</span>
                        ) : (
                            <span className="text-sm text-foreground-muted italic font-medium">All transactions loaded</span>
                        )}
                    </div>
                </div>
            )}

            {/* Transaction Details Modal */}
            <TransactionModal
                transactionGuid={selectedTxGuid}
                isOpen={isModalOpen}
                onClose={handleCloseModal}
                onEdit={handleEdit}
                onDelete={handleDelete}
            />

            {/* Transaction Form Modal */}
            <TransactionFormModal
                isOpen={isEditModalOpen}
                onClose={() => {
                    setIsEditModalOpen(false);
                    setEditingTransaction(null);
                }}
                transaction={editingTransaction}
                onSuccess={() => {
                    setIsEditModalOpen(false);
                    setEditingTransaction(null);
                    fetchTransactions();
                }}
                onRefresh={fetchTransactions}
            />

            {/* Reconcile Warning Dialog */}
            <ConfirmationDialog
                isOpen={reconcileWarningOpen}
                onConfirm={handleReconcileWarningConfirm}
                onCancel={handleReconcileWarningCancel}
                title={hasReconciled ? (pendingAction === 'delete' ? "Delete Reconciled Transaction?" : "Edit Reconciled Transaction?") : (pendingAction === 'delete' ? "Delete Cleared Transaction?" : "Edit Cleared Transaction?")}
                message={hasReconciled
                    ? `This transaction has reconciled splits. ${pendingAction === 'delete' ? 'Deleting' : 'Editing'} may affect your account reconciliation. Are you sure you want to continue?`
                    : `This transaction has cleared splits. Are you sure you want to ${pendingAction === 'delete' ? 'delete' : 'edit'} it?`
                }
                confirmLabel="Continue Anyway"
                confirmVariant={hasReconciled ? "danger" : "warning"}
            />

            {/* Delete Confirmation Dialog */}
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
