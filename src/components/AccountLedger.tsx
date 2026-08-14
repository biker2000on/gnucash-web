"use client";

import { Split, Transaction } from '@/lib/types';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { formatDisplayAccountPath } from '@/lib/account-path';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { ReconciliationPanel } from './ReconciliationPanel';
import { suppressNextDataEvent } from './DataEventsProvider';
import { TransactionModal, originalPayeeLine } from './TransactionModal';
import { TransactionFormModal } from './TransactionFormModal';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { Abbr } from './ui/Abbr';
import { InlineEditRow } from './InlineEditRow';
import { EditableRow, EditableRowHandle } from './ledger/EditableRow';
import { InvestmentEditRow, InvestmentEditRowHandle, InvestmentSaveData } from './ledger/InvestmentEditRow';
import { useToast } from '@/contexts/ToastContext';
import { toNumDenom } from '@/lib/validation';
import { throwErrorBody } from '@/lib/api-error';
import {
    useReactTable,
    getCoreRowModel,
    flexRender,
} from '@tanstack/react-table';
import { getColumns, getInvestmentColumns } from './ledger/columns';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { SwipeableTransactionCard } from '@/components/ledger/SwipeableTransactionCard';
import { MobileCard } from './ui/MobileCard';
import { parseTransactionsResponse, transformToInvestmentRow, isMultiSplitTransaction, InvestmentRowData } from './ledger/investment-utils';
import { toLocalDateString } from '@/lib/datePresets';
import { FilterPanel, AmountFilter, ReconcileFilter } from './filters';
import { FilterBar } from './ui/FilterBar';
import { ActionMenu, type ActionMenuItem } from './ui/ActionMenu';
import ViewMenu from './ViewMenu';
import SplitRows from './ledger/SplitRows';
import { JumpToAccountButton } from './ledger/JumpToAccountButton';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import AccountPickerDialog from './AccountPickerDialog';
import EditableSplitRows, { EditableSplitRowsHandle, hasNonCurrencySplit, isNonCurrencySplit } from '@/components/ledger/EditableSplitRows';
import { Modal } from '@/components/ui/Modal';
import LotViewer from './ledger/LotViewer';
import TransactionTypeIcon from './ledger/TransactionTypeIcon';
import LotBadge from './ledger/LotBadge';
import LotAssignmentPopover from './ledger/LotAssignmentPopover';
import { ReceiptIndicator } from '@/components/receipts/ReceiptIndicator';
import { TransactionContextMenu, type TransactionContextMenuItem } from '@/components/ledger/TransactionContextMenu';
import { TransactionTagEditor } from '@/components/tags/TransactionTagEditor';
import { BulkDescriptionModal, BulkTagsModal, type BulkDescriptionPayload } from '@/components/ledger/BulkEditModals';
import TagChip from '@/components/tags/TagChip';
import type { Tag } from '@/lib/tags';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
    getRowAccountSplits,
    getSelectableRowSplits,
    isRowSelected,
    selectAllRows,
    sumSelectedRows,
    toggleRowSelection,
    type ReconciliationRowSplit,
} from '@/lib/reconciliation-selection';

export interface AccountTransaction extends Transaction {
    running_balance: string;
    account_split_value: string;
    commodity_mnemonic: string;
    account_split_guid: string;
    account_split_reconcile_state: string;
    account_splits?: ReconciliationRowSplit[];
    share_balance?: string;
    cost_basis?: string;
    reviewed?: boolean;
    source?: string;
    match_type?: string | null;
    /** Preserved import-time payee; null/absent for manual transactions. */
    original_description?: string | null;
    receipt_count?: number;
}

/**
 * Replace the transaction SSE echo suppressed after local bulk mutations.
 * The account hierarchy uses these independent derived caches for totals and
 * account status rollups; reloading only this ledger does not refresh them.
 */
