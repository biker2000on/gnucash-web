"use client";

import { Transaction } from '@/lib/types';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { formatDisplayAccountPath } from '@/lib/account-path';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { ReconciliationPanel } from './ReconciliationPanel';
import { TransactionModal } from './TransactionModal';
import { TransactionFormModal } from './TransactionFormModal';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { InlineEditRow } from './InlineEditRow';
import { EditableRow, EditableRowHandle } from './ledger/EditableRow';
import { InvestmentEditRow, InvestmentEditRowHandle, InvestmentSaveData } from './ledger/InvestmentEditRow';
import { useToast } from '@/contexts/ToastContext';
import { toNumDenom } from '@/lib/validation';
import {
    useReactTable,
    getCoreRowModel,
    flexRender,
} from '@tanstack/react-table';
import { getColumns, getInvestmentColumns } from './ledger/columns';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from './ui/MobileCard';
import { parseTransactionsResponse, transformToInvestmentRow, isMultiSplitTransaction, InvestmentRowData } from './ledger/investment-utils';
import { toLocalDateString } from '@/lib/datePresets';

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
    commodityNamespace?: string;
}

export default function AccountLedger({
    accountGuid,
    initialTransactions,
    startDate,
    endDate,
    accountCurrency = 'USD',
    currentBalance = 0,
    accountType = 'ASSET',
    commodityNamespace,
}: AccountLedgerProps) {
    const { balanceReversal, defaultLedgerMode } = useUserPreferences();
    const { success, error } = useToast();
    const isMobile = useIsMobile();
    const isInvestmentAccount = commodityNamespace !== undefined && commodityNamespace !== 'CURRENCY';
    const [transactions, setTransactions] = useState<AccountTransaction[]>(initialTransactions);
    const [offset, setOffset] = useState(initialTransactions.length);
    const [hasMore, setHasMore] = useState(initialTransactions.length >= 100);
    const [loading, setLoading] = useState(false);
    const [expandedTxs, setExpandedTxs] = useState<Record<string, boolean>>({});
    const loader = useRef<HTMLDivElement>(null);

    // Reconciliation state
    const [isReconciling, setIsReconciling] = useState(false);
    const [selectedSplits, setSelectedSplits] = useState<Set<string>>(new Set());
    const [simpleFinBalance, setSimpleFinBalance] = useState<{ balance: number; balanceDate: string } | null>(null);

    // Modal state
    const [selectedTxGuid, setSelectedTxGuid] = useState<string | null>(null);
    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deletingGuid, setDeletingGuid] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

    // Keyboard navigation state
    const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
    const [focusedColumnIndex, setFocusedColumnIndex] = useState<number>(0);
    const [editingGuid, setEditingGuid] = useState<string | null>(null);
    const tableRef = useRef<HTMLTableElement>(null);

    // Reviewed filter state
    const [showUnreviewedOnly, setShowUnreviewedOnly] = useState(false);

    // Edit mode state (initialized from defaultLedgerMode preference)
    const [isEditMode, setIsEditMode] = useState(false);
    const [editModeInitialized, setEditModeInitialized] = useState(false);
    const [editReviewedCount, setEditReviewedCount] = useState(0);
    const [editSelectedGuids, setEditSelectedGuids] = useState<Set<string>>(new Set());
    const [lastCheckedIndex, setLastCheckedIndex] = useState<number | null>(null);
    const editableRowRefs = useRef<Map<string, EditableRowHandle | InvestmentEditRowHandle>>(new Map());

    // Initialize edit mode from preference on mount (once preferences are loaded)
    useEffect(() => {
        if (!editModeInitialized && defaultLedgerMode) {
            setIsEditMode(defaultLedgerMode === 'edit');
            setEditModeInitialized(true);
        }
    }, [defaultLedgerMode, editModeInitialized]);

    // Fetch SimpleFin balance for this account on mount
    useEffect(() => {
        fetch(`/api/simplefin/balance/${accountGuid}`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data?.hasBalance) {
                    setSimpleFinBalance({ balance: data.balance, balanceDate: data.balanceDate });
                }
            })
            .catch(() => {}); // silently ignore - not all accounts have SimpleFin mapping
    }, [accountGuid]);

    // Listen for global 'n' key shortcut to open new transaction (skip in edit mode)
    const isEditModeRef = useRef(isEditMode);
    isEditModeRef.current = isEditMode;
    useEffect(() => {
        const handler = () => {
            if (isEditModeRef.current) return; // edit mode handles 'n' separately
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
            const data = parseTransactionsResponse(await res.json());
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

        // Optimistically remove from local state and advance focus
        const deletedGuid = deletingGuid;
        const prevTransactions = transactions;
        const deleteIndex = transactions.findIndex(tx => tx.guid === deletedGuid);

        setTransactions(prev => prev.filter(t => t.guid !== deletedGuid));
        setDeleteConfirmOpen(false);
        setDeletingGuid(null);

        // Move focus to next row (or previous if deleting last)
        if (deleteIndex >= 0) {
            const remainingCount = transactions.length - 1;
            if (remainingCount > 0) {
                setFocusedRowIndex(Math.min(deleteIndex, remainingCount - 1));
            } else {
                setFocusedRowIndex(-1);
            }
        }

        // Fire API call in background
        try {
            const res = await fetch(`/api/transactions/${deletedGuid}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete');
            success('Transaction deleted successfully');
        } catch (err) {
            console.error('Delete failed:', err);
            error('Failed to delete transaction');
            // Rollback on failure
            setTransactions(prevTransactions);
        }
    }, [deletingGuid, transactions, success, error]);

    // Inline edit save handler
    const handleInlineSave = useCallback(async (guid: string, data: {
        post_date: string;
        description: string;
        accountGuid: string;
        accountName: string;
        amount: string;
        original_enter_date?: string;
    }) => {
        try {
            // Build a PUT request to update the transaction
            // We need to find the current transaction to get the currency_guid
            const tx = transactions.find(t => t.guid === guid);
            if (!tx) return;

            const signedAmount = parseFloat(data.amount);
            const absAmount = Math.abs(signedAmount);
            const isDebit = signedAmount >= 0;
            const { num: valueNum, denom: valueDenom } = toNumDenom(absAmount);
            const { num: negValueNum, denom: negValueDenom } = toNumDenom(-absAmount);

            const body: Record<string, unknown> = {
                currency_guid: tx.currency_guid,
                post_date: data.post_date,
                description: data.description,
                splits: [
                    {
                        account_guid: accountGuid,
                        value_num: isDebit ? valueNum : negValueNum,
                        value_denom: valueDenom,
                        quantity_num: isDebit ? valueNum : negValueNum,
                        quantity_denom: valueDenom,
                        reconcile_state: tx.account_split_reconcile_state || 'n',
                    },
                    {
                        account_guid: data.accountGuid,
                        value_num: isDebit ? negValueNum : valueNum,
                        value_denom: negValueDenom,
                        quantity_num: isDebit ? negValueNum : valueNum,
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
            if (isEditMode) {
                // Update local state without refetching to preserve row order
                setTransactions(prev => prev.map(t => {
                    if (t.guid !== guid) return t;
                    const updatedSplits = t.splits?.map(s => {
                        if (s.account_guid === accountGuid) return s;
                        return { ...s, account_guid: data.accountGuid, account_name: data.accountName };
                    });
                    return {
                        ...t,
                        post_date: new Date(data.post_date + 'T12:00:00Z') as unknown as Date,
                        description: data.description,
                        account_split_value: data.amount,
                        splits: updatedSplits,
                    };
                }));
            } else {
                setEditingGuid(null);
                await fetchTransactions();
            }
        } catch (err) {
            console.error('Inline save failed:', err);
            error('Failed to update transaction');
        }
    }, [transactions, accountGuid, fetchTransactions, success, error, isEditMode]);

    // Investment inline edit save handler
    const handleInvestmentInlineSave = useCallback(async (guid: string, data: InvestmentSaveData) => {
        try {
            const tx = transactions.find(t => t.guid === guid);
            if (!tx) return;

            const shares = parseFloat(data.shares);
            const total = parseFloat(data.total);

            // GnuCash sign convention for stock account split:
            // Buy: positive quantity (shares in), negative value (money out)
            // Sell: negative quantity (shares out), positive value (money in)
            const stockQuantity = data.isBuy ? shares : -shares;
            const stockValue = data.isBuy ? -total : total;

            // Transfer split is the opposite of stock value
            const transferValue = -stockValue;

            const { num: stockValueNum, denom: stockValueDenom } = toNumDenom(stockValue);
            const { num: stockQtyNum, denom: stockQtyDenom } = toNumDenom(stockQuantity, 4);
            const { num: transferValueNum, denom: transferValueDenom } = toNumDenom(transferValue);

            const body: Record<string, unknown> = {
                currency_guid: tx.currency_guid,
                post_date: data.post_date,
                description: data.description,
                splits: [
                    {
                        account_guid: accountGuid,
                        value_num: stockValueNum,
                        value_denom: stockValueDenom,
                        quantity_num: stockQtyNum,
                        quantity_denom: stockQtyDenom,
                        reconcile_state: tx.account_split_reconcile_state || 'n',
                    },
                    {
                        account_guid: data.transferAccountGuid,
                        value_num: transferValueNum,
                        value_denom: transferValueDenom,
                        quantity_num: transferValueNum,
                        quantity_denom: transferValueDenom,
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
                return;
            }

            if (!res.ok) throw new Error('Failed to update');

            success('Transaction updated');
            await fetchTransactions();
        } catch (err) {
            console.error('Investment inline save failed:', err);
            error('Failed to update transaction');
            throw err; // Re-throw so InvestmentEditRow knows save failed
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

    // Duplicate a transaction
    const handleDuplicate = useCallback(async (transactionGuid: string) => {
        const tx = transactions.find(t => t.guid === transactionGuid);
        if (!tx) return;

        // Build splits from the original, excluding trading splits
        const nonTradingSplits = (tx.splits ?? []).filter(
            s => !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')
        );

        const today = toLocalDateString(new Date());
        const txGuid = crypto.randomUUID().replace(/-/g, '');

        // Generate split GUIDs upfront so client and server match
        const splitGuids = nonTradingSplits.map(() => crypto.randomUUID().replace(/-/g, ''));

        const splits = nonTradingSplits.map((s, i) => ({
            guid: splitGuids[i],
            account_guid: s.account_guid,
            value_num: Number(s.value_num),
            value_denom: Number(s.value_denom),
            quantity_num: Number(s.quantity_num),
            quantity_denom: Number(s.quantity_denom),
            memo: s.memo || '',
            action: s.action || '',
            reconcile_state: 'n' as const,
        }));

        // Find which split index corresponds to this account for account_split_guid
        const accountSplitIndex = nonTradingSplits.findIndex(s => s.account_guid === accountGuid);

        // Optimistically insert duplicate at top of list
        const optimisticTx: AccountTransaction = {
            ...tx,
            guid: txGuid,
            post_date: new Date(today + 'T00:00:00') as unknown as Date,
            enter_date: new Date() as unknown as Date,
            running_balance: '0',
            account_split_reconcile_state: 'n',
            account_split_guid: accountSplitIndex >= 0 ? splitGuids[accountSplitIndex] : splitGuids[0],
            reviewed: undefined,
            source: undefined,
            splits: nonTradingSplits.map((s, i) => ({
                ...s,
                guid: splitGuids[i],
                reconcile_state: 'n',
            })),
        };
        const prevTransactions = transactions;
        setTransactions(prev => [optimisticTx, ...prev]);
        setFocusedRowIndex(0);
        setFocusedColumnIndex(0);

        try {
            const res = await fetch('/api/transactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    guid: txGuid,
                    currency_guid: tx.currency_guid,
                    post_date: today,
                    description: tx.description,
                    splits,
                }),
            });

            if (!res.ok) throw new Error('Failed to duplicate transaction');

            success('Transaction duplicated');
            // In edit mode, skip refetch since optimistic GUIDs match server GUIDs
            if (!isEditMode) {
                fetchTransactions();
            }
        } catch (err) {
            console.error('Duplicate failed:', err);
            error('Failed to duplicate transaction');
            // Rollback on failure
            setTransactions(prevTransactions);
        }
    }, [transactions, fetchTransactions, success, error, isEditMode]);

    // Filter transactions based on reviewed filter
    const displayTransactions = useMemo(() => {
        if (!showUnreviewedOnly) return transactions;
        return transactions.filter(tx => tx.reviewed === false);
    }, [transactions, showUnreviewedOnly]);

    // Build investment row data map for investment accounts
    const investmentRowMap = useMemo(() => {
        if (!isInvestmentAccount) return null;
        const map = new Map<string, InvestmentRowData>();
        displayTransactions.forEach(tx => {
            const row = transformToInvestmentRow(
                tx as AccountTransaction & { share_balance?: string; cost_basis?: string },
                accountGuid
            );
            map.set(row.guid, row);
        });
        return map;
    }, [isInvestmentAccount, displayTransactions, accountGuid]);

    // Edit mode toggle with mutual exclusivity
    const handleToggleEditMode = useCallback(() => {
        setIsEditMode(prev => {
            const next = !prev;
            if (next) {
                // Entering edit mode: exit reconciliation
                setIsReconciling(false);
                setSelectedSplits(new Set());
                setEditReviewedCount(0);
            } else {
                // Exiting edit mode: clear edit state and refresh data
                setEditSelectedGuids(new Set());
                setFocusedRowIndex(-1);
                fetchTransactions();
            }
            return next;
        });
    }, [fetchTransactions]);

    // Listen for global edit mode shortcuts
    useEffect(() => {
        const enterHandler = () => {
            if (!isEditMode) {
                handleToggleEditMode();
            }
        };
        const exitHandler = () => {
            if (isEditMode) {
                handleToggleEditMode();
            }
        };
        window.addEventListener('enter-edit-mode', enterHandler);
        window.addEventListener('exit-edit-mode', exitHandler);
        return () => {
            window.removeEventListener('enter-edit-mode', enterHandler);
            window.removeEventListener('exit-edit-mode', exitHandler);
        };
    }, [isEditMode, handleToggleEditMode]);

    // Edit mode checkbox handling with shift+click range selection
    const handleEditCheckToggle = useCallback((index: number, guid: string, shiftKey: boolean) => {
        setEditSelectedGuids(prev => {
            const next = new Set(prev);
            if (shiftKey && lastCheckedIndex !== null) {
                const start = Math.min(lastCheckedIndex, index);
                const end = Math.max(lastCheckedIndex, index);
                for (let i = start; i <= end; i++) {
                    next.add(displayTransactions[i].guid);
                }
            } else {
                if (next.has(guid)) {
                    next.delete(guid);
                } else {
                    next.add(guid);
                }
            }
            return next;
        });
        setLastCheckedIndex(index);
    }, [lastCheckedIndex, displayTransactions]);

    // Select all edit mode checkboxes
    const handleSelectAllEdit = useCallback(() => {
        const allGuids = new Set(displayTransactions.map(tx => tx.guid));
        setEditSelectedGuids(allGuids);
    }, [displayTransactions]);

    // Bulk review handler
    const handleBulkReview = useCallback(async () => {
        const guids = Array.from(editSelectedGuids);
        for (const guid of guids) {
            await fetch(`/api/transactions/${guid}/review`, { method: 'PATCH' });
        }
        setEditReviewedCount(prev => prev + guids.length);
        setEditSelectedGuids(new Set());
        await fetchTransactions();
    }, [editSelectedGuids, fetchTransactions]);

    // Bulk delete handler
    const handleBulkDelete = useCallback(async () => {
        const guids = Array.from(editSelectedGuids);
        for (const guid of guids) {
            await fetch(`/api/transactions/${guid}`, { method: 'DELETE' });
        }
        setEditSelectedGuids(new Set());
        setBulkDeleteConfirmOpen(false);
        await fetchTransactions();
        success(`Deleted ${guids.length} transaction${guids.length !== 1 ? 's' : ''}`);
    }, [editSelectedGuids, fetchTransactions, success]);

    // Open TransactionFormModal directly for edit mode edit button
    const handleEditDirect = useCallback((guid: string) => {
        const tx = transactions.find(t => t.guid === guid);
        setEditingTransaction(tx || null);
        setIsEditModalOpen(true);
    }, [transactions]);

    // TanStack Table setup
    const columns = useMemo(() => {
        const colFn = isInvestmentAccount ? getInvestmentColumns : getColumns;
        return colFn({
            accountGuid,
            isReconciling,
            isEditMode,
        });
    }, [accountGuid, isReconciling, isEditMode, isInvestmentAccount]);

    const table = useReactTable({
        data: displayTransactions,
        columns,
        getCoreRowModel: getCoreRowModel(),
    });

    // Keyboard navigation handler
    const handleTableKeyDown = useCallback(async (e: KeyboardEvent) => {
        if (editingGuid) return; // Let InlineEditRow handle keys during edit
        if (isEditModalOpen || isViewModalOpen || deleteConfirmOpen) return; // Don't navigate when modals are open

        const target = e.target as HTMLElement;
        const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

        if (isInInput) {
            // In edit mode, still handle Ctrl+R and Escape even in input fields
            if (isEditMode) {
                if (e.key === 'r' && e.ctrlKey) {
                    e.preventDefault();
                    if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                        const tx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(tx.guid);
                        if (handle?.isDirty()) await handle.save();
                        await toggleReviewed(tx.guid);
                        setEditReviewedCount(prev => prev + 1);
                        if (focusedRowIndex < displayTransactions.length - 1) {
                            setFocusedRowIndex(prev => prev + 1);
                        }
                    }
                    return;
                }
                if (e.key === 'd' && e.ctrlKey) {
                    e.preventDefault();
                    if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                        const tx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(tx.guid);
                        if (handle?.isDirty()) await handle.save();
                        await handleDuplicate(tx.guid);
                    }
                    return;
                }
                if (e.key === 'x' && e.ctrlKey) {
                    e.preventDefault();
                    if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                        const tx = displayTransactions[focusedRowIndex];
                        handleDeleteClick(tx.guid);
                    }
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    (e.target as HTMLElement).blur();
                    return;
                }
            }
            return; // Let input fields handle other keys normally
        }

        if (isEditMode) {
            switch (e.key) {
                case 'ArrowDown':
                case 'j': {
                    e.preventDefault();
                    if (focusedRowIndex >= 0) {
                        const currentTx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(currentTx.guid);
                        if (handle?.isDirty()) await handle.save();
                    }
                    setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                    break;
                }
                case 'ArrowUp':
                case 'k': {
                    e.preventDefault();
                    if (focusedRowIndex >= 0) {
                        const currentTx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(currentTx.guid);
                        if (handle?.isDirty()) await handle.save();
                    }
                    setFocusedRowIndex(i => Math.max(i - 1, 0));
                    break;
                }
                case 'Enter': {
                    e.preventDefault();
                    if (focusedRowIndex >= 0) {
                        const currentTx = displayTransactions[focusedRowIndex];
                        const isMultiSplit = isMultiSplitTransaction(currentTx.splits);
                        if (isMultiSplit) {
                            handleEditDirect(currentTx.guid);
                        } else {
                            const handle = editableRowRefs.current.get(currentTx.guid);
                            if (handle?.isDirty()) await handle.save();
                            setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                        }
                    }
                    break;
                }
                case 'r': {
                    if (e.ctrlKey && focusedRowIndex >= 0) {
                        e.preventDefault();
                        const tx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(tx.guid);
                        if (handle?.isDirty()) await handle.save();
                        await toggleReviewed(tx.guid);
                        setEditReviewedCount(prev => prev + 1);
                        if (focusedRowIndex < displayTransactions.length - 1) {
                            setFocusedRowIndex(prev => prev + 1);
                        }
                    }
                    break;
                }
                case 'd': {
                    if (focusedRowIndex >= 0) {
                        e.preventDefault();
                        const tx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(tx.guid);
                        if (handle?.isDirty()) await handle.save();
                        await handleDuplicate(tx.guid);
                    }
                    break;
                }
                case 'x': {
                    if (focusedRowIndex >= 0) {
                        e.preventDefault();
                        const tx = displayTransactions[focusedRowIndex];
                        handleDeleteClick(tx.guid);
                    }
                    break;
                }
                case 'n': {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    // Save any dirty row first
                    if (focusedRowIndex >= 0) {
                        const currentTx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(currentTx.guid);
                        if (handle?.isDirty()) await handle.save();
                    }
                    // Create a blank transaction at the top
                    const today = toLocalDateString(new Date());
                    const txGuid = crypto.randomUUID().replace(/-/g, '');
                    const splitGuid1 = crypto.randomUUID().replace(/-/g, '');
                    const splitGuid2 = crypto.randomUUID().replace(/-/g, '');

                    const blankTx: AccountTransaction = {
                        guid: txGuid,
                        currency_guid: '',
                        num: '',
                        post_date: new Date(today + 'T00:00:00') as unknown as Date,
                        enter_date: new Date() as unknown as Date,
                        description: '',
                        splits: [{
                            guid: splitGuid1,
                            tx_guid: txGuid,
                            account_guid: accountGuid,
                            account_name: '',
                            value_num: BigInt(0),
                            value_denom: BigInt(100),
                            quantity_num: BigInt(0),
                            quantity_denom: BigInt(100),
                            memo: '',
                            action: '',
                            reconcile_state: 'n',
                            reconcile_date: null,
                            lot_guid: null,
                        }, {
                            guid: splitGuid2,
                            tx_guid: txGuid,
                            account_guid: '',
                            account_name: '',
                            value_num: BigInt(0),
                            value_denom: BigInt(100),
                            quantity_num: BigInt(0),
                            quantity_denom: BigInt(100),
                            memo: '',
                            action: '',
                            reconcile_state: 'n',
                            reconcile_date: null,
                            lot_guid: null,
                        }],
                        running_balance: '0',
                        account_split_value: '0',
                        commodity_mnemonic: '',
                        account_split_guid: splitGuid1,
                        account_split_reconcile_state: 'n',
                    };
                    setTransactions(prev => [blankTx, ...prev]);
                    setFocusedRowIndex(0);
                    setFocusedColumnIndex(0);
                    break;
                }
                case 'Escape':
                    setFocusedRowIndex(-1);
                    break;
            }
            return;
        }

        // Normal mode keyboard handling
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
                    const isMultiSplit = isMultiSplitTransaction(tx.splits);
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
    }, [editingGuid, isEditModalOpen, isViewModalOpen, deleteConfirmOpen, focusedRowIndex, displayTransactions, isEditMode, handleRowClick, handleEditDirect, toggleReviewed]);

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

    // Auto-focus first row when entering edit mode
    useEffect(() => {
        if (isEditMode && displayTransactions.length > 0 && focusedRowIndex < 0) {
            setFocusedRowIndex(0);
        }
    }, [isEditMode, displayTransactions.length, focusedRowIndex]);

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
            const data = parseTransactionsResponse(await res.json());

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
        <>
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-clip shadow-2xl">
            {/* Top Bar: New Transaction + Reconciliation Panel */}
            <div className="p-4 border-b border-border flex flex-col md:flex-row md:justify-between md:items-center gap-3">
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => {
                            setEditingTransaction(null);
                            setIsEditModalOpen(true);
                        }}
                        className="w-full md:w-auto px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors font-medium flex items-center gap-2"
                    >
                        New Transaction
                    </button>
                    <button
                        onClick={() => setShowUnreviewedOnly(prev => !prev)}
                        className={`px-3 py-2 min-h-[44px] text-xs rounded-lg border transition-colors flex items-center ${
                            showUnreviewedOnly
                                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                                : 'border-border text-foreground-muted hover:text-foreground'
                        }`}
                    >
                        {showUnreviewedOnly ? 'Showing Unreviewed' : 'Show Unreviewed Only'}
                    </button>
                    <button
                        onClick={handleToggleEditMode}
                        className={`hidden md:inline-flex px-3 py-2 min-h-[44px] items-center text-xs rounded-lg border transition-colors ${
                            isEditMode
                                ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                                : 'border-border text-foreground-muted hover:text-foreground'
                        }`}
                    >
                        {isEditMode ? 'Exit Edit Mode' : 'Edit Mode'}
                    </button>
                    {isEditMode && (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleSelectAllEdit}
                                className="text-xs text-foreground-secondary hover:text-foreground transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
                            >
                                Select All
                            </button>
                            <span className="text-foreground-muted">|</span>
                            <button
                                onClick={() => setEditSelectedGuids(new Set())}
                                className="text-xs text-foreground-secondary hover:text-foreground transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
                            >
                                Clear
                            </button>
                            <button
                                onClick={handleBulkReview}
                                disabled={editSelectedGuids.size === 0}
                                className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center"
                            >
                                Mark Reviewed ({editSelectedGuids.size})
                            </button>
                            {editSelectedGuids.size > 0 && (
                                <button
                                    onClick={() => setBulkDeleteConfirmOpen(true)}
                                    className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-rose-400 hover:border-rose-500/30 hover:bg-rose-500/10 transition-colors flex items-center"
                                >
                                    Delete Selected ({editSelectedGuids.size})
                                </button>
                            )}
                        </div>
                    )}
                </div>
                {/* Reconcile button in toolbar; panel floats separately */}
                {!isReconciling && (
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
                        onStartReconcile={() => { setIsEditMode(false); setIsReconciling(true); }}
                        onCancelReconcile={() => {
                            setIsReconciling(false);
                            setSelectedSplits(new Set());
                        }}
                        simpleFinBalance={simpleFinBalance}
                    />
                )}
            </div>


            {isMobile && isEditMode ? (
                <div className="p-8 text-center">
                    <p className="text-foreground-muted mb-4">Edit mode is not available on mobile. Use the + button to add transactions.</p>
                    <button onClick={handleToggleEditMode} className="px-4 py-2 text-sm border border-border text-foreground-secondary hover:text-foreground rounded-lg transition-colors">
                        Exit Edit Mode
                    </button>
                </div>
            ) : isMobile && !isEditMode ? (
                <div>
                    {displayTransactions.map((tx) => {
                        const amount = parseFloat(tx.account_split_value);
                        const otherSplits = tx.splits?.filter(s =>
                            s.account_guid !== accountGuid
                            && !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')
                        ) || [];
                        const transferName = otherSplits.length === 1
                            ? otherSplits[0].account_name
                            : otherSplits.length > 1
                                ? `-- ${otherSplits.length} Splits --`
                                : '';
                        const reconcileInfo = getReconcileIcon(tx.account_split_reconcile_state);
                        const balanceValue = tx.running_balance
                            ? applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal)
                            : null;
                        const invRow = investmentRowMap?.get(tx.guid);

                        return isInvestmentAccount && invRow ? (
                            <div key={tx.guid} className="bg-surface/30 backdrop-blur border border-border rounded-xl p-3 space-y-2" onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}>
                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="text-xs text-foreground-muted">
                                            {new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                                        </div>
                                        <div className="text-sm font-medium">{tx.description}</div>
                                        <div className="text-xs text-foreground-muted">{invRow.transferAccount}</div>
                                    </div>
                                    <div className="text-right">
                                        {invRow.shares !== null && (
                                            <div className={`text-sm font-mono ${invRow.shares > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {invRow.shares > 0 ? '+' : ''}{invRow.shares.toFixed(4)} shares
                                            </div>
                                        )}
                                        {invRow.price !== null && (
                                            <div className="text-xs text-foreground-muted">
                                                @ {formatCurrency(invRow.price, invRow.currencyMnemonic)}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex justify-between text-xs border-t border-border/30 pt-1.5">
                                    {invRow.buyAmount !== null && (
                                        <span className="text-emerald-400">Buy: {formatCurrency(invRow.buyAmount, invRow.currencyMnemonic)}</span>
                                    )}
                                    {invRow.sellAmount !== null && (
                                        <span className="text-rose-400">Sell: {formatCurrency(invRow.sellAmount, invRow.currencyMnemonic)}</span>
                                    )}
                                    {invRow.transactionType === 'dividend' && (
                                        <span className="text-foreground-muted">Dividend</span>
                                    )}
                                    <span>Bal: {invRow.shareBalance.toFixed(4)}</span>
                                    <span>Cost: {formatCurrency(invRow.costBasis, invRow.currencyMnemonic)}</span>
                                </div>
                            </div>
                        ) : (
                            <MobileCard
                                key={tx.guid}
                                onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}
                                fields={[
                                    { label: 'Date', value: new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' }) },
                                    { label: 'Description', value: <span className="font-medium">{tx.description}</span> },
                                    { label: 'Transfer', value: transferName },
                                    ...(amount >= 0
                                        ? [{ label: 'Debit', value: <span className="text-emerald-400 font-mono">{formatCurrency(amount, tx.commodity_mnemonic)}</span> }]
                                        : [{ label: 'Credit', value: <span className="text-rose-400 font-mono">{formatCurrency(Math.abs(amount), tx.commodity_mnemonic)}</span> }]
                                    ),
                                    { label: 'Balance', value: balanceValue !== null
                                        ? <span className={`font-mono font-bold ${balanceValue < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{formatCurrency(balanceValue, tx.commodity_mnemonic)}</span>
                                        : <span className="text-foreground-muted">{'\u2014'}</span>
                                    },
                                    { label: 'Reconcile', value: <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${reconcileInfo.color}`}>{reconcileInfo.icon}</span> },
                                ]}
                            />
                        );
                    })}
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
            ) : (
            <div className="overflow-x-auto">
                <table ref={tableRef} className="w-full text-left border-collapse">
                    <thead>
                        {table.getHeaderGroups().map(headerGroup => (
                            <tr key={headerGroup.id} className="bg-background-secondary/50 text-foreground-secondary text-[10px] uppercase tracking-[0.2em] font-bold">
                                {headerGroup.headers.map(header => {
                                    const colId = header.column.id;
                                    if (colId === 'select') return (
                                        <th key={header.id} className="px-3 py-2 w-10">
                                            {isEditMode && (
                                                <input
                                                    type="checkbox"
                                                    checked={editSelectedGuids.size === displayTransactions.length && displayTransactions.length > 0}
                                                    onChange={(e) => {
                                                        if (e.target.checked) handleSelectAllEdit();
                                                        else setEditSelectedGuids(new Set());
                                                    }}
                                                    tabIndex={-1}
                                                    className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-cyan-500 cursor-pointer"
                                                />
                                            )}
                                        </th>
                                    );
                                    if (colId === 'reconcile') return <th key={header.id} className="px-3 py-2 w-10">R</th>;
                                    if (colId === 'date') return <th key={header.id} className="px-4 py-2">Date</th>;
                                    if (colId === 'description') return <th key={header.id} className="px-4 py-2">Description</th>;
                                    if (colId === 'transfer') return <th key={header.id} className="px-4 py-2">{isInvestmentAccount ? 'Transfer' : 'Transfer / Splits'}</th>;
                                    if (colId === 'debit') return <th key={header.id} className="px-4 py-2 text-right">Debit</th>;
                                    if (colId === 'credit') return <th key={header.id} className="px-4 py-2 text-right">Credit</th>;
                                    if (colId === 'balance') return <th key={header.id} className="px-4 py-2 text-right">Balance</th>;
                                    if (colId === 'shares') return <th key={header.id} className="px-4 py-2 text-right">Shares</th>;
                                    if (colId === 'price') return <th key={header.id} className="px-4 py-2 text-right">Price</th>;
                                    if (colId === 'buy') return <th key={header.id} className="px-4 py-2 text-right">Buy</th>;
                                    if (colId === 'sell') return <th key={header.id} className="px-4 py-2 text-right">Sell</th>;
                                    if (colId === 'shareBalance') return <th key={header.id} className="px-4 py-2 text-right">Share Bal</th>;
                                    if (colId === 'costBasis') return <th key={header.id} className="px-4 py-2 text-right">Cost Basis</th>;
                                    if (colId === 'actions') return <th key={header.id} className="px-2 py-2 w-10"></th>;
                                    return <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>;
                                })}
                            </tr>
                        ))}
                    </thead>
                    <tbody className="divide-y divide-border/50">
                        {isEditMode ? (
                            displayTransactions.map((tx, index) => (
                                isInvestmentAccount ? (
                                    <InvestmentEditRow
                                        key={tx.guid}
                                        ref={(handle) => {
                                            if (handle) editableRowRefs.current.set(tx.guid, handle);
                                            else editableRowRefs.current.delete(tx.guid);
                                        }}
                                        transaction={tx}
                                        accountGuid={accountGuid}
                                        isActive={index === focusedRowIndex}
                                        showCheckbox={true}
                                        isChecked={editSelectedGuids.has(tx.guid)}
                                        onToggleCheck={(e) => handleEditCheckToggle(index, tx.guid, (e as unknown as MouseEvent)?.shiftKey || false)}
                                        onSave={handleInvestmentInlineSave}
                                        onEditModal={handleEditDirect}
                                        onDuplicate={handleDuplicate}
                                        columnCount={table.getVisibleFlatColumns().length}
                                        onClick={() => setFocusedRowIndex(index)}
                                        focusedColumn={index === focusedRowIndex ? focusedColumnIndex : undefined}
                                        onEnter={async () => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) await handle.save();
                                            setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                        }}
                                        onArrowUp={async () => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) await handle.save();
                                            setFocusedRowIndex(i => Math.max(i - 1, 0));
                                        }}
                                        onArrowDown={async () => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) await handle.save();
                                            setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                        }}
                                        onColumnFocus={(col) => setFocusedColumnIndex(col)}
                                        onTabFromActions={async (direction) => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) {
                                                await handle.save();
                                            }

                                            if (direction === 'next') {
                                                setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                setFocusedColumnIndex(0);
                                                return;
                                            }

                                            setFocusedRowIndex(i => Math.max(i - 1, 0));
                                            setFocusedColumnIndex(4);
                                        }}
                                    />
                                ) : (
                                    <EditableRow
                                        key={tx.guid}
                                        ref={(handle) => {
                                            if (handle) editableRowRefs.current.set(tx.guid, handle);
                                            else editableRowRefs.current.delete(tx.guid);
                                        }}
                                        transaction={tx}
                                        accountGuid={accountGuid}
                                        accountType={accountType}
                                        isActive={index === focusedRowIndex}
                                        showCheckbox={true}
                                        isChecked={editSelectedGuids.has(tx.guid)}
                                        onToggleCheck={(e) => handleEditCheckToggle(index, tx.guid, (e as unknown as MouseEvent)?.shiftKey || false)}
                                        onSave={handleInlineSave}
                                        onEditModal={handleEditDirect}
                                        onDuplicate={handleDuplicate}
                                        columnCount={table.getVisibleFlatColumns().length}
                                        onClick={() => setFocusedRowIndex(index)}
                                        focusedColumn={index === focusedRowIndex ? focusedColumnIndex : undefined}
                                        onEnter={async () => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) await handle.save();
                                            setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                        }}
                                        onArrowUp={async () => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) await handle.save();
                                            setFocusedRowIndex(i => Math.max(i - 1, 0));
                                        }}
                                        onArrowDown={async () => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) await handle.save();
                                            setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                        }}
                                        onColumnFocus={(col) => setFocusedColumnIndex(col)}
                                        onTabFromActions={async (direction) => {
                                            const handle = editableRowRefs.current.get(tx.guid);
                                            if (handle?.isDirty()) {
                                                await handle.save();
                                            }

                                            if (direction === 'next') {
                                                setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                setFocusedColumnIndex(0);
                                                return;
                                            }

                                            setFocusedRowIndex(i => Math.max(i - 1, 0));
                                            setFocusedColumnIndex(4);
                                        }}
                                    />
                                )
                            ))
                        ) : (
                            table.getRowModel().rows.map((row) => {
                                const tx = row.original;
                                const index = row.index;
                                const isMultiSplit = isMultiSplitTransaction(tx.splits);
                                const isExpanded = expandedTxs[tx.guid];
                                const otherSplits = tx.splits?.filter(s =>
                                    s.account_guid !== accountGuid
                                    && !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')
                                ) || [];
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
                                                    <td key={cell.id} className="px-3 py-2 align-top">
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
                                                    <td key={cell.id} className="px-3 py-2 align-top">
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
                                                    <td key={cell.id} className="px-4 py-2 whitespace-nowrap text-[11px] text-foreground-secondary align-top font-mono">
                                                        {new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'description') {
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm text-foreground align-top leading-tight">
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
                                                if (isInvestmentAccount) {
                                                    const invRow = investmentRowMap?.get(tx.guid);
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm text-foreground-secondary align-top leading-tight">
                                                            <span className="text-xs whitespace-normal break-words">
                                                                {invRow?.transferAccount || '\u2014'}
                                                            </span>
                                                        </td>
                                                    );
                                                }
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm align-top">
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
                                                                        <span className="text-foreground-secondary whitespace-normal break-words">
                                                                            {formatDisplayAccountPath(split.account_fullname, split.account_name)}
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

                                            if (colId === 'debit') {
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top text-emerald-400">
                                                        {amount >= 0 ? formatCurrency(amount, tx.commodity_mnemonic) : ''}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'credit') {
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top text-rose-400">
                                                        {amount < 0 ? formatCurrency(Math.abs(amount), tx.commodity_mnemonic) : ''}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'balance') {
                                                return (
                                                    <td key={cell.id} className={`px-4 py-2 text-sm font-mono text-right align-top font-bold ${tx.running_balance ? (applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal) < 0 ? 'text-rose-400' : 'text-emerald-400') : 'text-foreground-muted'}`}>
                                                        {tx.running_balance ? formatCurrency(applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal), tx.commodity_mnemonic) : '\u2014'}
                                                    </td>
                                                );
                                            }

                                            // Investment-specific columns
                                            if (isInvestmentAccount) {
                                                const invRow = investmentRowMap?.get(tx.guid);

                                                if (colId === 'shares') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top">
                                                            {invRow?.shares != null ? (
                                                                <span className={invRow.shares > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                                                    {invRow.shares.toFixed(4)}
                                                                </span>
                                                            ) : (
                                                                <span className="opacity-30">&mdash;</span>
                                                            )}
                                                        </td>
                                                    );
                                                }

                                                if (colId === 'price') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top">
                                                            {invRow?.price != null ? (
                                                                <span className="text-foreground">
                                                                    {formatCurrency(invRow.price, invRow.currencyMnemonic)}
                                                                </span>
                                                            ) : (
                                                                <span className="opacity-30">&mdash;</span>
                                                            )}
                                                        </td>
                                                    );
                                                }

                                                if (colId === 'buy') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top">
                                                            {invRow?.buyAmount != null ? (
                                                                <span className="text-emerald-400">
                                                                    {formatCurrency(invRow.buyAmount, invRow.currencyMnemonic)}
                                                                </span>
                                                            ) : (
                                                                <span className="opacity-30">&mdash;</span>
                                                            )}
                                                        </td>
                                                    );
                                                }

                                                if (colId === 'sell') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top">
                                                            {invRow?.sellAmount != null ? (
                                                                <span className="text-rose-400">
                                                                    {formatCurrency(invRow.sellAmount, invRow.currencyMnemonic)}
                                                                </span>
                                                            ) : (
                                                                <span className="opacity-30">&mdash;</span>
                                                            )}
                                                        </td>
                                                    );
                                                }

                                                if (colId === 'shareBalance') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top font-bold text-foreground">
                                                            {invRow ? invRow.shareBalance.toFixed(4) : '\u2014'}
                                                        </td>
                                                    );
                                                }

                                                if (colId === 'costBasis') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-top font-bold text-foreground">
                                                            {invRow ? formatCurrency(invRow.costBasis, invRow.currencyMnemonic) : '\u2014'}
                                                        </td>
                                                    );
                                                }
                                            }

                                            return <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>;
                                        })}
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>

                {isEditMode && displayTransactions.length === 0 && (
                    <div className="p-12 text-center">
                        <div className="text-4xl mb-4">&#10003;</div>
                        <h3 className="text-lg font-semibold text-emerald-400 mb-2">All caught up!</h3>
                        <p className="text-sm text-foreground-muted">
                            {editReviewedCount > 0
                                ? `You reviewed ${editReviewedCount} transaction${editReviewedCount !== 1 ? 's' : ''} this session.`
                                : 'No unreviewed transactions.'}
                        </p>
                        <button
                            onClick={handleToggleEditMode}
                            className="mt-4 px-4 py-2 text-sm border border-border text-foreground-secondary hover:text-foreground rounded-lg transition-colors"
                        >
                            Exit Edit Mode
                        </button>
                    </div>
                )}

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
            )}

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

            <ConfirmationDialog
                isOpen={bulkDeleteConfirmOpen}
                onConfirm={handleBulkDelete}
                onCancel={() => setBulkDeleteConfirmOpen(false)}
                title="Delete Selected Transactions"
                message={`Delete ${editSelectedGuids.size} selected transaction${editSelectedGuids.size !== 1 ? 's' : ''}? This cannot be undone.`}
                confirmLabel="Delete"
                confirmVariant="danger"
            />
        </div>

        {/* Floating reconciliation panel - outside overflow-clip container */}
        {isReconciling && (
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
                onStartReconcile={() => { setIsEditMode(false); setIsReconciling(true); }}
                onCancelReconcile={() => {
                    setIsReconciling(false);
                    setSelectedSplits(new Set());
                }}
                simpleFinBalance={simpleFinBalance}
            />
        )}
        </>
    );
}
