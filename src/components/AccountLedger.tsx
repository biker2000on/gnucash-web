"use client";

import { Transaction } from '@/lib/types';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { FilterPanel, AmountFilter, ReconcileFilter } from './filters';
import ViewMenu from './ViewMenu';
import SplitRows from './ledger/SplitRows';
import BalancingRow from './ledger/BalancingRow';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import AccountPickerDialog from './AccountPickerDialog';
import EditableSplitRows, { EditableSplitRowsHandle } from '@/components/ledger/EditableSplitRows';
import { Modal } from '@/components/ui/Modal';

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
    accountCommodityGuid?: string;
    hasChildren?: boolean;
    onEscape?: () => void;
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
    accountCommodityGuid,
    hasChildren = false,
    onEscape,
}: AccountLedgerProps) {
    const { balanceReversal, defaultLedgerMode, ledgerViewStyle, setLedgerViewStyle, costBasisCarryOver, costBasisMethod } = useUserPreferences();
    const { success, error } = useToast();
    const isMobile = useIsMobile();
    const isInvestmentAccount = commodityNamespace !== undefined && commodityNamespace !== 'CURRENCY';
    const [transactions, setTransactions] = useState<AccountTransaction[]>(initialTransactions);
    const [offset, setOffset] = useState(initialTransactions.length);
    const [hasMore, setHasMore] = useState(initialTransactions.length >= 100);
    const [loading, setLoading] = useState(false);
    const [expandedTxs, setExpandedTxs] = useState<Record<string, boolean>>({});
    const [expandedTransactions, setExpandedTransactions] = useState<Set<string>>(new Set());
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
    const [showMoveDialog, setShowMoveDialog] = useState(false);

    // Keyboard navigation state
    const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
    const [focusedColumnIndex, setFocusedColumnIndex] = useState<number>(0);
    const [editingGuid, setEditingGuid] = useState<string | null>(null);
    const tableRef = useRef<HTMLTableElement>(null);

    // Reviewed filter state
    const [showUnreviewedOnly, setShowUnreviewedOnly] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Sub-accounts view state
    const [showSubaccounts, setShowSubaccounts] = useState(false);

    // Search and filter state
    const [searchText, setSearchText] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [filters, setFilters] = useState<{ minAmount: string; maxAmount: string; reconcileStates: string[] }>({
        minAmount: '',
        maxAmount: '',
        reconcileStates: [],
    });
    const [debouncedFilters, setDebouncedFilters] = useState(filters);
    const prevFiltersRef = useRef<{ hadSearch: boolean; hadFilters: boolean }>({ hadSearch: false, hadFilters: false });

    // Edit mode state (initialized from defaultLedgerMode preference)
    const [isEditMode, setIsEditMode] = useState(false);
    const [editModeInitialized, setEditModeInitialized] = useState(false);
    const [editReviewedCount, setEditReviewedCount] = useState(0);
    const [editSelectedGuids, setEditSelectedGuids] = useState<Set<string>>(new Set());
    const [lastCheckedIndex, setLastCheckedIndex] = useState<number | null>(null);
    const editableRowRefs = useRef<Map<string, EditableRowHandle | InvestmentEditRowHandle>>(new Map());
    const editableSplitRowRefs = useRef<Map<string, EditableSplitRowsHandle>>(new Map());
    const [focusedSplitIndex, setFocusedSplitIndex] = useState<number>(-1); // -1 = transaction line
    const [imbalanceDialogTx, setImbalanceDialogTx] = useState<string | null>(null);
    const [imbalanceAmount, setImbalanceAmount] = useState<number>(0);

    const isSlimEditMode = isEditMode && (ledgerViewStyle === 'journal' || ledgerViewStyle === 'autosplit');

    // View mode keyboard shortcuts
    useKeyboardShortcut('view-basic', 'v b', 'Basic Ledger view', () => setLedgerViewStyle('basic'), 'global');
    useKeyboardShortcut('view-journal', 'v j', 'Transaction Journal view', () => setLedgerViewStyle('journal'), 'global');
    useKeyboardShortcut('view-autosplit', 'v a', 'Auto-Split view', () => setLedgerViewStyle('autosplit'), 'global');

    // Initialize edit mode from preference on mount (once preferences are loaded)
    useEffect(() => {
        if (!editModeInitialized && defaultLedgerMode) {
            setIsEditMode(defaultLedgerMode === 'edit');
            setEditModeInitialized(true);
        }
    }, [defaultLedgerMode, editModeInitialized]);

    // Debounce search text
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchText), 300);
        return () => clearTimeout(timer);
    }, [searchText]);

    // Debounce advanced filters
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedFilters(filters), 300);
        return () => clearTimeout(timer);
    }, [filters]);

    // Count active filters
    const activeFilterCount = [
        filters.minAmount !== '',
        filters.maxAmount !== '',
        filters.reconcileStates.length > 0,
    ].filter(Boolean).length;

    const clearAllFilters = () => {
        setFilters({ minAmount: '', maxAmount: '', reconcileStates: [] });
    };

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
        if (showSubaccounts) params.set('includeSubaccounts', 'true');
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (debouncedFilters.minAmount) params.set('minAmount', debouncedFilters.minAmount);
        if (debouncedFilters.maxAmount) params.set('maxAmount', debouncedFilters.maxAmount);
        if (debouncedFilters.reconcileStates.length > 0) {
            params.set('reconcileStates', debouncedFilters.reconcileStates.join(','));
        }
        // Cost basis carry-over preferences
        params.set('costBasisCarryOver', String(costBasisCarryOver));
        params.set('costBasisMethod', costBasisMethod);
        Object.entries(extraParams).forEach(([key, value]) => {
            params.set(key, String(value));
        });
        return params.toString();
    }, [startDate, endDate, showUnreviewedOnly, showSubaccounts, debouncedSearch, debouncedFilters, costBasisCarryOver, costBasisMethod]);

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

    // Journal/autosplit save orchestration (combines EditableRow + EditableSplitRows)
    const handleJournalSave = useCallback(async (txGuid: string): Promise<boolean> => {
        const tx = transactions.find(t => t.guid === txGuid);
        if (!tx) return false;

        const rowHandle = editableRowRefs.current.get(txGuid);
        const splitHandle = editableSplitRowRefs.current.get(txGuid);
        if (!rowHandle || !splitHandle) return false;

        if (!rowHandle.isDirty() && !splitHandle.isDirty()) return true;

        const splitPayload = splitHandle.getSplitPayload();

        // Check balance
        const sum = splitPayload.reduce((acc, s) => acc + s.value_num / s.value_denom, 0);
        if (Math.abs(sum) > 0.001) {
            setImbalanceAmount(Math.abs(sum));
            setImbalanceDialogTx(txGuid);
            return false;
        }

        const txData = (rowHandle as EditableRowHandle).getTransactionData();
        const body = {
            currency_guid: txData.currency_guid,
            post_date: txData.post_date,
            description: txData.description,
            original_enter_date: tx.enter_date ? new Date(tx.enter_date as unknown as string).toISOString() : undefined,
            splits: splitPayload,
        };

        try {
            const res = await fetch(`/api/transactions/${txGuid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.status === 409) {
                error('Transaction was modified by another user. Refreshing...');
                await fetchTransactions();
                return false;
            }
            if (!res.ok) throw new Error('Failed to update');

            success('Transaction updated');
            await fetchTransactions();
            return true;
        } catch {
            error('Failed to save transaction');
            return false;
        }
    }, [transactions, fetchTransactions, success, error]);

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

    // Handle adding a new split to a transaction (for BalancingRow)
    const handleAddSplit = useCallback(async (transactionGuid: string, accountGuid: string, amount: number) => {
        try {
            const res = await fetch(`/api/transactions/${transactionGuid}`);
            if (!res.ok) throw new Error('Failed to fetch transaction');
            // Refresh transaction list after modification
            await fetchTransactions();
        } catch (err) {
            console.error('Failed to add split:', err);
        }
    }, [fetchTransactions]);

    // Bulk move handler
    const handleBulkMove = useCallback(async (targetAccountGuid: string, targetAccountName: string) => {
        // Resolve transaction GUIDs to split GUIDs
        const splitGuids: string[] = [];
        transactions.forEach(tx => {
            if (editSelectedGuids.has(tx.guid)) {
                let foundSplits = false;
                tx.splits?.forEach(split => {
                    if (split.account_guid === accountGuid) {
                        splitGuids.push(split.guid);
                        foundSplits = true;
                    }
                });
                if (!foundSplits && tx.account_split_guid) {
                    splitGuids.push(tx.account_split_guid);
                }
            }
        });

        if (splitGuids.length === 0) return;

        try {
            const res = await fetch('/api/splits/bulk/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ splitGuids, targetAccountGuid }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to move splits');
            }

            const data = await res.json();
            setEditSelectedGuids(new Set());
            await fetchTransactions();
            success(`Moved ${data.updated} split${data.updated !== 1 ? 's' : ''} to ${targetAccountName}`);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to move splits');
        }
    }, [transactions, editSelectedGuids, accountGuid, fetchTransactions, success, error]);

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
            viewStyle: ledgerViewStyle,
        });
    }, [accountGuid, isReconciling, isEditMode, isInvestmentAccount, ledgerViewStyle]);

    const table = useReactTable({
        data: displayTransactions,
        columns,
        getCoreRowModel: getCoreRowModel(),
    });

    // Helper to create a blank new transaction at the top of the list
    const createNewTransaction = useCallback(() => {
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
    }, [accountGuid]);

    // Keyboard navigation handler
    const handleTableKeyDown = useCallback(async (e: KeyboardEvent) => {
        if (editingGuid) return; // Let InlineEditRow handle keys during edit
        if (isEditModalOpen || isViewModalOpen || deleteConfirmOpen || showMoveDialog || imbalanceDialogTx) return; // Don't navigate when modals are open

        const target = e.target as HTMLElement;
        const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

        // Handle Esc in search input: clear text first, then blur
        if (isInInput && e.key === 'Escape' && target === searchInputRef.current) {
            e.preventDefault();
            if (searchText) {
                setSearchText('');
            } else {
                searchInputRef.current?.blur();
            }
            return;
        }

        // '/' to focus search input (when not in an input)
        if (!isInInput && e.key === '/') {
            e.preventDefault();
            searchInputRef.current?.focus();
            return;
        }

        if (isInInput) {
            // In edit mode, still handle Ctrl+R and Escape even in input fields
            if (isEditMode) {
                if (e.key === 'r' && e.ctrlKey) {
                    e.preventDefault();
                    if (editSelectedGuids.size > 0) {
                        await handleBulkReview();
                    } else if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
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

        if (isSlimEditMode && !isInInput) {
            switch (e.key) {
                case 'ArrowDown':
                case 'j': {
                    e.preventDefault();
                    if (focusedSplitIndex === -1) {
                        // On transaction line -> move to first split
                        setFocusedSplitIndex(0);
                        setFocusedColumnIndex(0);
                    } else {
                        // On a split row -> move to next split or next transaction
                        const tx = displayTransactions[focusedRowIndex];
                        const nonTradingSplits = (tx?.splits || []).filter(s =>
                            !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:'));
                        const totalSplitRows = nonTradingSplits.length + 1; // +1 for placeholder
                        if (focusedSplitIndex < totalSplitRows - 1) {
                            setFocusedSplitIndex(i => i + 1);
                        } else {
                            // Past last split -> save and move to next transaction
                            if (tx) await handleJournalSave(tx.guid);
                            if (!imbalanceDialogTx) {
                                setFocusedSplitIndex(-1);
                                setFocusedColumnIndex(0);
                                setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                            }
                        }
                    }
                    break;
                }
                case 'ArrowUp':
                case 'k': {
                    e.preventDefault();
                    if (focusedSplitIndex > 0) {
                        setFocusedSplitIndex(i => i - 1);
                    } else if (focusedSplitIndex === 0) {
                        setFocusedSplitIndex(-1);
                        setFocusedColumnIndex(1); // Focus description on tx line
                    } else {
                        // On transaction line -> move to previous transaction
                        if (focusedRowIndex > 0) {
                            const currentTx = displayTransactions[focusedRowIndex];
                            if (currentTx) await handleJournalSave(currentTx.guid);
                            if (!imbalanceDialogTx) {
                                setFocusedRowIndex(i => Math.max(i - 1, 0));
                                setFocusedSplitIndex(-1);
                                setFocusedColumnIndex(0);
                            }
                        }
                    }
                    break;
                }
                case 'n': {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (focusedRowIndex >= 0) {
                        const currentTx = displayTransactions[focusedRowIndex];
                        if (currentTx) await handleJournalSave(currentTx.guid);
                    }
                    createNewTransaction();
                    setFocusedSplitIndex(-1);
                    break;
                }
                case 'm': {
                    if (editSelectedGuids.size > 0) {
                        e.preventDefault();
                        setShowMoveDialog(true);
                    }
                    break;
                }
                case 'Escape':
                    setFocusedSplitIndex(-1);
                    setFocusedRowIndex(-1);
                    break;
            }
            return;
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
                    if (e.ctrlKey) {
                        e.preventDefault();
                        if (editSelectedGuids.size > 0) {
                            await handleBulkReview();
                        } else if (focusedRowIndex >= 0) {
                            const tx = displayTransactions[focusedRowIndex];
                            const handle = editableRowRefs.current.get(tx.guid);
                            if (handle?.isDirty()) await handle.save();
                            await toggleReviewed(tx.guid);
                            setEditReviewedCount(prev => prev + 1);
                            if (focusedRowIndex < displayTransactions.length - 1) {
                                setFocusedRowIndex(prev => prev + 1);
                            }
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
                case 'm': {
                    if (editSelectedGuids.size > 0) {
                        e.preventDefault();
                        setShowMoveDialog(true);
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
                    createNewTransaction();
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
            case 's':
                if (hasChildren) {
                    e.preventDefault();
                    setShowSubaccounts(prev => !prev);
                }
                break;
            case 'ArrowRight':
                if (ledgerViewStyle === 'basic' && focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                    const tx = displayTransactions[focusedRowIndex];
                    if (tx && !expandedTransactions.has(tx.guid) && tx.splits && tx.splits.length > 1) {
                        setExpandedTransactions(prev => new Set(prev).add(tx.guid));
                        e.preventDefault();
                    }
                }
                break;
            case 'ArrowLeft':
                if (ledgerViewStyle === 'basic' && focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                    const tx = displayTransactions[focusedRowIndex];
                    if (tx && expandedTransactions.has(tx.guid)) {
                        setExpandedTransactions(prev => {
                            const next = new Set(prev);
                            next.delete(tx.guid);
                            return next;
                        });
                        e.preventDefault();
                    }
                }
                break;
            case 'Escape':
                if (focusedRowIndex === -1) {
                    onEscape?.();
                } else {
                    setFocusedRowIndex(-1);
                }
                break;
        }
    }, [editingGuid, isEditModalOpen, isViewModalOpen, deleteConfirmOpen, showMoveDialog, imbalanceDialogTx, focusedRowIndex, focusedSplitIndex, displayTransactions, isEditMode, isSlimEditMode, handleRowClick, handleEditDirect, handleJournalSave, handleDuplicate, handleDeleteClick, createNewTransaction, toggleReviewed, handleBulkReview, onEscape, searchText, hasChildren, ledgerViewStyle, expandedTransactions, editSelectedGuids]);

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

    // Auto-save on focus change in auto-split edit mode
    const prevFocusedTxIndexRef = useRef(focusedRowIndex);
    useEffect(() => {
        if (!isSlimEditMode || ledgerViewStyle !== 'autosplit') return;
        const prevIndex = prevFocusedTxIndexRef.current;
        prevFocusedTxIndexRef.current = focusedRowIndex;

        if (prevIndex === focusedRowIndex || prevIndex < 0) return;

        const prevTx = displayTransactions[prevIndex];
        if (!prevTx) return;

        const splitHandle = editableSplitRowRefs.current.get(prevTx.guid);
        const rowHandle = editableRowRefs.current.get(prevTx.guid);
        if (splitHandle?.isDirty() || rowHandle?.isDirty()) {
            handleJournalSave(prevTx.guid);
        }
    }, [focusedRowIndex, isSlimEditMode, ledgerViewStyle, displayTransactions, handleJournalSave]);

    // Reset focusedSplitIndex when focusedRowIndex changes
    useEffect(() => {
        setFocusedSplitIndex(-1);
    }, [focusedRowIndex]);

    // Scroll focused split row into view
    useEffect(() => {
        if (!isSlimEditMode || focusedSplitIndex < 0 || focusedRowIndex < 0) return;

        requestAnimationFrame(() => {
            const tbody = document.querySelector('tbody');
            if (!tbody) return;

            const allRows = Array.from(tbody.children) as HTMLElement[];
            let txCount = -1;
            let splitCountInCurrentTx = 0;

            for (const row of allRows) {
                if (row.hasAttribute('data-split-row')) {
                    if (txCount === focusedRowIndex && splitCountInCurrentTx === focusedSplitIndex) {
                        row.scrollIntoView({ block: 'nearest' });
                        return;
                    }
                    splitCountInCurrentTx++;
                } else {
                    // This is a transaction row
                    txCount++;
                    splitCountInCurrentTx = 0;
                }
            }
        });
    }, [focusedSplitIndex, focusedRowIndex, isSlimEditMode]);

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

    // Reset and re-fetch when unreviewed filter or sub-accounts toggle changes
    useEffect(() => {
        setOffset(0);
        setHasMore(true);
        setFocusedRowIndex(-1);
        fetchTransactions();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showUnreviewedOnly, showSubaccounts]);

    // Reset and re-fetch when search or advanced filters change
    useEffect(() => {
        const hasSearch = debouncedSearch !== '';
        const hasFilters = debouncedFilters.minAmount !== '' ||
            debouncedFilters.maxAmount !== '' ||
            debouncedFilters.reconcileStates.length > 0;
        const filtersWereCleared =
            (prevFiltersRef.current.hadSearch || prevFiltersRef.current.hadFilters) &&
            !hasSearch && !hasFilters;
        prevFiltersRef.current = { hadSearch: hasSearch, hadFilters: hasFilters };

        if (hasSearch || hasFilters || filtersWereCleared) {
            setOffset(0);
            setHasMore(true);
            setFocusedRowIndex(-1);
            fetchTransactions();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch, debouncedFilters]);

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
            {/* Top Bar: Filters + Search left, Buttons right */}
            <div className="p-4 border-b border-border flex flex-col md:flex-row gap-3">
                {/* Filters and Search */}
                <div className="flex gap-2 items-center flex-1 min-w-0">
                    <FilterPanel
                        activeFilterCount={activeFilterCount}
                        onClearAll={clearAllFilters}
                    >
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
                    <div className="relative flex-1 min-w-0">
                        <input
                            ref={searchInputRef}
                            type="text"
                            placeholder="Search... (press / to focus)"
                            className="w-full bg-input-bg border border-border rounded-xl px-4 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50 transition-all pl-10"
                            value={searchText}
                            onChange={(e) => setSearchText(e.target.value)}
                        />
                        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        {searchText && (
                            <button
                                onClick={() => setSearchText('')}
                                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground-secondary min-h-[44px] min-w-[44px] flex items-center justify-center"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        )}
                    </div>
                </div>

                {/* Action buttons - right aligned */}
                <div className="flex flex-wrap gap-2 items-center md:justify-end">
                    <button
                        onClick={() => {
                            setEditingTransaction(null);
                            setIsEditModalOpen(true);
                        }}
                        title={isEditMode ? 'New Transaction (n)' : 'New Transaction'}
                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors font-medium flex items-center gap-2"
                    >
                        New Transaction
                    </button>
                    <ViewMenu
                        showSubaccounts={showSubaccounts}
                        onToggleSubaccounts={() => setShowSubaccounts(prev => !prev)}
                        showUnreviewedOnly={showUnreviewedOnly}
                        onToggleUnreviewed={() => setShowUnreviewedOnly(prev => !prev)}
                        hasSubaccounts={hasChildren}
                    />
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
                                title="Mark Reviewed (Ctrl+R)"
                                className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center"
                            >
                                Mark Reviewed ({editSelectedGuids.size})
                            </button>
                            {editSelectedGuids.size > 0 && (
                                <>
                                    <button
                                        onClick={() => setShowMoveDialog(true)}
                                        title="Move to Account (m)"
                                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-blue-400 hover:border-blue-500/30 hover:bg-blue-500/10 transition-colors flex items-center"
                                    >
                                        Move to Account ({editSelectedGuids.size})
                                    </button>
                                    <button
                                        onClick={() => setBulkDeleteConfirmOpen(true)}
                                        title="Delete Selected (x)"
                                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-rose-400 hover:border-rose-500/30 hover:bg-rose-500/10 transition-colors flex items-center"
                                    >
                                        Delete Selected ({editSelectedGuids.size})
                                    </button>
                                </>
                            )}
                        </div>
                    )}
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
                        const isUnreviewed = tx.reviewed === false;

                        return isInvestmentAccount && invRow ? (
                            <div key={tx.guid} className={`bg-surface/30 backdrop-blur border border-border rounded-xl p-3 space-y-2 ${isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}`} onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}>
                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="text-xs text-foreground-muted">
                                            {new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                                        </div>
                                        <div className="text-sm font-medium flex items-center gap-2">
                                            {tx.description}
                                            {tx.source && tx.source !== 'manual' && (
                                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider font-bold">Imported</span>
                                            )}
                                        </div>
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
                                className={isUnreviewed ? 'border-l-2 border-l-amber-500' : ''}
                                fields={[
                                    { label: 'Date', value: new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' }) },
                                    { label: 'Description', value: <span className="font-medium flex items-center gap-2">{tx.description}{tx.source && tx.source !== 'manual' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider font-bold">Imported</span>}</span> },
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
                                    if (colId === 'expand') return <th key={header.id} className="px-1 py-2 w-7"></th>;
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
                                ) : isSlimEditMode ? (
                                    <React.Fragment key={tx.guid}>
                                        <EditableRow
                                            ref={(handle) => {
                                                if (handle) editableRowRefs.current.set(tx.guid, handle);
                                                else editableRowRefs.current.delete(tx.guid);
                                            }}
                                            transaction={tx}
                                            accountGuid={accountGuid}
                                            accountType={accountType}
                                            isActive={index === focusedRowIndex && focusedSplitIndex === -1}
                                            showCheckbox={true}
                                            isChecked={editSelectedGuids.has(tx.guid)}
                                            onToggleCheck={(e) => handleEditCheckToggle(index, tx.guid, (e as unknown as MouseEvent)?.shiftKey || false)}
                                            onSave={handleInlineSave}
                                            onEditModal={handleEditDirect}
                                            onDuplicate={handleDuplicate}
                                            columnCount={table.getVisibleFlatColumns().length}
                                            onClick={() => { setFocusedRowIndex(index); setFocusedSplitIndex(-1); }}
                                            focusedColumn={index === focusedRowIndex && focusedSplitIndex === -1 ? focusedColumnIndex : undefined}
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
                                            onArrowDown={() => { setFocusedSplitIndex(0); setFocusedColumnIndex(0); }}
                                            onColumnFocus={(col) => setFocusedColumnIndex(col)}
                                            ledgerViewStyle={ledgerViewStyle}
                                            onTabToSplits={() => { setFocusedSplitIndex(0); setFocusedColumnIndex(0); }}
                                        />
                                        {(
                                            ledgerViewStyle === 'journal' ||
                                            (ledgerViewStyle === 'autosplit' && index === focusedRowIndex)
                                        ) && (
                                            <EditableSplitRows
                                                ref={(handle) => {
                                                    if (handle) editableSplitRowRefs.current.set(tx.guid, handle);
                                                    else editableSplitRowRefs.current.delete(tx.guid);
                                                }}
                                                transaction={tx}
                                                accountGuid={accountGuid}
                                                columns={table.getVisibleFlatColumns().length}
                                                isActive={index === focusedRowIndex}
                                                focusedSplitIndex={index === focusedRowIndex ? focusedSplitIndex : undefined}
                                                focusedColumnIndex={index === focusedRowIndex && focusedSplitIndex >= 0 ? focusedColumnIndex : undefined}
                                                onFocusedSplitChange={(si) => { setFocusedRowIndex(index); setFocusedSplitIndex(si); }}
                                                onColumnFocus={(col) => setFocusedColumnIndex(col)}
                                                onArrowUp={() => { setFocusedSplitIndex(-1); setFocusedColumnIndex(1); }}
                                                onArrowDownPastEnd={async () => {
                                                    await handleJournalSave(tx.guid);
                                                    if (!imbalanceDialogTx) {
                                                        setFocusedSplitIndex(-1);
                                                        setFocusedColumnIndex(0);
                                                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                    }
                                                }}
                                                onTabToNextTransaction={async () => {
                                                    await handleJournalSave(tx.guid);
                                                    if (!imbalanceDialogTx) {
                                                        setFocusedSplitIndex(-1);
                                                        setFocusedColumnIndex(0);
                                                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                    }
                                                }}
                                            />
                                        )}
                                    </React.Fragment>
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
                                const nonTradingSplits = tx.splits?.filter(s =>
                                    !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')
                                ) || [];
                                const otherSplits = showSubaccounts
                                    ? nonTradingSplits
                                    : nonTradingSplits.filter(s => s.account_guid !== accountGuid);
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

                                const showSplitRows =
                                    ledgerViewStyle === 'journal' ||
                                    (ledgerViewStyle === 'autosplit' && focusedRowIndex === index) ||
                                    (ledgerViewStyle === 'basic' && expandedTransactions.has(tx.guid));

                                return (
                                    <React.Fragment key={row.id}>
                                    <tr
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
                                                    <td key={cell.id} className="px-3 py-2 align-middle">
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

                                            if (colId === 'expand') {
                                                return (
                                                    <td
                                                        key={cell.id}
                                                        className="px-1 py-2 cursor-pointer text-foreground-muted hover:text-foreground w-7 align-middle"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setExpandedTransactions(prev => {
                                                                const next = new Set(prev);
                                                                if (next.has(tx.guid)) {
                                                                    next.delete(tx.guid);
                                                                } else {
                                                                    next.add(tx.guid);
                                                                }
                                                                return next;
                                                            });
                                                        }}
                                                    >
                                                        {tx.splits && tx.splits.length > 1 ? (
                                                            expandedTransactions.has(tx.guid) ? '\u25BC' : '\u25B6'
                                                        ) : null}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'reconcile') {
                                                return (
                                                    <td key={cell.id} className="px-3 py-2 align-middle">
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
                                                    <td key={cell.id} className="px-4 py-2 whitespace-nowrap text-[11px] text-foreground-secondary align-middle font-mono">
                                                        {new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'description') {
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm text-foreground align-middle leading-tight">
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
                                                if (isInvestmentAccount && !showSubaccounts) {
                                                    const invRow = investmentRowMap?.get(tx.guid);
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm text-foreground-secondary align-middle leading-tight">
                                                            <span className="text-xs whitespace-normal break-words">
                                                                {invRow?.transferAccount || '\u2014'}
                                                            </span>
                                                        </td>
                                                    );
                                                }

                                                // Sub-accounts mode: always show all splits with amounts
                                                if (showSubaccounts) {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm align-middle">
                                                            <div className="space-y-1">
                                                                {otherSplits.map((split) => (
                                                                    <div key={split.guid} className="flex justify-between items-center text-xs">
                                                                        <span className="text-foreground-secondary whitespace-normal break-words">
                                                                            {formatDisplayAccountPath(split.account_fullname, split.account_name)}
                                                                        </span>
                                                                        <span className={`font-mono ml-2 ${parseFloat(split.quantity_decimal || '0') < 0 ? 'text-rose-400/70' : 'text-emerald-400/70'}`}>
                                                                            {formatCurrency(split.quantity_decimal || '0', split.commodity_mnemonic)}
                                                                        </span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </td>
                                                    );
                                                }

                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm align-middle">
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
                                                    <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle text-emerald-400">
                                                        {amount >= 0 ? formatCurrency(amount, tx.commodity_mnemonic) : ''}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'credit') {
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle text-rose-400">
                                                        {amount < 0 ? formatCurrency(Math.abs(amount), tx.commodity_mnemonic) : ''}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'balance') {
                                                return (
                                                    <td key={cell.id} className={`px-4 py-2 text-sm font-mono text-right align-middle font-bold ${tx.running_balance ? (applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal) < 0 ? 'text-rose-400' : 'text-emerald-400') : 'text-foreground-muted'}`}>
                                                        {tx.running_balance ? formatCurrency(applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal), tx.commodity_mnemonic) : '\u2014'}
                                                    </td>
                                                );
                                            }

                                            // Investment-specific columns
                                            if (isInvestmentAccount) {
                                                const invRow = investmentRowMap?.get(tx.guid);

                                                if (colId === 'shares') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle">
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
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle">
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
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle">
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
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle">
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
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle font-bold text-foreground">
                                                            {invRow ? invRow.shareBalance.toFixed(4) : '\u2014'}
                                                        </td>
                                                    );
                                                }

                                                if (colId === 'costBasis') {
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle font-bold text-foreground">
                                                            {invRow ? formatCurrency(invRow.costBasis, invRow.currencyMnemonic) : '\u2014'}
                                                        </td>
                                                    );
                                                }
                                            }

                                            return <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>;
                                        })}
                                    </tr>
                                    {showSplitRows && tx.splits && tx.splits.length > 0 && (
                                        <SplitRows
                                            splits={tx.splits.map(s => ({
                                                guid: s.guid,
                                                account_name: s.account_name || '',
                                                account_fullname: s.account_fullname || '',
                                                memo: s.memo || '',
                                                value_decimal: s.value_decimal ? parseFloat(s.value_decimal) : (parseFloat(s.value_num?.toString() || '0') / parseFloat(s.value_denom?.toString() || '1')),
                                                quantity_decimal: parseFloat(s.quantity_decimal || '0'),
                                                account_guid: s.account_guid,
                                            }))}
                                            currencyMnemonic={tx.commodity_mnemonic || 'USD'}
                                            columns={row.getVisibleCells().length}
                                        />
                                    )}
                                    </React.Fragment>
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

        <AccountPickerDialog
            isOpen={showMoveDialog}
            onClose={() => setShowMoveDialog(false)}
            onSelect={(guid, name) => {
                handleBulkMove(guid, name);
                setShowMoveDialog(false);
            }}
            excludeAccountGuid={accountGuid}
            commodityGuid={accountCommodityGuid}
            title={`Move ${editSelectedGuids.size} transaction${editSelectedGuids.size !== 1 ? 's' : ''} to...`}
        />

        <Modal
            isOpen={!!imbalanceDialogTx}
            onClose={() => setImbalanceDialogTx(null)}
            title="Unbalanced Transaction"
            size="sm"
        >
            <div className="p-4 space-y-4">
                <p className="text-sm text-foreground-secondary">
                    Transaction is unbalanced by {imbalanceAmount.toFixed(2)}. What would you like to do?
                </p>
                <div className="flex gap-3 justify-end">
                    <button
                        onClick={() => {
                            if (imbalanceDialogTx) {
                                const splitHandle = editableSplitRowRefs.current.get(imbalanceDialogTx);
                                splitHandle?.revert();
                            }
                            setImbalanceDialogTx(null);
                        }}
                        className="px-3 py-2 text-sm rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                    >
                        Revert Changes
                    </button>
                    <button
                        onClick={() => {
                            const txIndex = displayTransactions.findIndex(t => t.guid === imbalanceDialogTx);
                            if (txIndex >= 0) {
                                setFocusedRowIndex(txIndex);
                                setFocusedSplitIndex(0);
                            }
                            setImbalanceDialogTx(null);
                        }}
                        className="px-3 py-2 text-sm rounded-lg bg-accent-primary text-white hover:bg-accent-primary/90 transition-colors"
                    >
                        Continue Editing
                    </button>
                </div>
            </div>
        </Modal>

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