export function invalidateTransactionAccountCaches(queryClient: Pick<QueryClient, 'invalidateQueries'>) {
    return Promise.all([
        queryClient.invalidateQueries({ queryKey: ['accounts', 'balances'] }),
        queryClient.invalidateQueries({ queryKey: ['accounts', 'reconcile-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['accounts', 'review-status'] }),
    ]);
}

/**
 * Fractions for one side of an inline two-split save.
 *
 * `keepStored` means the user did not touch this side's amount, so the stored
 * numerator/denominator pair is returned verbatim. Recomputing it at denom 100
 * would rewrite a 100000/10000 quantity (10.0000 shares) as 250000/100 (2,500
 * shares) — the value still balances, so nothing would flag the corruption.
 *
 * When the amount did change, only the VALUE is recomputed, at the split's own
 * denominator. A non-currency quantity is left as stored because it cannot be
 * derived from a dollar figure.
 */
export function splitFractions(original: Split | undefined, amount: number, keepStored: boolean) {
    const valueDenom = Number(original?.value_denom) || 100;
    const quantityDenom = Number(original?.quantity_denom) || valueDenom;

    if (original && keepStored) {
        return {
            value_num: Number(original.value_num),
            value_denom: valueDenom,
            quantity_num: Number(original.quantity_num),
            quantity_denom: quantityDenom,
        };
    }

    const valueNum = Math.round(amount * valueDenom);

    if (original && isNonCurrencySplit(original)) {
        return {
            value_num: valueNum,
            value_denom: valueDenom,
            quantity_num: Number(original.quantity_num),
            quantity_denom: quantityDenom,
        };
    }

    return {
        value_num: valueNum,
        value_denom: valueDenom,
        quantity_num: valueNum,
        quantity_denom: valueDenom,
    };
}

/** One split as the transaction PUT/POST handlers expect it. */
export type InlineSplitPayload = {
    guid?: string;
    account_guid: string;
    value_num: number;
    value_denom: number;
    quantity_num: number;
    quantity_denom: number;
    memo: string;
    reconcile_state: string;
};

/**
 * Both sides of an inline two-split save.
 *
 * The PUT handler deletes and recreates every split from this payload, so a
 * field omitted here is destroyed: memos vanish and reconciled splits fall back
 * to 'n'. Carrying the split guid additionally lets the handler keep `action`,
 * `lot_guid`, and the reconcile_date that belongs to a preserved state.
 *
 * Reconcile rule: a split keeps its stored reconcile_state only while its own
 * amount and account are untouched. An edited amount no longer agrees with the
 * statement it was reconciled against, and a retargeted transfer is a different
 * split entirely — both reset to 'n'. A date/description-only edit leaves both
 * sides exactly as they were.
 */
export function inlineTwoSplitPayload({
    accountGuid,
    ownSplit,
    otherSplit,
    transferAccountGuid,
    signedAmount,
    amountChanged,
    transferChanged,
    ownReconcileState,
    ownMemo,
}: {
    accountGuid: string;
    ownSplit?: Split;
    otherSplit?: Split;
    transferAccountGuid: string;
    signedAmount: number;
    amountChanged: boolean;
    transferChanged: boolean;
    ownReconcileState?: string | null;
    /**
     * Double-line edit: the memo typed for this account's split. Undefined
     * means the memo was not edited — the stored memo is carried through.
     * A memo edit never touches reconcile state (only amount/account do).
     */
    ownMemo?: string;
}): InlineSplitPayload[] {
    return [
        {
            ...(ownSplit ? { guid: ownSplit.guid } : {}),
            account_guid: accountGuid,
            ...splitFractions(ownSplit, signedAmount, !amountChanged),
            memo: ownMemo !== undefined ? ownMemo : (ownSplit?.memo ?? ''),
            reconcile_state: amountChanged ? 'n' : (ownReconcileState || 'n'),
        },
        {
            ...(otherSplit && !transferChanged ? { guid: otherSplit.guid } : {}),
            account_guid: transferAccountGuid,
            ...splitFractions(otherSplit, -signedAmount, !amountChanged && !transferChanged),
            memo: transferChanged ? '' : (otherSplit?.memo ?? ''),
            reconcile_state: amountChanged || transferChanged
                ? 'n'
                : (otherSplit?.reconcile_state || 'n'),
        },
    ];
}

/**
 * Double-line edit view preference (GnuCash desktop's View > Double Line
 * mode). Persisted to localStorage like the other ledger view state
 * (AccountHierarchy uses the same pattern for its expansion/sort toggles).
 */
export const DOUBLE_LINE_STORAGE_KEY = 'accountLedger.doubleLineEdit';

export function readDoubleLinePreference(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return localStorage.getItem(DOUBLE_LINE_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function writeDoubleLinePreference(value: boolean): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(DOUBLE_LINE_STORAGE_KEY, String(value));
    } catch {
        // localStorage unavailable (private mode/quota) — preference just won't persist
    }
}

type HoldingPeriod = 'short_term' | 'long_term' | null;

interface LotSummary {
    guid: string;
    isClosed: boolean;
    title: string;
    totalShares: number;
    totalCost: number;
    unrealizedGain: number | null;
    holdingPeriod: HoldingPeriod;
}

interface LotMapEntry extends Omit<LotSummary, 'guid'> {
    index: number;
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
    commodityScu?: number;
    hasChildren?: boolean;
    /** Initialize the sub-accounts toggle on (e.g. from a ?subaccounts=1 URL param). */
    initialShowSubaccounts?: boolean;
    onEscape?: () => void;
    /** Called with the latest running_balance of the newest transaction after any
     *  refetch, so the parent page can update its "Current Balance" header. */
    onCurrentBalanceChange?: (runningBalance: string | null) => void;
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
    commodityScu,
    hasChildren = false,
    initialShowSubaccounts = false,
    onEscape,
    onCurrentBalanceChange,
}: AccountLedgerProps) {
    const { balanceReversal, defaultLedgerMode, ledgerViewStyle, setLedgerViewStyle, costBasisCarryOver, costBasisMethod } = useUserPreferences();
    const { success, error } = useToast();
    const queryClient = useQueryClient();
    const router = useRouter();
    const { isReadonly } = useCurrentUser();
    const isMobile = useIsMobile();
    const isInvestmentAccount = commodityNamespace !== undefined && commodityNamespace !== 'CURRENCY';
    const sharePrecision = commodityScu ? Math.max(0, Math.round(Math.log10(commodityScu))) : 4;
    const [transactions, setTransactions] = useState<AccountTransaction[]>(initialTransactions);
    const investmentCurrentShares = useMemo(() => {
        const latestSaved = transactions.find(tx => Boolean(tx.currency_guid));
        const balance = latestSaved
            ? Number(latestSaved.share_balance ?? latestSaved.running_balance)
            : currentBalance;
        return Number.isFinite(balance) ? balance : 0;
    }, [transactions, currentBalance]);
    const investmentCurrencyGuid = useMemo(
        () => transactions.find(tx => Boolean(tx.currency_guid))?.currency_guid || '',
        [transactions],
    );
    const investmentSymbol = useMemo(
        () => transactions.find(tx => Boolean(tx.commodity_mnemonic))?.commodity_mnemonic || accountCurrency,
        [transactions, accountCurrency],
    );
    const investmentAvailableSharesFor = useCallback((tx: AccountTransaction) => {
        const accountSplit = tx.splits?.find(split => split.account_guid === accountGuid);
        const originalQuantity = accountSplit
            ? Number(accountSplit.quantity_num) / Number(accountSplit.quantity_denom)
            : 0;
        return Math.max(
            0,
            investmentCurrentShares + (tx.currency_guid && originalQuantity < 0 ? Math.abs(originalQuantity) : 0),
        );
    }, [accountGuid, investmentCurrentShares]);
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
    const [reconciledBalance, setReconciledBalance] = useState<number>(currentBalance);

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
    const [bulkDescOpen, setBulkDescOpen] = useState(false);
    const [bulkRecatOpen, setBulkRecatOpen] = useState(false);
    const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tx: AccountTransaction } | null>(null);

    // Keyboard navigation state
    const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
    const [focusedColumnIndex, setFocusedColumnIndex] = useState<number>(0);
    const [editingGuid, setEditingGuid] = useState<string | null>(null);
    const tableRef = useRef<HTMLTableElement>(null);

    // Reviewed filter state
    const [showUnreviewedOnly, setShowUnreviewedOnly] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Sub-accounts view state
    const [showSubaccounts, setShowSubaccounts] = useState(initialShowSubaccounts && hasChildren);

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
    const [lastEditedDate, setLastEditedDate] = useState<string | null>(null);

    // Lots view state
    const [showLotsView, setShowLotsView] = useState(false);
    const [lotMap, setLotMap] = useState<Map<string, LotMapEntry>>(new Map());
    const [accountCostBasisMethod, setAccountCostBasisMethod] = useState<string | null>(null);

    const isSlimEditMode = isEditMode && (ledgerViewStyle === 'journal' || ledgerViewStyle === 'autosplit');

    // Double-line edit view (transaction notes + split memo on a second row).
    // Loaded after mount so SSR markup stays deterministic.
    const [doubleLineEdit, setDoubleLineEdit] = useState(false);
    useEffect(() => {
        setDoubleLineEdit(readDoubleLinePreference());
    }, []);
    const toggleDoubleLineEdit = useCallback(() => {
        setDoubleLineEdit(prev => {
            const next = !prev;
            writeDoubleLinePreference(next);
            return next;
        });
    }, []);

    // View mode keyboard shortcuts
    useKeyboardShortcut('view-basic', 'v b', 'Basic Ledger view', () => setLedgerViewStyle('basic'), 'page');
    useKeyboardShortcut('view-journal', 'v j', 'Transaction Journal view', () => setLedgerViewStyle('journal'), 'page');
    useKeyboardShortcut('view-autosplit', 'v a', 'Auto-Split view', () => setLedgerViewStyle('autosplit'), 'page');

    // Initialize edit mode from preference on mount (once preferences are loaded)
    useEffect(() => {
        if (!editModeInitialized && defaultLedgerMode) {
            setIsEditMode(defaultLedgerMode === 'edit' && !isReadonly);
            setEditModeInitialized(true);
        }
    }, [defaultLedgerMode, editModeInitialized, isReadonly]);

    // Force-exit edit mode if the role resolves to readonly after init
    useEffect(() => {
        if (isReadonly) setIsEditMode(false);
    }, [isReadonly]);

    // Fetch lot data for investment accounts (for lot badges)
    useEffect(() => {
        if (!isInvestmentAccount) return;
        fetch(`/api/accounts/${accountGuid}/lots`)
            .then(res => res.json())
            .then(data => {
                const lots: LotSummary[] = Array.isArray(data) ? data : data.lots || [];
                const map = new Map<string, LotMapEntry>();
                lots.forEach((lot, i) => {
                    map.set(lot.guid, {
                        index: i + 1,
                        isClosed: lot.isClosed,
                        title: lot.title,
                        totalShares: lot.totalShares,
                        totalCost: lot.totalCost,
                        unrealizedGain: lot.unrealizedGain,
                        holdingPeriod: lot.holdingPeriod,
                    });
                });
                setLotMap(map);
            })
            .catch((err) => { console.error('Failed to fetch lot data:', err); }); // Lot badges are optional, but log errors for debugging
    }, [isInvestmentAccount, accountGuid]);

    const refreshLotMap = () => {
        fetch(`/api/accounts/${accountGuid}/lots`)
            .then(r => r.json())
            .then(data => {
                const lots: LotSummary[] = Array.isArray(data) ? data : data.lots || [];
                const map = new Map<string, LotMapEntry>();
                lots.forEach((lot, i) => {
                    map.set(lot.guid, {
                        index: i + 1,
                        isClosed: lot.isClosed,
                        title: lot.title,
                        totalShares: lot.totalShares,
                        totalCost: lot.totalCost,
                        unrealizedGain: lot.unrealizedGain,
                        holdingPeriod: lot.holdingPeriod,
                    });
                });
                setLotMap(map);
            })
            .catch((err) => { console.error('Failed to refresh lot data:', err); });
    };

    const handleSplitLotAssign = async (splitGuid: string, lotGuid: string | null) => {
        await fetch(`/api/splits/${splitGuid}/lot`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lot_guid: lotGuid }),
        });
        suppressNextDataEvent('transactions');
        refreshLotMap();
    };

    const handleSplitCreateAndAssign = async (splitGuid: string, title: string) => {
        await fetch(`/api/splits/${splitGuid}/lot`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lot_guid: 'new', title }),
        });
        suppressNextDataEvent('transactions');
        refreshLotMap();
    };

    // Fetch per-account cost basis method preference
    useEffect(() => {
        if (!isInvestmentAccount) return;
        fetch(`/api/accounts/${accountGuid}/preferences`)
            .then(res => res.json())
            .then(data => setAccountCostBasisMethod(data.cost_basis_method))
            .catch(() => {});
    }, [isInvestmentAccount, accountGuid]);

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
    // Filtered results retain their true as-of balances, including hidden
    // account activity. Make that visible rather than implying adjacent rows
    // alone explain the balance change.
    const balancesIncludeAllActivity = debouncedSearch !== '' ||
        debouncedFilters.minAmount !== '' ||
        debouncedFilters.maxAmount !== '' ||
        debouncedFilters.reconcileStates.length > 0;

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

    // Fetch reconciled balance (sum of splits with reconcile_state = 'y') for reconciliation "Current" value
    useEffect(() => {
        fetch('/api/accounts/reconcile-summary')
            .then(res => res.ok ? res.json() : null)
            .then((data: Array<{ guid: string; reconciled_usd: string; reconciled_quantity?: string; is_investment?: boolean }> | null) => {
                if (!data) return;
                const summary = data.find(s => s.guid === accountGuid);
                if (summary) {
                    const raw = summary.is_investment && summary.reconciled_quantity != null
                        ? parseFloat(summary.reconciled_quantity)
                        : parseFloat(summary.reconciled_usd);
                    setReconciledBalance(raw || 0);
                }
            })
            .catch(() => {});
    }, [accountGuid, isReconciling]);

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


    const toggleTransactionSelection = useCallback((tx: AccountTransaction) => {
        setSelectedSplits(prev => toggleRowSelection(tx, prev));
    }, []);

    const selectAllUnreconciled = useCallback(() => {
        setSelectedSplits(selectAllRows(transactions));
    }, [transactions]);

    const clearSelection = useCallback(() => {
        setSelectedSplits(new Set());
    }, []);

    // Calculate the sum of selected splits for reconciliation
    const selectedBalance = useMemo(() => {
        return sumSelectedRows(transactions, selectedSplits);
    }, [transactions, selectedSplits]);

    const handleReconcileComplete = useCallback(() => {
        // The reconcile mutation just committed on this tab; drop the relayed
        // echo (the local state update below already reflects it).
        suppressNextDataEvent('transactions');
        // Refresh the transactions to show updated reconcile states
        setTransactions(prev => prev.map(tx => {
            const accountSplits = getRowAccountSplits(tx);
            if (!accountSplits.some(split => selectedSplits.has(split.guid))) return tx;
            const nextAccountSplits = accountSplits.map(split => (
                selectedSplits.has(split.guid) ? { ...split, reconcile_state: 'y' } : split
            ));
            const nextSplits = tx.splits?.map(split => (
                selectedSplits.has(split.guid) ? { ...split, reconcile_state: 'y' } : split
            ));
            return {
                ...tx,
                splits: nextSplits,
                account_splits: nextAccountSplits,
                account_split_reconcile_state:
                    nextAccountSplits.every(split => split.reconcile_state === 'y') ? 'y' : tx.account_split_reconcile_state,
            };
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
            if (!balancesIncludeAllActivity) {
                onCurrentBalanceChange?.(data[0]?.running_balance ?? null);
            }
        } catch (error) {
            console.error('Error fetching transactions:', error);
        }
    }, [accountGuid, balancesIncludeAllActivity, buildUrlParams, onCurrentBalanceChange]);

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
        setIsDeleting(true);

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
            // Optimistic-lock token: only delete the version we loaded
            const deletedTx = prevTransactions.find(t => t.guid === deletedGuid);
            const enterDateToken = deletedTx?.enter_date
                ? new Date(deletedTx.enter_date as unknown as string).toISOString()
                : null;
            const tokenParam = `?original_enter_date=${encodeURIComponent(enterDateToken ?? 'null')}`;
            const res = await fetch(`/api/transactions/${deletedGuid}${tokenParam}`, { method: 'DELETE' });
            if (res.status === 409) {
                error('This transaction was changed by someone else — reloading');
                await fetchTransactions();
                return;
            }
            if (!res.ok) throw new Error('Failed to delete');
            success('Transaction deleted successfully');
            // Refetch so running_balance column reflects the removed transaction
            suppressNextDataEvent('transactions');
            fetchTransactions();
        } catch (err) {
            console.error('Delete failed:', err);
            error('Failed to delete transaction');
            // Rollback on failure
            setTransactions(prevTransactions);
        } finally {
            setIsDeleting(false);
        }
    }, [deletingGuid, transactions, success, error, fetchTransactions]);

    // Inline edit save handler
    const handleInlineSave = useCallback(async (guid: string, data: {
        post_date: string;
        description: string;
        accountGuid: string;
        accountName: string;
        amount: string;
        original_enter_date?: string | null;
        splits?: Array<{ accountGuid: string; accountName: string; amount: number }>;
        /** Double-line edit: this account's split memo. Undefined = untouched. */
        memo?: string;
        /** Double-line edit: transaction-level notes. Undefined = untouched. */
        notes?: string;
    }) => {
        try {
            const tx = transactions.find(t => t.guid === guid);
            if (!tx) return;

            // Detect new (unsaved) transaction: no currency_guid means it was created inline
            const isNewTransaction = !tx.currency_guid;
            const currencyGuid = tx.currency_guid || accountCommodityGuid || '';

            const isMultiSplitSave = !!(data.splits && data.splits.length > 0);
            let bodySplits: Array<Record<string, unknown>>;

            // The inline row edits ONE dollar amount, but the PUT handler
            // deletes and recreates every split verbatim from this payload.
            // Anything not carried through here is destroyed.
            const originalSplits = tx.splits ?? [];
            const nonTradingSplits = originalSplits.filter(
                s => !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')
            );
            const ownSplit = nonTradingSplits.find(s => s.account_guid === accountGuid);
            const otherSplit = nonTradingSplits.find(s => s.account_guid !== accountGuid);

            const originalAmount = parseFloat(tx.account_split_value);
            const signedAmount = parseFloat(data.amount);
            const amountChanged = !Number.isFinite(originalAmount)
                || !Number.isFinite(signedAmount)
                || Math.abs(signedAmount - originalAmount) >= 0.005;
            const transferChanged = !!data.accountGuid
                && data.accountGuid !== (otherSplit?.account_guid ?? '');

            // Share counts and foreign-currency quantities cannot be derived
            // from the single dollar amount this row edits, so money changes on
            // such a transaction go to the full editor. Date/description edits
            // still save inline — they carry the stored fractions through below.
            if (
                !isNewTransaction
                && hasNonCurrencySplit(originalSplits)
                && (isMultiSplitSave || amountChanged || transferChanged)
            ) {
                setEditingGuid(null);
                handleEdit(guid);
                error('This transaction has share or multi-currency amounts — opening the full editor');
                return;
            }

            if (isMultiSplitSave) {
                // The suggestion replaces the whole split structure; a split that
                // lands on the same account with the same amount is the same
                // split. Each prior split may be claimed once — two suggestion
                // rows on one account must not be recreated with the same guid.
                const claimed = new Set<string>();
                bodySplits = data.splits!.map(s => {
                    const { num, denom } = toNumDenom(s.amount);
                    const prior = nonTradingSplits.find(
                        p => p.account_guid === s.accountGuid && !claimed.has(p.guid)
                    );
                    if (prior) claimed.add(prior.guid);
                    const priorAmount = prior ? Number(prior.value_num) / Number(prior.value_denom) : NaN;
                    const priorIntact = Boolean(prior) && Math.abs(priorAmount - s.amount) < 0.005;
                    return {
                        account_guid: s.accountGuid,
                        value_num: num,
                        value_denom: denom,
                        quantity_num: num,
                        quantity_denom: denom,
                        memo: prior?.memo ?? '',
                        reconcile_state: priorIntact ? (prior!.reconcile_state || 'n') : 'n',
                        ...(priorIntact ? { guid: prior!.guid } : {}),
                    };
                });
            } else {
                bodySplits = inlineTwoSplitPayload({
                    accountGuid,
                    ownSplit,
                    otherSplit,
                    transferAccountGuid: data.accountGuid,
                    signedAmount,
                    amountChanged,
                    transferChanged,
                    ownReconcileState: tx.account_split_reconcile_state,
                    ownMemo: data.memo,
                });
            }

            const body: Record<string, unknown> = {
                currency_guid: currencyGuid,
                // The PUT handler rewrites num from this body; carry the
                // stored value through so an inline save cannot wipe it.
                num: tx.num || '',
                post_date: data.post_date,
                description: data.description,
                splits: bodySplits,
            };
            if (data.notes !== undefined) body.notes = data.notes;

            let res: Response;
            if (isNewTransaction) {
                // POST to create new transaction
                res = await fetch('/api/transactions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            } else {
                // PUT to update existing transaction; original_enter_date is
                // mandatory (null = the row had no enter_date when loaded)
                body.original_enter_date = data.original_enter_date ?? null;

                res = await fetch(`/api/transactions/${guid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

                if (res.status === 409 || res.status === 428) {
                    error('This transaction was changed by someone else — reloading');
                    await fetchTransactions();
                    setEditingGuid(null);
                    return;
                }
            }

            if (!res.ok) await throwErrorBody(res, 'Failed to save');

            success(isNewTransaction ? 'Transaction created' : 'Transaction updated');
            suppressNextDataEvent('transactions');
            setLastEditedDate(data.post_date);
            if (isEditMode) {
                if (isNewTransaction || isMultiSplitSave) {
                    // Refetch to get the server-assigned guid and proper data,
                    // or to pick up the new multi-split structure
                    await fetchTransactions();
                } else {
                    // Optimistically update local state so the UI stays responsive
                    // and row order is preserved, then refetch in the background
                    // so the running_balance column reflects the new split amounts.
                    setTransactions(prev => prev.map(t => {
                        if (t.guid !== guid) return t;
                        const updatedSplits = t.splits?.map(s => {
                            if (s.account_guid === accountGuid) {
                                return data.memo !== undefined ? { ...s, memo: data.memo } : s;
                            }
                            return { ...s, account_guid: data.accountGuid, account_name: data.accountName, account_fullname: data.accountName };
                        });
                        return {
                            ...t,
                            post_date: new Date(data.post_date + 'T12:00:00Z') as unknown as Date,
                            description: data.description,
                            ...(data.notes !== undefined ? { notes: data.notes } : {}),
                            account_split_value: data.amount,
                            splits: updatedSplits,
                        };
                    }));
                    fetchTransactions();
                }
            } else {
                setEditingGuid(null);
                await fetchTransactions();
            }
        } catch (err) {
            console.error('Inline save failed:', err);
            error(err instanceof Error && err.message !== 'Failed to save' ? err.message : 'Failed to save transaction');
        }
    }, [transactions, accountGuid, accountCommodityGuid, fetchTransactions, success, error, isEditMode, handleEdit]);

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
        const isNewTransaction = !tx.currency_guid;
        const body: Record<string, unknown> = {
            currency_guid: txData.currency_guid || accountCommodityGuid || '',
            // Preserve the stored num — the PUT handler rewrites it from
            // this body and would otherwise blank it on every journal save.
            num: tx.num || '',
            post_date: txData.post_date,
            description: txData.description,
            splits: splitPayload,
        };
        if (txData.notes !== undefined) body.notes = txData.notes;

        try {
            let res: Response;
            if (isNewTransaction) {
                res = await fetch('/api/transactions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            } else {
                body.original_enter_date = tx.enter_date ? new Date(tx.enter_date as unknown as string).toISOString() : null;
                res = await fetch(`/api/transactions/${txGuid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

                if (res.status === 409 || res.status === 428) {
                    error('This transaction was changed by someone else — reloading');
                    await fetchTransactions();
                    return false;
                }
            }
            if (!res.ok) await throwErrorBody(res, 'Failed to save transaction');

            success(isNewTransaction ? 'Transaction created' : 'Transaction updated');
            suppressNextDataEvent('transactions');
            setLastEditedDate(txData.post_date);
            await fetchTransactions();
            return true;
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save transaction');
            return false;
        }
    }, [transactions, accountCommodityGuid, fetchTransactions, success, error]);

    // Investment inline edit save handler
    const handleInvestmentInlineSave = useCallback(async (guid: string, data: InvestmentSaveData) => {
        try {
            const tx = transactions.find(t => t.guid === guid);
            if (!tx) return;

            const shares = parseFloat(data.shares);
            const total = parseFloat(data.total);
            const stockQtyDenom = commodityScu && commodityScu > 0 ? commodityScu : 10000;
            const isNewTransaction = !tx.currency_guid;
            const currencyGuid = tx.currency_guid || investmentCurrencyGuid;

            if (!currencyGuid) {
                throw new Error('Transaction currency is unavailable. Refresh the ledger and try again.');
            }

            if (!data.isBuy) {
                const originalStockSplit = tx.splits?.find(split => split.account_guid === accountGuid);
                const originalQuantity = originalStockSplit
                    ? Number(originalStockSplit.quantity_num) / Number(originalStockSplit.quantity_denom)
                    : 0;
                const editableAvailable = Math.max(
                    0,
                    investmentCurrentShares + (!isNewTransaction && originalQuantity < 0 ? Math.abs(originalQuantity) : 0),
                );
                if (shares > editableAvailable + (0.5 / stockQtyDenom)) {
                    throw new Error(
                        `Cannot sell ${shares.toFixed(sharePrecision)} shares; `
                        + `${editableAvailable.toFixed(sharePrecision)} are available`,
                    );
                }
            }

            // GnuCash sign convention for the stock account split (matches
            // GnuCash desktop). The stock account is debited on a buy and
            // credited on a sell, so its value follows accounting signs:
            //   Buy:  positive quantity (shares in), positive value (debit)
            //   Sell: negative quantity (shares out), negative value (credit)
            // The other side (cash, income, etc.) gets the opposite sign.
            const stockQuantity = data.isBuy ? shares : -shares;
            const stockValue = data.isBuy ? total : -total;

            // Transfer split is the opposite of stock value
            const transferValue = -stockValue;

            const { num: stockValueNum, denom: stockValueDenom } = toNumDenom(stockValue);
            const stockQtyNum = Math.round(stockQuantity * stockQtyDenom);
            const { num: transferValueNum, denom: transferValueDenom } = toNumDenom(transferValue);

            const body: Record<string, unknown> = {
                currency_guid: currencyGuid,
                post_date: data.post_date,
                description: data.description,
                splits: [
                    {
                        account_guid: accountGuid,
                        action: data.isBuy ? 'Buy' : 'Sell',
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

            let res: Response;
            if (isNewTransaction) {
                res = await fetch('/api/transactions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            } else {
                body.original_enter_date = data.original_enter_date ?? null;

                res = await fetch(`/api/transactions/${guid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

                if (res.status === 409 || res.status === 428) {
                    error('This transaction was changed by someone else — reloading');
                    await fetchTransactions();
                    return;
                }
            }

            if (!res.ok) await throwErrorBody(res, 'Failed to save');

            success(isNewTransaction ? 'Transaction created' : 'Transaction updated');
            suppressNextDataEvent('transactions');
            setLastEditedDate(data.post_date);
            await fetchTransactions();
        } catch (err) {
            console.error('Investment inline save failed:', err);
            error(err instanceof Error && err.message !== 'Failed to update' ? err.message : 'Failed to update transaction');
            throw err; // Re-throw so InvestmentEditRow knows save failed
        }
    }, [
        transactions,
        accountGuid,
        commodityScu,
        investmentCurrencyGuid,
        investmentCurrentShares,
        sharePrecision,
        fetchTransactions,
        success,
        error,
    ]);

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
            // Keep the account hierarchy's "to review" badges in sync
            queryClient.invalidateQueries({ queryKey: ['accounts', 'review-status'] });
        } catch (err) {
            console.error('Failed to toggle reviewed:', err);
            error('Failed to toggle reviewed status');
        }
    }, [error, queryClient]);

    // Jump to the "other" account of a transaction (GnuCash-style Jump).
    // For a 2-split (or single counter-account) transaction, navigate straight
    // to that account's ledger. For a multi-split transaction with several
    // distinct counter-accounts there is no single target, so expand the row
    // to reveal the per-line jump buttons and let the user pick a line.
    const jumpToOtherAccount = useCallback((tx: AccountTransaction) => {
        const others = (tx.splits || []).filter(s =>
            s.account_guid &&
            s.account_guid !== accountGuid &&
            !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:'));
        const distinct = Array.from(new Map(others.map(s => [s.account_guid, s])).values());
        if (distinct.length === 1) {
            router.push(`/accounts/${distinct[0].account_guid}`);
        } else if (distinct.length > 1) {
            setExpandedTxs(prev => ({ ...prev, [tx.guid]: true }));
            setExpandedTransactions(prev => new Set(prev).add(tx.guid));
        }
    }, [accountGuid, router]);

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

        const toNum = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
        const splits = nonTradingSplits.map((s, i) => {
            const vn = toNum(s.value_num, 0);
            const vd = toNum(s.value_denom, 100);
            return {
                guid: splitGuids[i],
                account_guid: s.account_guid,
                value_num: vn,
                value_denom: vd,
                quantity_num: toNum(s.quantity_num, vn),
                quantity_denom: toNum(s.quantity_denom, vd),
                memo: s.memo || '',
                action: s.action || '',
                reconcile_state: 'n' as const,
            };
        });

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

            if (!res.ok) await throwErrorBody(res, 'Failed to duplicate');

            success('Transaction duplicated');
            // Refetch so running_balance column reflects the new transaction.
            // In edit mode this also corrects any balance drift from the optimistic
            // insert above.
            suppressNextDataEvent('transactions');
            fetchTransactions();
        } catch (err) {
            console.error('Duplicate failed:', err);
            error(err instanceof Error ? err.message : 'Failed to duplicate transaction');
            // Rollback on failure
            setTransactions(prevTransactions);
        }
    }, [transactions, fetchTransactions, success, error, accountGuid]);

    const openContextMenu = useCallback((event: React.MouseEvent, tx: AccountTransaction) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY, tx });
    }, []);

    const copyTransactionGuid = useCallback(async (guid: string) => {
        try {
            await navigator.clipboard.writeText(guid);
            success('Transaction ID copied');
        } catch {
            error('Failed to copy transaction ID');
        }
    }, [success, error]);

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
        // Keep the account hierarchy's "to review" badges in sync
        queryClient.invalidateQueries({ queryKey: ['accounts', 'review-status'] });
        await fetchTransactions();
    }, [editSelectedGuids, fetchTransactions, queryClient]);

    // Bulk delete handler
    const handleBulkDelete = useCallback(async () => {
        const guids = Array.from(editSelectedGuids);
        let deleted = 0;
        let conflicts = 0;
        for (const guid of guids) {
            const tx = transactions.find(t => t.guid === guid);
            const enterDateToken = tx?.enter_date
                ? new Date(tx.enter_date as unknown as string).toISOString()
                : null;
            const tokenParam = `?original_enter_date=${encodeURIComponent(enterDateToken ?? 'null')}`;
            const res = await fetch(`/api/transactions/${guid}${tokenParam}`, { method: 'DELETE' });
            if (res.status === 409) {
                conflicts++;
            } else if (res.ok) {
                deleted++;
            }
        }
        setEditSelectedGuids(new Set());
        setBulkDeleteConfirmOpen(false);
        if (deleted > 0) suppressNextDataEvent('transactions');
        await fetchTransactions();
        if (conflicts > 0) {
            error(`${conflicts} transaction${conflicts !== 1 ? 's were' : ' was'} changed by someone else and not deleted — list reloaded`);
        }
        if (deleted > 0) {
            success(`Deleted ${deleted} transaction${deleted !== 1 ? 's' : ''}`);
        }
    }, [editSelectedGuids, transactions, fetchTransactions, success, error]);

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

            if (!res.ok) await throwErrorBody(res, 'Failed to move splits');

            const data = await res.json();
            setEditSelectedGuids(new Set());
            suppressNextDataEvent('transactions');
            await invalidateTransactionAccountCaches(queryClient);
            await fetchTransactions();
            success(`Moved ${data.updated} split${data.updated !== 1 ? 's' : ''} to ${targetAccountName}`);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to move splits');
        }
    }, [transactions, editSelectedGuids, accountGuid, fetchTransactions, success, error, queryClient]);

    // Shared bulk-edit runner: PATCH /api/transactions/bulk with the ledger
    // account as the anchor (its split is never the one recategorized).
    const runBulkEdit = useCallback(async (set: Record<string, unknown>, label: string) => {
        const transactionGuids = Array.from(editSelectedGuids);
        if (transactionGuids.length === 0) return;
        try {
            const res = await fetch('/api/transactions/bulk', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactionGuids, anchorAccountGuid: accountGuid, set }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `${label} failed`);
            setEditSelectedGuids(new Set());
            suppressNextDataEvent('transactions');
            await fetchTransactions();
            const skipped: { error?: string }[] = (data.results ?? []).filter((r: { ok: boolean }) => !r.ok);
            if (skipped.length > 0) {
                error(`${label}: ${data.updated} updated, ${skipped.length} skipped (${skipped[0].error ?? 'see server log'})`);
            } else {
                success(`${label}: ${data.updated} transaction${data.updated !== 1 ? 's' : ''} updated`);
            }
        } catch (err) {
            error(err instanceof Error ? err.message : `${label} failed`);
        }
    }, [editSelectedGuids, accountGuid, fetchTransactions, success, error]);

    const handleBulkDescription = useCallback(async (payload: BulkDescriptionPayload) => {
        await runBulkEdit({ ...payload }, 'Description update');
    }, [runBulkEdit]);

    const handleBulkRecategorize = useCallback(async (targetAccountGuid: string, targetAccountName: string) => {
        await runBulkEdit({ recategorize: { toAccountGuid: targetAccountGuid } }, `Recategorize to ${targetAccountName}`);
    }, [runBulkEdit]);

    const handleBulkTags = useCallback(async (addTagIds: number[], removeTagIds: number[]) => {
        await runBulkEdit({ addTagIds, removeTagIds }, 'Tag update');
    }, [runBulkEdit]);

    // Open TransactionFormModal directly for edit mode edit button
    const handleEditDirect = useCallback((guid: string) => {
        const tx = transactions.find(t => t.guid === guid);
        setEditingTransaction(tx || null);
        setIsEditModalOpen(true);
    }, [transactions]);

    // Tag editor state
    const [tagEditorGuid, setTagEditorGuid] = useState<string | null>(null);

    const handleTagsSaved = useCallback((guid: string, tags: Tag[]) => {
        setTransactions(prev => prev.map(tx => (tx.guid === guid ? { ...tx, tags } : tx)));
    }, []);

    const contextMenuItems = useMemo<TransactionContextMenuItem[]>(() => {
        if (!contextMenu) return [];
        const guid = contextMenu.tx.guid;
        // Counter-accounts for GnuCash-style "Jump" (same filter as jumpToOtherAccount):
        // skip the current account and Trading accounts, dedupe, cap the list.
        const jumpTargets = Array.from(new Map(
            (contextMenu.tx.splits || [])
                .filter(s =>
                    s.account_guid &&
                    s.account_guid !== accountGuid &&
                    !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:'))
                .map(s => [s.account_guid, s])
        ).values()).slice(0, 6);
        return [
            {
                id: 'view',
                label: 'View details',
                onSelect: () => {
                    setSelectedTxGuid(guid);
                    setIsViewModalOpen(true);
                },
            },
            {
                id: 'edit',
                label: 'Edit',
                onSelect: () => handleEditDirect(guid),
            },
            ...(contextMenu.tx.reviewed === false ? [{
                id: 'review',
                label: 'Mark reviewed',
                onSelect: () => { void toggleReviewed(guid); },
            }] : []),
            {
                id: 'duplicate',
                label: 'Duplicate',
                onSelect: () => { void handleDuplicate(guid); },
            },
            {
                id: 'schedule',
                label: 'Create schedule from this…',
                onSelect: () => router.push(`/scheduled-transactions?fromTransaction=${guid}`),
            },
            {
                id: 'tags',
                label: 'Tags…',
                onSelect: () => setTagEditorGuid(guid),
            },
            ...jumpTargets.map(split => ({
                id: `jump-${split.account_guid}`,
                label: `Jump to ${split.account_name || split.account_fullname || 'account'}`,
                onSelect: () => router.push(`/accounts/${split.account_guid}`),
            })),
            {
                id: 'copy-id',
                label: 'Copy transaction ID',
                onSelect: () => { void copyTransactionGuid(guid); },
            },
            {
                id: 'delete',
                label: 'Delete',
                variant: 'danger',
                onSelect: () => handleDeleteClick(guid),
            },
        ];
    }, [accountGuid, contextMenu, copyTransactionGuid, handleDeleteClick, handleDuplicate, handleEditDirect, router, toggleReviewed]);

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

    const visibleColumnIds = useMemo(
        () => table.getVisibleFlatColumns().map(c => c.id),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [columns],
    );

    // Helper to create a blank new transaction at the top of the list
    const createNewTransaction = useCallback(() => {
        const today = lastEditedDate || toLocalDateString(new Date());
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
    }, [accountGuid, lastEditedDate]);

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
                if (e.key === 'n' && e.altKey) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (focusedRowIndex >= 0) {
                        const currentTx = displayTransactions[focusedRowIndex];
                        const handle = editableRowRefs.current.get(currentTx.guid);
                        if (handle?.isDirty()) await handle.save();
                    }
                    createNewTransaction();
                    if (isSlimEditMode) setFocusedSplitIndex(-1);
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
                            // Past last split -> save and move to first split of next transaction (keep column)
                            const saved = tx ? await handleJournalSave(tx.guid) : true;
                            if (saved) {
                                setFocusedSplitIndex(0);
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
                            const saved = currentTx ? await handleJournalSave(currentTx.guid) : true;
                            if (saved) {
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
                        if (currentTx) {
                            const saved = await handleJournalSave(currentTx.guid);
                            if (!saved) break;
                        }
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

        // In slim edit mode (journal/autosplit), arrow keys are handled by
        // the isSlimEditMode block above or by component-level handlers (InvestmentEditRow)
        if (isEditMode && !isSlimEditMode) {
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
                    return;
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
                    return;
                }
            }
        }

        if (isEditMode) {
            switch (e.key) {
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
            case 'o':
                if (focusedRowIndex >= 0 && focusedRowIndex < displayTransactions.length) {
                    e.preventDefault();
                    jumpToOtherAccount(displayTransactions[focusedRowIndex]);
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
    }, [editingGuid, isEditModalOpen, isViewModalOpen, deleteConfirmOpen, showMoveDialog, imbalanceDialogTx, focusedRowIndex, focusedSplitIndex, displayTransactions, isEditMode, isSlimEditMode, handleRowClick, handleEditDirect, handleJournalSave, handleDuplicate, handleDeleteClick, createNewTransaction, toggleReviewed, jumpToOtherAccount, handleBulkReview, onEscape, searchText, hasChildren, ledgerViewStyle, expandedTransactions, editSelectedGuids]);

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

    // Reset when initialTransactions change (e.g., date filter changed or book switched)
    useEffect(() => {
        // Deduplicate by guid to prevent double-render artifacts
        const seen = new Set<string>();
        const deduped = initialTransactions.filter(tx => {
            if (seen.has(tx.guid)) return false;
            seen.add(tx.guid);
            return true;
        });
        setTransactions(deduped);
        setOffset(deduped.length);
        setHasMore(deduped.length >= 100);
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

    // Cross-user freshness: refetch when another session mutates transactions
    // in this book (relayed by DataEventsProvider as a `gnucash:data-change`
    // window CustomEvent). Guarded so a refetch never clobbers an in-progress
    // inline edit, modal edit, delete, or reconcile session.
    const dataChangeRef = useRef<{ blocked: boolean; fetch: () => Promise<void> }>({
        blocked: false,
        fetch: async () => {},
    });
    useEffect(() => {
        dataChangeRef.current = {
            blocked:
                editingGuid !== null ||
                isEditModalOpen ||
                editingTransaction !== null ||
                deleteConfirmOpen ||
                isDeleting ||
                isReconciling,
            fetch: fetchTransactions,
        };
    });
    useEffect(() => {
        const onDataChange = (e: Event) => {
            // Defense-in-depth: DataEventsProvider defers events for hidden
            // tabs, but any directly-dispatched event should not refetch a
            // background tab either.
            if (document.visibilityState !== 'visible') return;
            const detail = (e as CustomEvent).detail as { entity?: string } | undefined;
            if (detail?.entity !== 'transactions') return;
            if (dataChangeRef.current.blocked) return;
            void dataChangeRef.current.fetch();
        };
        window.addEventListener('gnucash:data-change', onDataChange);
        return () => window.removeEventListener('gnucash:data-change', onDataChange);
    }, []);

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
                setTransactions(prev => {
                    const existingGuids = new Set(prev.map(tx => tx.guid));
                    const newTxs = data.filter((tx: AccountTransaction) => !existingGuids.has(tx.guid));
                    return newTxs.length > 0 ? [...prev, ...newTxs] : prev;
                });
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
            case 'y': return { icon: 'Y', color: 'text-primary bg-primary/10', label: 'Reconciled' };
            case 'c': return { icon: 'C', color: 'text-warning bg-warning/10', label: 'Cleared' };
            default: return { icon: 'N', color: 'text-foreground-muted bg-surface/10', label: 'Not Reconciled' };
        }
    };

    // Shared toolbar elements (rendered inline on desktop, inside FilterBar on mobile)
    const filterControls = (
        <>
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
        </>
    );

    const searchBox = (
        <div className="relative flex-1 min-w-0">
            <input
                ref={searchInputRef}
                type="text"
                placeholder="Search or #tag... (press / to focus)"
                className="w-full bg-input-bg border border-border rounded-xl px-4 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 transition-all pl-10"
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
    );

    const currentCostBasisMethod = accountCostBasisMethod || costBasisMethod;
    const costBasisSelect = isInvestmentAccount ? (
        <select
            value={currentCostBasisMethod}
            onChange={async (e) => {
                const method = e.target.value;
                setAccountCostBasisMethod(method);
                try {
                    await fetch(`/api/accounts/${accountGuid}/preferences`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cost_basis_method: method }),
                    });
                } catch {}
            }}
            className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border bg-background-secondary text-foreground hover:text-foreground transition-colors"
            title="Cost basis method for this account"
        >
            <option value="fifo">FIFO</option>
            <option value="lifo">LIFO</option>
            <option value="average">Average</option>
        </select>
    ) : null;

    // Filter badge count on mobile includes the view toggles that act as filters
    const mobileFilterCount = activeFilterCount
        + (showUnreviewedOnly ? 1 : 0)
        + (hasChildren && showSubaccounts ? 1 : 0);

    // Overflow actions on mobile (edit mode is desktop-only)
    const mobileActions: ActionMenuItem[] = [
        ...(!isReconciling ? [{
            label: 'Reconcile',
            onSelect: () => { setIsEditMode(false); setIsReconciling(true); },
        }] : []),
        ...(isInvestmentAccount ? [{
            label: showLotsView ? 'Hide Lots' : 'Show Lots',
            onSelect: () => setShowLotsView(!showLotsView),
        }] : []),
        { label: `${ledgerViewStyle === 'basic' ? '●' : '○'} Basic Ledger`, onSelect: () => setLedgerViewStyle('basic') },
        { label: `${ledgerViewStyle === 'journal' ? '●' : '○'} Transaction Journal`, onSelect: () => setLedgerViewStyle('journal') },
        { label: `${ledgerViewStyle === 'autosplit' ? '●' : '○'} Auto-Split`, onSelect: () => setLedgerViewStyle('autosplit') },
    ];

    return (
        <>
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl overflow-clip shadow-2xl">
            {/* Top Bar: mobile = search + Filters + overflow menu; desktop = inline toolbar */}
            <div className="p-4 border-b border-border flex flex-col md:flex-row gap-3">
                {isMobile ? (
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                        <FilterBar
                            className="flex-1 min-w-0"
                            activeCount={mobileFilterCount}
                            primary={searchBox}
                        >
                            {filterControls}
                            {hasChildren && (
                                <button
                                    onClick={() => setShowSubaccounts(prev => !prev)}
                                    className={`flex items-center gap-2 px-3 py-2 min-h-[44px] text-sm rounded-lg border text-left transition-colors ${
                                        showSubaccounts
                                            ? 'bg-primary/10 border-primary/30 text-primary'
                                            : 'border-border text-foreground-secondary'
                                    }`}
                                >
                                    <span>{showSubaccounts ? '☑' : '☐'}</span>
                                    Sub-Accounts
                                </button>
                            )}
                            <button
                                onClick={() => setShowUnreviewedOnly(prev => !prev)}
                                className={`flex items-center gap-2 px-3 py-2 min-h-[44px] text-sm rounded-lg border text-left transition-colors ${
                                    showUnreviewedOnly
                                        ? 'bg-primary/10 border-primary/30 text-primary'
                                        : 'border-border text-foreground-secondary'
                                }`}
                            >
                                <span>{showUnreviewedOnly ? '☑' : '☐'}</span>
                                Unreviewed Only
                            </button>
                            {isInvestmentAccount && (
                                <div className="[&>select]:w-full">
                                    <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                                        Cost Basis Method
                                    </label>
                                    {costBasisSelect}
                                    <p className="mt-1.5 text-[11px] text-foreground-muted">
                                        <Abbr term="FIFO" /> sells the oldest shares first; <Abbr term="LIFO" /> the newest.
                                    </p>
                                </div>
                            )}
                            {activeFilterCount > 0 && (
                                <button
                                    onClick={clearAllFilters}
                                    className="min-h-[44px] text-sm text-foreground-secondary hover:text-negative transition-colors"
                                >
                                    Clear all filters
                                </button>
                            )}
                        </FilterBar>
                        <button
                            onClick={() => {
                                setEditingTransaction(null);
                                setIsEditModalOpen(true);
                            }}
                            disabled={isReadonly}
                            title={isReadonly ? READONLY_TOOLTIP : 'New Transaction'}
                            aria-label="New Transaction"
                            className="flex items-center justify-center w-9 h-9 shrink-0 rounded-lg border border-border bg-surface/50 text-foreground-secondary text-lg hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            +
                        </button>
                        <ActionMenu items={mobileActions} />
                    </div>
                ) : (
                <>
                {/* Filters and Search */}
                <div className="flex gap-2 items-center flex-1 min-w-0">
                    <FilterPanel
                        activeFilterCount={activeFilterCount}
                        onClearAll={clearAllFilters}
                    >
                        {filterControls}
                    </FilterPanel>
                    {searchBox}
                </div>

                {/* Action buttons - right aligned */}
                <div className="flex flex-wrap gap-2 items-center md:justify-end">
                    <button
                        onClick={() => {
                            setEditingTransaction(null);
                            setIsEditModalOpen(true);
                        }}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : (isEditMode ? 'New Transaction (n)' : 'New Transaction')}
                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors font-medium flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-foreground-muted"
                    >
                        New Transaction
                    </button>
                    <ViewMenu
                        showSubaccounts={showSubaccounts}
                        onToggleSubaccounts={() => setShowSubaccounts(prev => !prev)}
                        showUnreviewedOnly={showUnreviewedOnly}
                        onToggleUnreviewed={() => setShowUnreviewedOnly(prev => !prev)}
                        hasSubaccounts={hasChildren}
                        doubleLine={doubleLineEdit}
                        onToggleDoubleLine={toggleDoubleLineEdit}
                    />
                    {isInvestmentAccount && (
                        <button
                            onClick={() => setShowLotsView(!showLotsView)}
                            className={`px-3 py-2 min-h-[44px] text-xs rounded-lg border transition-colors ${
                                showLotsView
                                    ? 'bg-secondary/10 border-secondary/30 text-secondary'
                                    : 'border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover'
                            }`}
                        >
                            Lots
                        </button>
                    )}
                    {costBasisSelect && (
                        <span className="inline-flex items-center gap-1">
                            {costBasisSelect}
                            {(currentCostBasisMethod === 'fifo' || currentCostBasisMethod === 'lifo') && (
                                <Abbr term={currentCostBasisMethod === 'fifo' ? 'FIFO' : 'LIFO'}>
                                    <span className="sr-only">
                                        {currentCostBasisMethod === 'fifo' ? 'FIFO' : 'LIFO'}
                                    </span>
                                </Abbr>
                            )}
                        </span>
                    )}
                    <button
                        onClick={handleToggleEditMode}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className={`hidden md:inline-flex px-3 py-2 min-h-[44px] items-center text-xs rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            isEditMode
                                ? 'bg-primary/10 border-primary/30 text-primary'
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
                                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-secondary hover:border-secondary/30 hover:bg-secondary/10 transition-colors flex items-center"
                                    >
                                        Move to Account ({editSelectedGuids.size})
                                    </button>
                                    <button
                                        onClick={() => setBulkDeleteConfirmOpen(true)}
                                        title="Delete Selected (x)"
                                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-negative hover:border-negative/30 hover:bg-negative/10 transition-colors flex items-center"
                                    >
                                        Delete Selected ({editSelectedGuids.size})
                                    </button>
                                    <button
                                        onClick={() => setBulkDescOpen(true)}
                                        title="Edit description of selected transactions"
                                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex items-center"
                                    >
                                        Edit Description ({editSelectedGuids.size})
                                    </button>
                                    <button
                                        onClick={() => setBulkRecatOpen(true)}
                                        title="Recategorize the counter-split of selected transactions"
                                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-positive hover:border-positive/30 hover:bg-positive/10 transition-colors flex items-center"
                                    >
                                        Recategorize ({editSelectedGuids.size})
                                    </button>
                                    <button
                                        onClick={() => setBulkTagsOpen(true)}
                                        title="Add or remove tags on selected transactions"
                                        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex items-center"
                                    >
                                        Tags ({editSelectedGuids.size})
                                    </button>
                                </>
                            )}
                        </div>
                    )}
                    {/* Reconcile button in toolbar; panel floats separately */}
                    {!isReconciling && (
                        <ReconciliationPanel
                            accountGuid={accountGuid}
                            commodityScu={commodityScu}
                            accountCurrency={accountCurrency}
                            isInvestment={isInvestmentAccount}
                            sharePrecision={sharePrecision}
                            currentBalance={reconciledBalance}
                            selectedBalance={selectedBalance}
                            onReconcileComplete={handleReconcileComplete}
                            selectedSplits={selectedSplits}
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
                </>
                )}
            </div>

            {showLotsView && isInvestmentAccount ? (
                <LotViewer accountGuid={accountGuid} currencyMnemonic={accountCurrency} sharePrecision={sharePrecision} />
            ) : isMobile && isEditMode ? (
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
                            <SwipeableTransactionCard
                                key={tx.guid}
                                disabled={!isUnreviewed}
                                onCommit={() => toggleReviewed(tx.guid)}
                            >
                                <div className={`bg-surface/30 backdrop-blur p-3 space-y-2 border-b border-border/30 sm:border sm:border-border sm:rounded-xl ${isUnreviewed ? 'border-l-2 border-l-warning' : ''}`} onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}>
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <div className="text-xs text-foreground-muted">
                                                {new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                                            </div>
                                            <div className="text-sm font-medium flex items-center gap-2">
                                                <TransactionTypeIcon type={invRow.transactionType} className="mr-0.5" />
                                                {tx.description}
                                                {tx.source && tx.source !== 'manual' && tx.match_type !== 'manual_reconciliation' && (
                                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-warning/10 text-warning border border-warning/20 uppercase tracking-wider font-bold">Imported</span>
                                                )}
                                                {tx.match_type === 'manual_reconciliation' && (
                                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wider font-bold">Bank-verified</span>
                                                )}
                                                {(() => {
                                                    const mLotSplit = tx.splits?.find(s => s.lot_guid && s.account_guid === accountGuid);
                                                    const mAccountSplit = tx.splits?.find(s => s.account_guid === accountGuid);
                                                    const mLotInfo = mLotSplit?.lot_guid ? lotMap.get(mLotSplit.lot_guid) : null;
                                                    return (
                                                        <>
                                                            {mLotInfo && mLotSplit?.lot_guid && (
                                                                <LotBadge
                                                                    lotGuid={mLotSplit.lot_guid}
                                                                    lotIndex={mLotInfo.index}
                                                                    isClosed={mLotInfo.isClosed}
                                                                    sharePrecision={sharePrecision}
                                                                    tooltip={{
                                                                        title: mLotInfo.title,
                                                                        shares: mLotInfo.totalShares,
                                                                        costBasis: mLotInfo.totalCost,
                                                                        unrealizedGain: mLotInfo.unrealizedGain,
                                                                        holdingPeriod: mLotInfo.holdingPeriod,
                                                                        currencyMnemonic: accountCurrency,
                                                                    }}
                                                                />
                                                            )}
                                                            <LotAssignmentPopover
                                                                splitGuid={mLotSplit?.guid || mAccountSplit?.guid || ''}
                                                                currentLotGuid={mLotSplit?.lot_guid || null}
                                                                lots={Array.from(lotMap.entries()).map(([guid, info]) => ({
                                                                    guid,
                                                                    title: info.title,
                                                                    totalShares: info.totalShares,
                                                                    isClosed: info.isClosed,
                                                                }))}
                                                                onAssign={handleSplitLotAssign}
                                                                onCreateAndAssign={handleSplitCreateAndAssign}
                                                            />
                                                        </>
                                                    );
                                                })()}
                                            </div>
                                            <div className="text-xs text-foreground-muted">{invRow.transferAccount}</div>
                                        </div>
                                        <div className="text-right">
                                            {invRow.shares !== null && (
                                                <div className={`text-sm font-mono ${invRow.shares > 0 ? 'text-positive' : 'text-negative'}`}>
                                                    {invRow.shares > 0 ? '+' : ''}{invRow.shares.toFixed(sharePrecision)} shares
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
                                            <span className="text-positive">Buy: {formatCurrency(invRow.buyAmount, invRow.currencyMnemonic)}</span>
                                        )}
                                        {invRow.sellAmount !== null && (
                                            <span className="text-negative">Sell: {formatCurrency(invRow.sellAmount, invRow.currencyMnemonic)}</span>
                                        )}
                                        {invRow.transactionType === 'dividend' && (
                                            <span className="text-foreground-muted">Dividend</span>
                                        )}
                                        {invRow.transactionType === 'stock_split' && (
                                            <span className="text-secondary">Stock Split</span>
                                        )}
                                        {invRow.transactionType === 'reinvested_dividend' && (
                                            <span className="text-primary"><Abbr term="DRIP" /></span>
                                        )}
                                        {invRow.transactionType === 'return_of_capital' && (
                                            <span className="text-warning">Return of Capital</span>
                                        )}
                                        {invRow.transactionType === 'realized_gain' && invRow.gainAmount !== null && (
                                            <span className={invRow.gainAmount >= 0 ? 'text-positive' : 'text-negative'}>
                                                Realized {invRow.gainAmount >= 0 ? 'Gain' : 'Loss'}: {formatCurrency(Math.abs(invRow.gainAmount), invRow.currencyMnemonic)}
                                            </span>
                                        )}
                                        <span>Bal: {invRow.shareBalance.toFixed(sharePrecision)}</span>
                                        <span>Cost: {formatCurrency(invRow.costBasis, invRow.currencyMnemonic)}</span>
                                    </div>
                                </div>
                            </SwipeableTransactionCard>
                        ) : (
                            <SwipeableTransactionCard
                                key={tx.guid}
                                disabled={!isUnreviewed}
                                onCommit={() => toggleReviewed(tx.guid)}
                            >
                                <MobileCard
                                    onClick={() => { setSelectedTxGuid(tx.guid); setIsViewModalOpen(true); }}
                                    className={isUnreviewed ? 'border-l-2 border-l-warning' : ''}
                                    fields={[
                                        { label: 'Date', value: new Date(tx.post_date).toLocaleDateString('en-US', { timeZone: 'UTC' }) },
                                        { label: 'Description', value: <span className="font-medium flex items-center gap-2">{tx.description}{tx.source && tx.source !== 'manual' && tx.match_type !== 'manual_reconciliation' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-warning/10 text-warning border border-warning/20 uppercase tracking-wider font-bold">Imported</span>}{tx.match_type === 'manual_reconciliation' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wider font-bold">Bank-verified</span>}</span> },
                                        { label: 'Transfer', value: transferName },
                                        ...(amount >= 0
                                            ? [{ label: 'Debit', value: <span className="text-primary font-mono">{formatCurrency(amount, tx.commodity_mnemonic)}</span> }]
                                            : [{ label: 'Credit', value: <span className="text-negative font-mono">{formatCurrency(Math.abs(amount), tx.commodity_mnemonic)}</span> }]
                                        ),
                                        { label: balancesIncludeAllActivity ? 'Balance (all activity)' : 'Balance', value: balanceValue !== null
                                            ? <span className={`font-mono font-bold ${balanceValue < 0 ? 'text-negative' : 'text-positive'}`}>{formatCurrency(balanceValue, tx.commodity_mnemonic)}</span>
                                            : <span className="text-foreground-muted">{'\u2014'}</span>
                                        },
                                        { label: 'Reconcile', value: <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${reconcileInfo.color}`}>{reconcileInfo.icon}</span> },
                                    ]}
                                />
                            </SwipeableTransactionCard>
                        );
                    })}
                    <div ref={loader} className="p-8 flex justify-center border-t border-border/50">
                        {loading ? (
                            <div className="flex items-center gap-3">
                                <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
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
                                                    className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-primary cursor-pointer"
                                                />
                                            )}
                                            {isReconciling && (
                                                <input
                                                    type="checkbox"
                                                    checked={selectedSplits.size > 0 && displayTransactions.every(tx => getSelectableRowSplits(tx).length === 0 || isRowSelected(tx, selectedSplits))}
                                                    onChange={(e) => {
                                                        if (e.target.checked) selectAllUnreconciled();
                                                        else clearSelection();
                                                    }}
                                                    tabIndex={-1}
                                                    title="Select all unreconciled"
                                                    className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-primary cursor-pointer"
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
                                    if (colId === 'balance') return <th key={header.id} className="px-4 py-2 text-right">{balancesIncludeAllActivity ? <>Balance (all activity)<span className="sr-only">. Balances include transactions hidden by the active filters.</span></> : 'Balance'}</th>;
                                    if (colId === 'shares') return <th key={header.id} className="px-4 py-2 text-right">Shares</th>;
                                    if (colId === 'price') return <th key={header.id} className="px-4 py-2 text-right">Price</th>;
                                    if (colId === 'buy') return <th key={header.id} className="px-4 py-2 text-right">Buy</th>;
                                    if (colId === 'sell') return <th key={header.id} className="px-4 py-2 text-right">Sell</th>;
                                    if (colId === 'shareBalance') return <th key={header.id} className="px-4 py-2 text-right">Share Bal</th>;
                                    if (colId === 'costBasis') return <th key={header.id} className="px-4 py-2 text-right">Cost Basis</th>;
                                    if (colId === 'receipt') return <th key={header.id} className="px-2 py-2 w-10"></th>;
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
                                    <React.Fragment key={tx.guid}>
                                        <InvestmentEditRow
                                            ref={(handle) => {
                                                if (handle) editableRowRefs.current.set(tx.guid, handle);
                                                else editableRowRefs.current.delete(tx.guid);
                                            }}
                                            transaction={tx}
                                            accountGuid={accountGuid}
                                            sharePrecision={sharePrecision}
                                            availableShares={investmentAvailableSharesFor(tx)}
                                            isActive={index === focusedRowIndex}
                                            showCheckbox={true}
                                            isChecked={editSelectedGuids.has(tx.guid)}
                                            onToggleCheck={(e) => handleEditCheckToggle(index, tx.guid, (e as unknown as MouseEvent)?.shiftKey || false)}
                                            onSave={handleInvestmentInlineSave}
                                            onEditModal={handleEditDirect}
                                            onDuplicate={handleDuplicate}
                                            columnCount={table.getVisibleFlatColumns().length}
                                            columnIds={visibleColumnIds}
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
                                                if (ledgerViewStyle === 'journal' || ledgerViewStyle === 'autosplit') {
                                                    setFocusedSplitIndex(0);
                                                    setFocusedColumnIndex(0);
                                                } else {
                                                    const handle = editableRowRefs.current.get(tx.guid);
                                                    if (handle?.isDirty()) await handle.save();
                                                    setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                }
                                            }}
                                            onColumnFocus={(col) => setFocusedColumnIndex(col)}
                                            onTabFromActions={async (direction) => {
                                                const handle = editableRowRefs.current.get(tx.guid);
                                                if (handle?.isDirty()) {
                                                    await handle.save();
                                                }

                                                if (direction === 'next') {
                                                    if (ledgerViewStyle === 'journal' || ledgerViewStyle === 'autosplit') {
                                                        setFocusedSplitIndex(0);
                                                        setFocusedColumnIndex(0);
                                                    } else {
                                                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                        setFocusedColumnIndex(0);
                                                    }
                                                    return;
                                                }

                                                setFocusedRowIndex(i => Math.max(i - 1, 0));
                                                setFocusedColumnIndex(4);
                                            }}
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
                                                columnIds={visibleColumnIds}
                                                trailingColumns={3}
                                                isInvestmentAccount={true}
                                                sharePrecision={sharePrecision}
                                                commodityScu={commodityScu}
                                                isActive={index === focusedRowIndex}
                                                focusedSplitIndex={index === focusedRowIndex ? focusedSplitIndex : undefined}
                                                focusedColumnIndex={index === focusedRowIndex && focusedSplitIndex >= 0 ? focusedColumnIndex : undefined}
                                                onFocusedSplitChange={(si) => { setFocusedRowIndex(index); setFocusedSplitIndex(si); }}
                                                onColumnFocus={(col) => setFocusedColumnIndex(col)}
                                                onArrowUp={() => { setFocusedSplitIndex(-1); setFocusedColumnIndex(1); }}
                                                onArrowDownPastEnd={async () => {
                                                    const saved = await handleJournalSave(tx.guid);
                                                    if (saved) {
                                                        setFocusedSplitIndex(0);
                                                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                    }
                                                }}
                                                onTabToNextTransaction={async () => {
                                                    const saved = await handleJournalSave(tx.guid);
                                                    if (saved) {
                                                        setFocusedSplitIndex(-1);
                                                        setFocusedColumnIndex(0);
                                                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                    }
                                                }}
                                                onShiftTabToTransaction={() => {
                                                    setFocusedSplitIndex(-1);
                                                    setFocusedColumnIndex(1);
                                                }}
                                            />
                                        )}
                                    </React.Fragment>
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
                                            columnIds={visibleColumnIds}
                                            doubleLine={doubleLineEdit}
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
                                            onDescriptionSuggestion={(suggestion) => {
                                                const splitHandle = editableSplitRowRefs.current.get(tx.guid);
                                                if (splitHandle) {
                                                    splitHandle.applySuggestionSplits(suggestion.splits);
                                                }
                                            }}
                                            onShiftTabFromDate={async () => {
                                                if (index > 0) {
                                                    const saved = await handleJournalSave(tx.guid);
                                                    if (saved) {
                                                        const prevTx = displayTransactions[index - 1];
                                                        const prevNonTrading = (prevTx?.splits || []).filter(s =>
                                                            !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:'));
                                                        // Go to previous tx's last real split's credit column
                                                        // +1 for placeholder row, then -1 to land on last real split
                                                        const lastRealSplitIndex = prevNonTrading.length - 1;
                                                        setFocusedRowIndex(index - 1);
                                                        setFocusedSplitIndex(Math.max(0, lastRealSplitIndex));
                                                        setFocusedColumnIndex(3); // credit
                                                    }
                                                }
                                            }}
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
                                                columnIds={visibleColumnIds}
                                                sharePrecision={sharePrecision}
                                                commodityScu={commodityScu}
                                                isActive={index === focusedRowIndex}
                                                focusedSplitIndex={index === focusedRowIndex ? focusedSplitIndex : undefined}
                                                focusedColumnIndex={index === focusedRowIndex && focusedSplitIndex >= 0 ? focusedColumnIndex : undefined}
                                                onFocusedSplitChange={(si) => { setFocusedRowIndex(index); setFocusedSplitIndex(si); }}
                                                onColumnFocus={(col) => setFocusedColumnIndex(col)}
                                                onArrowUp={() => { setFocusedSplitIndex(-1); setFocusedColumnIndex(1); }}
                                                onArrowDownPastEnd={async () => {
                                                    const saved = await handleJournalSave(tx.guid);
                                                    if (saved) {
                                                        setFocusedSplitIndex(0);
                                                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                    }
                                                }}
                                                onTabToNextTransaction={async () => {
                                                    const saved = await handleJournalSave(tx.guid);
                                                    if (saved) {
                                                        setFocusedSplitIndex(-1);
                                                        setFocusedColumnIndex(0);
                                                        setFocusedRowIndex(i => Math.min(i + 1, displayTransactions.length - 1));
                                                    }
                                                }}
                                                onShiftTabToTransaction={() => {
                                                    setFocusedSplitIndex(-1);
                                                    setFocusedColumnIndex(1); // Focus description
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
                                            columnIds={visibleColumnIds}
                                        doubleLine={doubleLineEdit}
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
                                const isSelected = isRowSelected(tx, selectedSplits);

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
                                            doubleLine={doubleLineEdit}
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
                                        className={`hover:bg-surface-hover transition-colors group cursor-pointer ${isSelected ? 'bg-warning/5' : ''} ${index === focusedRowIndex ? 'ring-2 ring-primary/50 ring-inset bg-primary/5' : ''} ${isUnreviewed ? 'border-l-2 border-l-warning' : ''}`}
                                        onContextMenu={(e) => openContextMenu(e, tx)}
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
                                                        {getSelectableRowSplits(tx).length > 0 && (
                                                            <input
                                                                type="checkbox"
                                                                checked={isSelected}
                                                                onChange={() => toggleTransactionSelection(tx)}
                                                                className="w-4 h-4 rounded border-border-hover bg-background-tertiary text-warning focus:ring-warning/50 cursor-pointer"
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
                                                const descInvRow = isInvestmentAccount ? investmentRowMap?.get(tx.guid) : null;
                                                const lotSplit = isInvestmentAccount ? tx.splits?.find(s => s.lot_guid && s.account_guid === accountGuid) : null;
                                                const accountSplit = isInvestmentAccount ? tx.splits?.find(s => s.account_guid === accountGuid) : null;
                                                const lotInfo = lotSplit?.lot_guid ? lotMap.get(lotSplit.lot_guid) : null;
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm text-foreground align-middle leading-tight">
                                                        <div className="flex items-center gap-2">
                                                            {descInvRow && (
                                                                <TransactionTypeIcon type={descInvRow.transactionType} className="mr-0.5" />
                                                            )}
                                                            <span className="font-medium">{tx.description}</span>
                                                            {tx.tags && tx.tags.length > 0 && tx.tags.map(tag => (
                                                                <TagChip key={tag.id} name={tag.name} color={tag.color} title={`#${tag.name}`} />
                                                            ))}
                                                            {tx.source && tx.source !== 'manual' && tx.match_type !== 'manual_reconciliation' && (
                                                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-warning/10 text-warning border border-warning/20 uppercase tracking-wider font-bold">
                                                                    Imported
                                                                </span>
                                                            )}
                                                            {tx.match_type === 'manual_reconciliation' && (
                                                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wider font-bold">
                                                                    Bank-verified
                                                                </span>
                                                            )}
                                                            {lotInfo && lotSplit?.lot_guid && (
                                                                <LotBadge
                                                                    lotGuid={lotSplit.lot_guid}
                                                                    lotIndex={lotInfo.index}
                                                                    isClosed={lotInfo.isClosed}
                                                                    sharePrecision={sharePrecision}
                                                                    tooltip={{
                                                                        title: lotInfo.title,
                                                                        shares: lotInfo.totalShares,
                                                                        costBasis: lotInfo.totalCost,
                                                                        unrealizedGain: lotInfo.unrealizedGain,
                                                                        holdingPeriod: lotInfo.holdingPeriod,
                                                                        currencyMnemonic: accountCurrency,
                                                                    }}
                                                                />
                                                            )}
                                                            {isInvestmentAccount && (
                                                                <LotAssignmentPopover
                                                                    splitGuid={lotSplit?.guid || accountSplit?.guid || ''}
                                                                    currentLotGuid={lotSplit?.lot_guid || null}
                                                                    lots={Array.from(lotMap.entries()).map(([guid, info]) => ({
                                                                        guid,
                                                                        title: info.title,
                                                                        totalShares: info.totalShares,
                                                                        isClosed: info.isClosed,
                                                                    }))}
                                                                    onAssign={handleSplitLotAssign}
                                                                    onCreateAndAssign={handleSplitCreateAndAssign}
                                                                />
                                                            )}
                                                        </div>
                                                        {originalPayeeLine(tx) && (
                                                            <div className="text-[11px] text-foreground-muted truncate" title={originalPayeeLine(tx) ?? undefined}>
                                                                Imported as &ldquo;{originalPayeeLine(tx)}&rdquo;
                                                            </div>
                                                        )}
                                                        {tx.num && <span className="text-[10px] text-foreground-muted font-mono">#{tx.num}</span>}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'transfer') {
                                                if (isInvestmentAccount && !showSubaccounts) {
                                                    const invRow = investmentRowMap?.get(tx.guid);
                                                    const jumpSplit = otherSplits[0];
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm text-foreground-secondary align-middle leading-tight">
                                                            <span className="flex items-center gap-1 text-xs whitespace-normal break-words min-w-0">
                                                                {invRow?.transferAccount || '\u2014'}
                                                                {jumpSplit && jumpSplit.account_guid !== accountGuid && (
                                                                    <JumpToAccountButton
                                                                        accountGuid={jumpSplit.account_guid}
                                                                        accountLabel={jumpSplit.account_fullname || jumpSplit.account_name}
                                                                    />
                                                                )}
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
                                                                        <span className="flex items-center gap-1 text-foreground-secondary whitespace-normal break-words min-w-0">
                                                                            {formatDisplayAccountPath(split.account_fullname, split.account_name)}
                                                                            {split.account_guid !== accountGuid && (
                                                                                <JumpToAccountButton
                                                                                    accountGuid={split.account_guid}
                                                                                    accountLabel={split.account_fullname || split.account_name}
                                                                                />
                                                                            )}
                                                                        </span>
                                                                        <span className={`font-mono ml-2 ${parseFloat(split.value_decimal || split.quantity_decimal || '0') < 0 ? 'text-negative/70' : 'text-positive/70'}`}>
                                                                            {formatCurrency(split.value_decimal || split.quantity_decimal || '0', split.commodity_mnemonic || tx.commodity_mnemonic)}
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
                                                                className="text-foreground-muted hover:text-primary transition-colors flex items-center gap-1 italic text-xs"
                                                            >
                                                                <span>-- Multiple Splits --</span>
                                                                <span className="text-[10px]">&#9660;</span>
                                                            </button>
                                                        ) : (
                                                            <div className="space-y-1">
                                                                {otherSplits.map((split) => (
                                                                    <div key={split.guid} className="flex justify-between items-center text-xs">
                                                                        <span className="flex items-center gap-1 text-foreground-secondary whitespace-normal break-words min-w-0">
                                                                            {formatDisplayAccountPath(split.account_fullname, split.account_name)}
                                                                            {split.account_guid !== accountGuid && (
                                                                                <JumpToAccountButton
                                                                                    accountGuid={split.account_guid}
                                                                                    accountLabel={split.account_fullname || split.account_name}
                                                                                />
                                                                            )}
                                                                        </span>
                                                                        {isExpanded && (
                                                                            <span className={`font-mono ml-2 ${parseFloat(split.value_decimal || split.quantity_decimal || '0') < 0 ? 'text-negative/70' : 'text-positive/70'}`}>
                                                                                {formatCurrency(split.value_decimal || split.quantity_decimal || '0', split.commodity_mnemonic || tx.commodity_mnemonic)}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                                {isMultiSplit && isExpanded && (
                                                                    <button
                                                                        onClick={() => toggleExpand(tx.guid)}
                                                                        className="text-primary/50 hover:text-primary transition-colors text-[10px] mt-1"
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
                                                    <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle text-positive">
                                                        {amount >= 0 ? formatCurrency(amount, tx.commodity_mnemonic) : ''}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'credit') {
                                                return (
                                                    <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle text-negative">
                                                        {amount < 0 ? formatCurrency(Math.abs(amount), tx.commodity_mnemonic) : ''}
                                                    </td>
                                                );
                                            }

                                            if (colId === 'balance') {
                                                return (
                                                    <td key={cell.id} className={`px-4 py-2 text-sm font-mono text-right align-middle font-bold ${tx.running_balance ? (applyBalanceReversal(parseFloat(tx.running_balance), accountType, balanceReversal) < 0 ? 'text-negative' : 'text-positive') : 'text-foreground-muted'}`}>
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
                                                                <span className={invRow.shares > 0 ? 'text-positive' : 'text-negative'}>
                                                                    {invRow.shares.toFixed(sharePrecision)}
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
                                                    // Realized gains land in the Buy column (value added to the
                                                    // account), losses in the Sell column — mirroring GnuCash
                                                    // desktop's debit/credit register placement.
                                                    const gainHere = invRow?.transactionType === 'realized_gain'
                                                        && invRow.gainAmount !== null && invRow.gainAmount >= 0
                                                        ? invRow.gainAmount : null;
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle">
                                                            {invRow?.buyAmount != null ? (
                                                                <span className="text-positive">
                                                                    {formatCurrency(invRow.buyAmount, invRow.currencyMnemonic)}
                                                                </span>
                                                            ) : gainHere !== null ? (
                                                                <span className="text-positive" title="Realized gain">
                                                                    {formatCurrency(gainHere, invRow!.currencyMnemonic)}
                                                                </span>
                                                            ) : (
                                                                <span className="opacity-30">&mdash;</span>
                                                            )}
                                                        </td>
                                                    );
                                                }

                                                if (colId === 'sell') {
                                                    const lossHere = invRow?.transactionType === 'realized_gain'
                                                        && invRow.gainAmount !== null && invRow.gainAmount < 0
                                                        ? Math.abs(invRow.gainAmount) : null;
                                                    return (
                                                        <td key={cell.id} className="px-4 py-2 text-sm font-mono text-right align-middle">
                                                            {invRow?.sellAmount != null ? (
                                                                <span className="text-negative">
                                                                    {formatCurrency(invRow.sellAmount, invRow.currencyMnemonic)}
                                                                </span>
                                                            ) : lossHere !== null ? (
                                                                <span className="text-negative" title="Realized loss">
                                                                    {formatCurrency(lossHere, invRow!.currencyMnemonic)}
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
                                                            {invRow ? invRow.shareBalance.toFixed(sharePrecision) : '\u2014'}
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

                                            if (colId === 'receipt') {
                                                return (
                                                    <td key={cell.id} className="px-1 py-1 align-middle" onClick={(e) => e.stopPropagation()}>
                                                        <ReceiptIndicator
                                                            transactionGuid={tx.guid}
                                                            transactionDescription={tx.description}
                                                            receiptCount={tx.receipt_count || 0}
                                                        />
                                                    </td>
                                                );
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
                                                commodity_mnemonic: s.commodity_mnemonic || tx.commodity_mnemonic || 'USD',
                                            }))}
                                            currencyMnemonic={tx.commodity_mnemonic || 'USD'}
                                            columns={row.getVisibleCells().length}
                                            columnIds={visibleColumnIds}
                                            trailingColumns={isInvestmentAccount ? 2 : undefined}
                                            isInvestmentAccount={isInvestmentAccount}
                                            sharePrecision={sharePrecision}
                                            currentAccountGuid={accountGuid}
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
                        <h3 className="text-lg font-semibold text-primary mb-2">All caught up!</h3>
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
                            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
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

            {isInvestmentAccount && !editingTransaction ? (
                <Modal
                    isOpen={isEditModalOpen}
                    onClose={() => setIsEditModalOpen(false)}
                    title="New Investment Transaction"
                    size="2xl"
                    closeOnBackdrop={false}
                    closeOnEscape={true}
                    resetKey="new-investment"
                >
                    <div className="px-6 py-4">
                        <InvestmentTransactionForm
                            accountGuid={accountGuid}
                            accountName={`${investmentSymbol} investment account`}
                            accountCommodityGuid={accountCommodityGuid || ''}
                            commoditySymbol={investmentSymbol}
                            commodityFraction={commodityScu}
                            currentShares={investmentCurrentShares}
                            onSave={() => {
                                setIsEditModalOpen(false);
                                suppressNextDataEvent('transactions');
                                fetchTransactions();
                            }}
                            onCancel={() => setIsEditModalOpen(false)}
                        />
                    </div>
                </Modal>
            ) : (
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
                        suppressNextDataEvent('transactions');
                        fetchTransactions();
                    }}
                    onRefresh={() => {
                        suppressNextDataEvent('transactions');
                        return fetchTransactions();
                    }}
                />
            )}

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

            <TransactionContextMenu
                isOpen={!!contextMenu}
                x={contextMenu?.x ?? 0}
                y={contextMenu?.y ?? 0}
                items={contextMenuItems}
                onClose={() => setContextMenu(null)}
            />

            <TransactionTagEditor
                transactionGuid={tagEditorGuid}
                isOpen={!!tagEditorGuid}
                onClose={() => setTagEditorGuid(null)}
                onSaved={handleTagsSaved}
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

        <AccountPickerDialog
            isOpen={bulkRecatOpen}
            onClose={() => setBulkRecatOpen(false)}
            onSelect={(guid, name) => {
                void handleBulkRecategorize(guid, name);
                setBulkRecatOpen(false);
            }}
            excludeAccountGuid={accountGuid}
            commodityGuid={isInvestmentAccount ? undefined : accountCommodityGuid}
            title={`Recategorize ${editSelectedGuids.size} transaction${editSelectedGuids.size !== 1 ? 's' : ''} to...`}
        />

        <BulkDescriptionModal
            isOpen={bulkDescOpen}
            count={editSelectedGuids.size}
            onClose={() => setBulkDescOpen(false)}
            onSubmit={handleBulkDescription}
        />

        <BulkTagsModal
            isOpen={bulkTagsOpen}
            count={editSelectedGuids.size}
            onClose={() => setBulkTagsOpen(false)}
            onSubmit={handleBulkTags}
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
                        className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover transition-colors"
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
                commodityScu={commodityScu}
                accountCurrency={accountCurrency}
                isInvestment={isInvestmentAccount}
                sharePrecision={sharePrecision}
                currentBalance={reconciledBalance}
                selectedBalance={selectedBalance}
                onReconcileComplete={handleReconcileComplete}
                selectedSplits={selectedSplits}
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
