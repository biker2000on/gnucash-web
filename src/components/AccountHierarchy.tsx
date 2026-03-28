"use client";

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    ColumnDef,
    ExpandedState,
    VisibilityState,
    flexRender,
    getCoreRowModel,
    getExpandedRowModel,
    useReactTable,
} from '@tanstack/react-table';
import { AccountWithChildren } from '@/lib/types';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { formatCurrency, applyBalanceReversal, BalanceReversal } from '@/lib/format';
import { formatDateForDisplay } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useInvalidateAccounts } from '@/lib/hooks/useAccounts';
import { useReviewStatus } from '@/lib/hooks/useReviewStatus';
import { ReviewStatusMap } from '@/app/api/accounts/review-status/route';
import { Modal } from './ui/Modal';
import { AccountForm } from './AccountForm';

type SortKey = 'name' | 'total_balance' | 'period_balance';

type ColumnId =
    | 'accountName'
    | 'periodBalance'
    | 'totalBalanceUsd'
    | 'totalBalanceCommodity'
    | 'lastReconcileDate'
    | 'reconciledUsd'
    | 'placeholderBadge';

interface ReconcileSummaryRow {
    guid: string;
    last_reconcile_date: string | null;
    reconciled_usd: string;
}

interface DerivedAccount extends AccountWithChildren {
    children: DerivedAccount[];
    ownCommodityBalance: number;
    ownCommodityBalanceLabel: string;
    periodBalanceUsd: number;
    totalBalanceUsd: number;
    reconciledUsd: number;
    aggregatedUnreviewed: number;
    hasSimpleFin: boolean;
    lastReconcileDate: string | null;
}

const COLUMN_VISIBILITY_KEY = 'account_hierarchy.column_visibility';
const COLUMN_ORDER_KEY = 'account_hierarchy.column_order';
const REQUIRED_COLUMNS: ColumnId[] = [
    'accountName',
    'periodBalance',
    'totalBalanceUsd',
    'totalBalanceCommodity',
];
const ALWAYS_VISIBLE_COLUMNS: ColumnId[] = ['accountName'];
const DEFAULT_COLUMN_ORDER: ColumnId[] = [
    'accountName',
    'periodBalance',
    'totalBalanceUsd',
    'totalBalanceCommodity',
    'lastReconcileDate',
    'reconciledUsd',
    'placeholderBadge',
];
const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
    accountName: true,
    periodBalance: true,
    totalBalanceUsd: true,
    totalBalanceCommodity: true,
    lastReconcileDate: false,
    reconciledUsd: false,
    placeholderBadge: false,
};
const MOBILE_DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
    accountName: true,
    periodBalance: false,
    totalBalanceUsd: false,
    totalBalanceCommodity: false,
    lastReconcileDate: false,
    reconciledUsd: false,
    placeholderBadge: false,
};

function aggregateUnreviewed(account: AccountWithChildren, statusMap: ReviewStatusMap): number {
    let count = statusMap[account.guid]?.unreviewedCount || 0;
    for (const child of account.children || []) {
        count += aggregateUnreviewed(child, statusMap);
    }
    return count;
}

function getSortValue(account: AccountWithChildren, sortKey: SortKey): number | string {
    if (sortKey === 'name') return account.name;
    if (sortKey === 'total_balance') return parseFloat(account.total_balance || '0');
    return parseFloat(account.period_balance || '0');
}

function sortTree(accounts: AccountWithChildren[], sortKey: SortKey): AccountWithChildren[] {
    return [...accounts]
        .sort((a, b) => {
            const aValue = getSortValue(a, sortKey);
            const bValue = getSortValue(b, sortKey);

            if (typeof aValue === 'string' && typeof bValue === 'string') {
                return aValue.localeCompare(bValue);
            }

            return Number(bValue) - Number(aValue);
        })
        .map((account) => ({
            ...account,
            children: sortTree(account.children, sortKey),
        }));
}

function findAncestorPath(accounts: AccountWithChildren[], targetGuid: string): string[] | null {
    for (const account of accounts) {
        if (account.guid === targetGuid) return [];
        if (account.children.length > 0) {
            const childPath = findAncestorPath(account.children, targetGuid);
            if (childPath !== null) return [account.guid, ...childPath];
        }
    }
    return null;
}

function buildExpandedDefaults(accounts: AccountWithChildren[], expandToDepth: number): ExpandedState {
    const expanded: Record<string, boolean> = {};
    const visit = (nodes: AccountWithChildren[], depth: number) => {
        for (const node of nodes) {
            if (node.children.length === 0) continue;
            if (expandToDepth === Infinity || depth < expandToDepth) {
                expanded[node.guid] = true;
                visit(node.children, depth + 1);
            }
        }
    };
    visit(accounts, 0);
    return expanded;
}

function applyManualExpanded(defaultExpanded: ExpandedState, manualExpanded: Record<string, boolean>): ExpandedState {
    if (defaultExpanded === true) return true;

    const merged = { ...defaultExpanded };
    for (const [guid, isExpanded] of Object.entries(manualExpanded)) {
        if (isExpanded) {
            merged[guid] = true;
        } else {
            delete merged[guid];
        }
    }
    return merged;
}

function getMaxDate(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
}

function deriveTree(
    accounts: AccountWithChildren[],
    statusMap: ReviewStatusMap,
    reconcileMap: Map<string, ReconcileSummaryRow>,
    balanceReversal: BalanceReversal
): DerivedAccount[] {
    const deriveNode = (account: AccountWithChildren): DerivedAccount => {
        const ownCommodityBalance = applyBalanceReversal(
            parseFloat(account.total_balance || '0'),
            account.account_type,
            balanceReversal
        );
        const ownPeriodBalance = applyBalanceReversal(
            parseFloat(account.period_balance || '0'),
            account.account_type,
            balanceReversal
        );
        const ownTotalUsd = account.total_balance_usd
            ? applyBalanceReversal(parseFloat(account.total_balance_usd), account.account_type, balanceReversal)
            : ownCommodityBalance;
        const ownPeriodUsd = account.period_balance_usd
            ? applyBalanceReversal(parseFloat(account.period_balance_usd), account.account_type, balanceReversal)
            : ownPeriodBalance;
        const ownReconciledUsd = applyBalanceReversal(
            parseFloat(reconcileMap.get(account.guid)?.reconciled_usd || '0'),
            account.account_type,
            balanceReversal
        );

        const children = account.children.map(deriveNode);

        let totalBalanceUsd = ownTotalUsd;
        let periodBalanceUsd = ownPeriodUsd;
        let reconciledUsd = ownReconciledUsd;
        let lastReconcileDate = reconcileMap.get(account.guid)?.last_reconcile_date || null;

        for (const child of children) {
            totalBalanceUsd += child.totalBalanceUsd;
            periodBalanceUsd += child.periodBalanceUsd;
            reconciledUsd += child.reconciledUsd;
            lastReconcileDate = getMaxDate(lastReconcileDate, child.lastReconcileDate);
        }

        const fractionDigits =
            account.account_type === 'STOCK' || account.account_type === 'MUTUAL' ? 4 : 2;

        return {
            ...account,
            children,
            ownCommodityBalance,
            ownCommodityBalanceLabel: new Intl.NumberFormat('en-US', {
                minimumFractionDigits: fractionDigits,
                maximumFractionDigits: fractionDigits,
            }).format(ownCommodityBalance),
            periodBalanceUsd,
            totalBalanceUsd,
            reconciledUsd,
            aggregatedUnreviewed: aggregateUnreviewed(account, statusMap),
            hasSimpleFin: statusMap[account.guid]?.hasSimpleFin ?? false,
            lastReconcileDate,
        };
    };

    return accounts.map(deriveNode);
}

function filterTree(
    accounts: DerivedAccount[],
    filterText: string,
    showHidden: boolean,
    showToReview: boolean
): DerivedAccount[] {
    const normalizedFilter = filterText.trim().toLowerCase();

    const visit = (account: DerivedAccount): DerivedAccount | null => {
        if (account.hidden && !showHidden) {
            return null;
        }

        const filteredChildren = account.children
            .map(visit)
            .filter((child): child is DerivedAccount => child !== null);

        const selfMatchesText =
            normalizedFilter.length === 0 ||
            account.name.toLowerCase().includes(normalizedFilter);
        const descendantMatchesText = filteredChildren.length > 0;
        const textMatches = selfMatchesText || descendantMatchesText;
        const reviewMatches = !showToReview || account.aggregatedUnreviewed > 0;

        if (!textMatches || !reviewMatches) {
            return null;
        }

        return {
            ...account,
            children: filteredChildren,
        };
    };

    return accounts
        .map(visit)
        .filter((account): account is DerivedAccount => account !== null);
}

function normalizeVisibility(state: VisibilityState): VisibilityState {
    const next = { ...DEFAULT_COLUMN_VISIBILITY, ...state };
    for (const key of ALWAYS_VISIBLE_COLUMNS) {
        next[key] = true;
    }
    return next;
}

function getDefaultVisibility(isMobile: boolean): VisibilityState {
    return isMobile ? MOBILE_DEFAULT_COLUMN_VISIBILITY : DEFAULT_COLUMN_VISIBILITY;
}

function normalizeColumnOrder(order: string[] | ColumnId[] | undefined): ColumnId[] {
    const requested = Array.isArray(order) ? order : [];
    const filtered = requested.filter(
        (id): id is ColumnId => id !== 'accountName' && DEFAULT_COLUMN_ORDER.includes(id as ColumnId)
    );
    const remaining = DEFAULT_COLUMN_ORDER.filter(
        (id) => id !== 'accountName' && !filtered.includes(id)
    );
    return ['accountName', ...filtered, ...remaining];
}

interface AccountHierarchyProps {
    accounts: AccountWithChildren[];
    onRefresh?: () => void;
}

export default function AccountHierarchy({ accounts, onRefresh }: AccountHierarchyProps) {
    const isMobile = useIsMobile();
    const { balanceReversal, dateFormat } = useUserPreferences();
    const invalidateAccounts = useInvalidateAccounts();
    const { data: reviewStatusData } = useReviewStatus();
    const statusMap = useMemo<ReviewStatusMap>(() => reviewStatusData ?? {}, [reviewStatusData]);

    const { data: reconcileSummary = [] } = useQuery<ReconcileSummaryRow[]>({
        queryKey: ['accounts', 'reconcile-summary'],
        queryFn: async () => {
            const res = await fetch('/api/accounts/reconcile-summary');
            if (!res.ok) throw new Error('Failed to fetch account reconcile summary');
            return res.json() as Promise<ReconcileSummaryRow[]>;
        },
        staleTime: 1000 * 60 * 5,
    });

    const [showHidden, setShowHidden] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('accountHierarchy.showHidden');
            return saved ? JSON.parse(saved) : false;
        }
        return false;
    });
    const [showToReview, setShowToReview] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('accountHierarchy.showToReview');
            return saved ? JSON.parse(saved) : false;
        }
        return false;
    });
    const [filterText, setFilterText] = useState('');
    const [sortKey, setSortKey] = useState<SortKey>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('accountHierarchy.sortKey');
            return (saved as SortKey) || 'name';
        }
        return 'name';
    });
    const [expandToDepth, setExpandToDepth] = useState<number>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('accountHierarchy.expandToDepth');
            return saved ? (saved === 'Infinity' ? Infinity : parseInt(saved, 10)) : Infinity;
        }
        return Infinity;
    });
    const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('accountHierarchy.manualExpanded');
            return saved ? JSON.parse(saved) : {};
        }
        return {};
    });
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => getDefaultVisibility(false));
    const [columnOrder, setColumnOrder] = useState<ColumnId[]>(DEFAULT_COLUMN_ORDER);
    const [columnPrefsLoaded, setColumnPrefsLoaded] = useState(false);
    const [draggedColumnId, setDraggedColumnId] = useState<ColumnId | null>(null);
    const [isColumnsMenuOpen, setIsColumnsMenuOpen] = useState(false);
    const columnsMenuRef = useRef<HTMLDivElement | null>(null);

    const [modalOpen, setModalOpen] = useState(false);
    const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
    const [selectedAccount, setSelectedAccount] = useState<AccountWithChildren | null>(null);
    const [parentGuid, setParentGuid] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<AccountWithChildren | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const filterInputRef = useRef<HTMLInputElement>(null);

    // Keyboard navigation
    const router = useRouter();
    const searchParams = useSearchParams();
    const [focusedRowIndex, setFocusedRowIndex] = useState(-1);
    const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
    const focusGuid = searchParams.get('focus');

    useEffect(() => {
        localStorage.setItem('accountHierarchy.showHidden', JSON.stringify(showHidden));
    }, [showHidden]);

    useEffect(() => {
        localStorage.setItem('accountHierarchy.showToReview', JSON.stringify(showToReview));
    }, [showToReview]);

    useEffect(() => {
        localStorage.setItem('accountHierarchy.sortKey', sortKey);
    }, [sortKey]);

    useEffect(() => {
        localStorage.setItem(
            'accountHierarchy.expandToDepth',
            expandToDepth === Infinity ? 'Infinity' : expandToDepth.toString()
        );
    }, [expandToDepth]);

    useEffect(() => {
        localStorage.setItem('accountHierarchy.manualExpanded', JSON.stringify(manualExpanded));
    }, [manualExpanded]);

    useEffect(() => {
        if (!isColumnsMenuOpen) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (columnsMenuRef.current && !columnsMenuRef.current.contains(event.target as Node)) {
                setIsColumnsMenuOpen(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDown);
        return () => document.removeEventListener('mousedown', handlePointerDown);
    }, [isColumnsMenuOpen]);

    useEffect(() => {
        let cancelled = false;

        async function loadColumnPrefs() {
            try {
                const res = await fetch('/api/user/preferences?key=account_hierarchy.*');
                if (!res.ok) throw new Error('Failed to load column preferences');
                const data = await res.json() as { preferences?: Record<string, unknown> };
                const savedVisibility = data.preferences?.[COLUMN_VISIBILITY_KEY];
                const savedOrder = data.preferences?.[COLUMN_ORDER_KEY];

                if (!cancelled && savedVisibility && typeof savedVisibility === 'object' && !Array.isArray(savedVisibility)) {
                    setColumnVisibility(normalizeVisibility(savedVisibility as VisibilityState));
                } else if (!cancelled) {
                    setColumnVisibility(getDefaultVisibility(isMobile));
                }

                if (!cancelled && Array.isArray(savedOrder)) {
                    setColumnOrder(normalizeColumnOrder(savedOrder as string[]));
                }
            } catch {
                if (!cancelled) {
                    setColumnVisibility(getDefaultVisibility(isMobile));
                    setColumnOrder(DEFAULT_COLUMN_ORDER);
                }
            } finally {
                if (!cancelled) {
                    setColumnPrefsLoaded(true);
                }
            }
        }

        loadColumnPrefs();
        return () => {
            cancelled = true;
        };
    }, [isMobile]);

    useEffect(() => {
        if (!columnPrefsLoaded) return;

        const timeoutId = window.setTimeout(() => {
            fetch('/api/user/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preferences: {
                        [COLUMN_VISIBILITY_KEY]: normalizeVisibility(columnVisibility),
                        [COLUMN_ORDER_KEY]: normalizeColumnOrder(columnOrder),
                    },
                }),
            }).catch(() => {
                console.error('Failed to save account hierarchy column preferences');
            });
        }, 250);

        return () => window.clearTimeout(timeoutId);
    }, [columnOrder, columnVisibility, columnPrefsLoaded]);

    const reconcileMap = useMemo(
        () => new Map(reconcileSummary.map((row) => [row.guid, row])),
        [reconcileSummary]
    );

    const sortedAccounts = useMemo(() => sortTree(accounts, sortKey), [accounts, sortKey]);
    const derivedAccounts = useMemo(
        () => deriveTree(sortedAccounts, statusMap, reconcileMap, balanceReversal),
        [sortedAccounts, statusMap, reconcileMap, balanceReversal]
    );
    const filteredAccounts = useMemo(
        () => filterTree(derivedAccounts, filterText, showHidden, showToReview),
        [derivedAccounts, filterText, showHidden, showToReview]
    );

    const defaultExpanded = useMemo(
        () => buildExpandedDefaults(filteredAccounts, expandToDepth),
        [filteredAccounts, expandToDepth]
    );
    const expanded = useMemo<ExpandedState>(() => {
        if (filterText || showToReview) return true;
        return applyManualExpanded(defaultExpanded, manualExpanded);
    }, [defaultExpanded, filterText, manualExpanded, showToReview]);

    const handleRowToggle = useCallback((guid: string, isExpanded: boolean) => {
        setManualExpanded((prev) => ({
            ...prev,
            [guid]: !isExpanded,
        }));
    }, []);

    const moveColumn = useCallback((fromId: ColumnId, toId: ColumnId) => {
        if (fromId === toId || fromId === 'accountName' || toId === 'accountName') {
            return;
        }

        setColumnOrder((prev) => {
            const current = normalizeColumnOrder(prev);
            const fromIndex = current.indexOf(fromId);
            const toIndex = current.indexOf(toId);

            if (fromIndex === -1 || toIndex === -1) {
                return current;
            }

            const next = [...current];
            next.splice(fromIndex, 1);
            next.splice(toIndex, 0, fromId);
            return normalizeColumnOrder(next);
        });
    }, []);

    const handleNewAccount = useCallback(() => {
        setSelectedAccount(null);
        setParentGuid(null);
        setModalMode('create');
        setModalOpen(true);
    }, []);

    const handleNewChild = useCallback((parent: AccountWithChildren) => {
        setSelectedAccount(null);
        setParentGuid(parent.guid);
        setModalMode('create');
        setModalOpen(true);
    }, []);

    const handleEdit = useCallback(async (account: AccountWithChildren) => {
        // Fetch full account data including notes and preferences
        try {
            const res = await fetch(`/api/accounts/${account.guid}`);
            if (res.ok) {
                const fullAccount = await res.json();
                setSelectedAccount({
                    ...account,
                    ...fullAccount,
                });
            } else {
                setSelectedAccount(account);
            }
        } catch {
            setSelectedAccount(account);
        }
        setParentGuid(null);
        setModalMode('edit');
        setModalOpen(true);
    }, []);

    const handleDeleteConfirm = useCallback((account: AccountWithChildren) => {
        setDeleteConfirm(account);
        setDeleteError(null);
    }, []);

    const handleDelete = useCallback(async () => {
        if (!deleteConfirm) return;

        setDeleting(true);
        setDeleteError(null);

        try {
            const res = await fetch(`/api/accounts/${deleteConfirm.guid}`, {
                method: 'DELETE',
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to delete account');
            }

            setDeleteConfirm(null);
            invalidateAccounts();
            onRefresh?.();
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Failed to delete account');
        } finally {
            setDeleting(false);
        }
    }, [deleteConfirm, invalidateAccounts, onRefresh]);

    const handleSave = useCallback(async (data: {
        name: string;
        account_type: string;
        parent_guid: string | null;
        commodity_guid: string;
        code: string;
        description: string;
        hidden: number;
        placeholder: number;
        notes: string;
        tax_related: boolean;
        is_retirement: boolean;
        retirement_account_type: string | null;
    }) => {
        const url = modalMode === 'create'
            ? '/api/accounts'
            : `/api/accounts/${selectedAccount?.guid}`;
        const method = modalMode === 'create' ? 'POST' : 'PUT';

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.error || errorData.errors?.[0]?.message || 'Failed to save account');
        }

        setModalOpen(false);
        invalidateAccounts();
        onRefresh?.();
    }, [modalMode, selectedAccount, invalidateAccounts, onRefresh]);

    const columns = useMemo<ColumnDef<DerivedAccount>[]>(() => [
        {
            id: 'accountName',
            header: 'Account Name',
            cell: ({ row }) => {
                const account = row.original;
                const canExpand = row.getCanExpand();
                const isExpanded = row.getIsExpanded();
                const indent = row.depth * (isMobile ? 10 : 20) + 12;

                return (
                    <div
                        className={`group flex w-full min-w-[18rem] items-center gap-1.5 py-2.5 sm:py-1 px-2 sm:px-1.5 rounded-l-lg transition-colors ${
                            account.hidden ? 'opacity-50 grayscale' : ''
                        }`}
                        style={{ paddingLeft: `${indent}px` }}
                    >
                        {canExpand ? (
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    handleRowToggle(account.guid, isExpanded);
                                }}
                                className={`text-[10px] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                                aria-label={isExpanded ? 'Collapse account' : 'Expand account'}
                            >
                                ▶
                            </button>
                        ) : (
                            <span className="w-3" />
                        )}
                        <Link
                            href={`/accounts/${account.guid}`}
                            className={`text-foreground-secondary font-medium truncate hover:text-emerald-400 transition-colors ${
                                filterText && account.name.toLowerCase().includes(filterText.toLowerCase())
                                    ? 'text-emerald-400 underline underline-offset-4 decoration-emerald-500/50'
                                    : ''
                            }`}
                            onClick={(event) => event.stopPropagation()}
                        >
                            {account.name}
                        </Link>
                        {account.hasSimpleFin && (
                            <svg className="w-3 h-3 text-foreground-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Linked to SimpleFin">
                                <title>Linked to SimpleFin</title>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                        )}
                        {account.aggregatedUnreviewed > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold flex-shrink-0">
                                {account.aggregatedUnreviewed}
                            </span>
                        )}
                        {account.hidden === 1 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-tertiary text-foreground-muted border border-border-hover">
                                HIDDEN
                            </span>
                        )}
                        <Link
                            href={`/accounts/${account.guid}`}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 min-h-[24px] min-w-[24px] flex items-center justify-center hover:bg-border-hover rounded text-foreground-muted hover:text-emerald-400 ml-0.5"
                            title="View Ledger"
                            onClick={(event) => event.stopPropagation()}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                            </svg>
                        </Link>
                        <div className="opacity-0 group-hover:opacity-100 flex gap-0 ml-0.5 transition-opacity">
                            <button
                                onClick={(event) => {
                                    event.stopPropagation();
                                    handleNewChild(account);
                                }}
                                className="p-1 min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-emerald-500/20 text-foreground-muted hover:text-emerald-400 transition-colors"
                                title="Add Child Account"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                            </button>
                            <button
                                onClick={(event) => {
                                    event.stopPropagation();
                                    handleEdit(account);
                                }}
                                className="p-1 min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-cyan-500/20 text-foreground-muted hover:text-cyan-400 transition-colors"
                                title="Edit Account"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                            </button>
                            <button
                                onClick={(event) => {
                                    event.stopPropagation();
                                    handleDeleteConfirm(account);
                                }}
                                className="p-1 min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-rose-500/20 text-foreground-muted hover:text-rose-400 transition-colors"
                                title="Delete Account"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                            </button>
                        </div>
                    </div>
                );
            },
        },
        {
            id: 'periodBalance',
            header: 'Period Balance',
            cell: ({ row }) => (
                <div className="text-right py-1 px-3 font-mono leading-tight">
                    <span className={`text-sm ${row.original.periodBalanceUsd < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {formatCurrency(row.original.periodBalanceUsd, 'USD')}
                    </span>
                </div>
            ),
        },
        {
            id: 'totalBalanceUsd',
            header: 'Total Balance $',
            cell: ({ row }) => (
                <div className="text-right py-1 px-3 font-mono leading-tight">
                    <span className={`text-sm font-bold ${row.original.totalBalanceUsd < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {formatCurrency(row.original.totalBalanceUsd, 'USD')}
                    </span>
                </div>
            ),
        },
        {
            id: 'totalBalanceCommodity',
            header: 'Balance in Commodity',
            cell: ({ row }) => (
                <div className="text-right py-1 px-3 font-mono leading-tight">
                    <span className="text-sm text-foreground-secondary">
                        {row.original.ownCommodityBalanceLabel} {row.original.commodity_mnemonic || ''}
                    </span>
                </div>
            ),
        },
        {
            id: 'lastReconcileDate',
            header: 'Last Reconcile Date',
            cell: ({ row }) => (
                <div className="px-3 py-1 text-sm leading-tight text-right text-foreground-secondary">
                    {row.original.lastReconcileDate
                        ? formatDateForDisplay(row.original.lastReconcileDate, dateFormat)
                        : '—'}
                </div>
            ),
        },
        {
            id: 'reconciledUsd',
            header: 'Reconciled (USD)',
            cell: ({ row }) => (
                <div className="px-3 py-1 text-sm leading-tight text-right font-mono text-foreground-secondary">
                    {formatCurrency(row.original.reconciledUsd, 'USD')}
                </div>
            ),
        },
        {
            id: 'placeholderBadge',
            header: 'Placeholder',
            cell: ({ row }) => (
                <div className="px-3 py-1 leading-tight text-right">
                    {row.original.placeholder === 1 ? (
                        <span className="text-[10px] px-2 py-1 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 uppercase tracking-wide">
                            Placeholder
                        </span>
                    ) : (
                        <span className="text-sm text-foreground-muted">—</span>
                    )}
                </div>
            ),
        },
    ], [dateFormat, filterText, handleDeleteConfirm, handleEdit, handleNewChild, handleRowToggle, isMobile]);

    const normalizedVisibility = useMemo(() => normalizeVisibility(columnVisibility), [columnVisibility]);
    const normalizedOrder = useMemo(() => normalizeColumnOrder(columnOrder), [columnOrder]);

    const table = useReactTable({
        data: filteredAccounts,
        columns,
        state: {
            expanded,
            columnVisibility: normalizedVisibility,
            columnOrder: normalizedOrder,
        },
        getRowId: (row) => row.guid,
        getSubRows: (row) => row.children,
        getCoreRowModel: getCoreRowModel(),
        getExpandedRowModel: getExpandedRowModel(),
        onColumnVisibilityChange: (updater) => {
            setColumnVisibility((prev) => {
                const next = typeof updater === 'function' ? updater(prev) : updater;
                return normalizeVisibility(next);
            });
        },
        onColumnOrderChange: (updater) => {
            setColumnOrder((prev) => {
                const next = typeof updater === 'function' ? updater(prev) : updater;
                return normalizeColumnOrder(next);
            });
        },
    });

    // Keyboard navigation handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const tag = target?.tagName;
            const isInInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

            // Don't handle keys when focus is inside a popover/dropdown (e.g. BookSwitcher)
            if (target?.closest?.('[data-popover]')) return;

            // Handle Esc in filter input: clear text first, then blur
            if (isInInput && e.key === 'Escape' && e.target === filterInputRef.current) {
                e.preventDefault();
                if (filterText) {
                    setFilterText('');
                } else {
                    filterInputRef.current?.blur();
                }
                return;
            }

            // '/' to focus filter input (when not in an input)
            if (!isInInput && e.key === '/') {
                e.preventDefault();
                filterInputRef.current?.focus();
                return;
            }

            if (isInInput) return;
            if (modalOpen || deleteConfirm !== null) return;

            const rows = table.getRowModel().rows;
            if (rows.length === 0) return;

            switch (e.key) {
                case 'ArrowDown':
                case 'j': {
                    e.preventDefault();
                    setFocusedRowIndex(prev => Math.min(prev + 1, rows.length - 1));
                    break;
                }
                case 'ArrowUp':
                case 'k': {
                    e.preventDefault();
                    setFocusedRowIndex(prev => Math.max(prev - 1, 0));
                    break;
                }
                case 'Enter': {
                    if (focusedRowIndex < 0 || focusedRowIndex >= rows.length) break;
                    e.preventDefault();
                    router.push(`/accounts/${rows[focusedRowIndex].original.guid}`);
                    break;
                }
                case 'ArrowRight':
                case 'l': {
                    if (focusedRowIndex < 0 || focusedRowIndex >= rows.length) break;
                    const row = rows[focusedRowIndex];
                    if (row.getCanExpand() && !row.getIsExpanded()) {
                        e.preventDefault();
                        handleRowToggle(row.original.guid, false);
                    }
                    break;
                }
                case 'ArrowLeft':
                case 'h': {
                    if (focusedRowIndex < 0 || focusedRowIndex >= rows.length) break;
                    const row = rows[focusedRowIndex];
                    if (row.getIsExpanded()) {
                        e.preventDefault();
                        handleRowToggle(row.original.guid, true);
                    } else if (row.depth > 0) {
                        // Move to parent row
                        e.preventDefault();
                        const parentId = row.parentId;
                        if (parentId) {
                            const parentIndex = rows.findIndex(r => r.id === parentId);
                            if (parentIndex >= 0) setFocusedRowIndex(parentIndex);
                        }
                    }
                    break;
                }
                case 'Escape': {
                    setFocusedRowIndex(-1);
                    break;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [focusedRowIndex, modalOpen, deleteConfirm, table, handleRowToggle, router, filterText]);

    // Auto-scroll focused row into view
    useEffect(() => {
        if (focusedRowIndex >= 0) {
            const el = rowRefs.current.get(focusedRowIndex);
            el?.scrollIntoView({ block: 'nearest' });
        }
    }, [focusedRowIndex]);

    // Focus row from query param (e.g. navigating back from ledger)
    const hasFocusExpanded = useRef(false);
    useEffect(() => {
        if (!focusGuid) {
            hasFocusExpanded.current = false;
            return;
        }

        const rows = table.getRowModel().rows;
        const idx = rows.findIndex(r => r.original.guid === focusGuid);
        if (idx >= 0) {
            setFocusedRowIndex(idx);
            hasFocusExpanded.current = false;
            // Clean up the query param
            router.replace('/accounts', { scroll: false });
            return;
        }

        // Row not visible - expand ancestors (only try once to avoid infinite loop)
        if (!hasFocusExpanded.current) {
            hasFocusExpanded.current = true;
            const path = findAncestorPath(accounts, focusGuid);
            if (path && path.length > 0) {
                setManualExpanded(prev => {
                    const next = { ...prev };
                    for (const guid of path) {
                        next[guid] = true;
                    }
                    return next;
                });
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusGuid, expanded, accounts]);

    return (
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-3 sm:p-6 shadow-2xl">
            <div className="flex flex-col gap-6 mb-8 pb-4 border-b border-border/50">
                <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-3">
                    <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
                        <span className="w-2 h-6 bg-emerald-500 rounded-full" />
                        Account Assets & Liabilities
                    </h2>
                    <div className="flex flex-wrap items-center gap-4">
                        <button
                            onClick={handleNewAccount}
                            className="w-full md:w-auto flex items-center justify-center gap-2 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            New Account
                        </button>
                        <div className="flex items-center gap-3">
                            <span className="text-sm text-foreground-secondary">To Review</span>
                            <button
                                onClick={() => setShowToReview(!showToReview)}
                                className={`w-14 h-8 min-h-[44px] rounded-full p-1 transition-colors duration-200 ease-in-out ${showToReview ? 'bg-amber-500' : 'bg-border-hover'}`}
                            >
                                <div className={`w-6 h-6 rounded-full bg-white transition-transform duration-200 ease-in-out ${showToReview ? 'translate-x-6' : 'translate-x-0'}`} />
                            </button>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="text-sm text-foreground-secondary">Show Hidden</span>
                            <button
                                onClick={() => setShowHidden(!showHidden)}
                                className={`w-14 h-8 min-h-[44px] rounded-full p-1 transition-colors duration-200 ease-in-out ${showHidden ? 'bg-emerald-500' : 'bg-border-hover'}`}
                            >
                                <div className={`w-6 h-6 rounded-full bg-white transition-transform duration-200 ease-in-out ${showHidden ? 'translate-x-6' : 'translate-x-0'}`} />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col md:flex-row gap-4">
                    <div className="relative flex-1">
                        <input
                            ref={filterInputRef}
                            type="text"
                            placeholder="Filter accounts... (press / to focus)"
                            className="w-full bg-input-bg border border-border rounded-xl px-4 py-2 text-sm text-foreground focus:outline-none focus:border-emerald-500/50 transition-all"
                            value={filterText}
                            onChange={(event) => setFilterText(event.target.value)}
                        />
                        {filterText && (
                            <button
                                onClick={() => setFilterText('')}
                                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground-secondary min-h-[44px] min-w-[44px] flex items-center justify-center"
                            >
                                ✕
                            </button>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-xs text-foreground-muted uppercase tracking-widest font-bold">Expand</span>
                        <div className="flex gap-1">
                            <button
                                onClick={() => {
                                    setExpandToDepth(0);
                                    setManualExpanded({});
                                }}
                                className="bg-input-bg border border-border rounded-lg px-3 py-2 min-h-[44px] text-xs text-foreground-secondary hover:bg-surface-hover hover:border-emerald-500/50 transition-all flex items-center"
                                title="Collapse All"
                            >
                                Collapse All
                            </button>
                            <button
                                onClick={() => {
                                    setExpandToDepth(Infinity);
                                    setManualExpanded({});
                                }}
                                className="bg-input-bg border border-border rounded-lg px-3 py-2 min-h-[44px] text-xs text-foreground-secondary hover:bg-surface-hover hover:border-emerald-500/50 transition-all flex items-center"
                                title="Expand All"
                            >
                                Expand All
                            </button>
                        </div>
                        <select
                            className="bg-input-bg border border-border rounded-lg px-3 py-2 min-h-[44px] text-xs text-foreground focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                            value={expandToDepth === Infinity ? 'all' : expandToDepth}
                            onChange={(event) => {
                                setExpandToDepth(event.target.value === 'all' ? Infinity : parseInt(event.target.value, 10));
                                setManualExpanded({});
                            }}
                            title="Expand to Depth"
                        >
                            <option value="0">Level 0</option>
                            <option value="1">Level 1</option>
                            <option value="2">Level 2</option>
                            <option value="3">Level 3</option>
                            <option value="4">Level 4</option>
                            <option value="5">Level 5</option>
                            <option value="all">All Levels</option>
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-xs text-foreground-muted uppercase tracking-widest font-bold">Sort By</span>
                        <select
                            className="bg-input-bg border border-border rounded-xl px-3 py-2 min-h-[44px] text-sm text-foreground focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                            value={sortKey}
                            onChange={(event) => setSortKey(event.target.value as SortKey)}
                        >
                            <option value="name">Name</option>
                            <option value="total_balance">Total Balance</option>
                            <option value="period_balance">Period Balance</option>
                        </select>
                    </div>

                    <div className="relative" ref={columnsMenuRef}>
                        <button
                            type="button"
                            onClick={() => setIsColumnsMenuOpen((prev) => !prev)}
                            className="list-none bg-input-bg border border-border rounded-xl px-3 py-2 min-h-[44px] text-sm text-foreground-secondary hover:bg-surface-hover transition-all cursor-pointer flex items-center"
                        >
                            Columns
                        </button>
                        {isColumnsMenuOpen && (
                        <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-border bg-surface shadow-2xl p-3 space-y-2">
                            {table.getAllLeafColumns().map((column) => {
                                const isRequired = ALWAYS_VISIBLE_COLUMNS.includes(column.id as ColumnId);
                                const label = String(column.columnDef.header);
                                const draggable = column.id !== 'accountName';

                                return (
                                    <label key={column.id} className={`flex items-center gap-2 text-sm ${isRequired ? 'text-foreground-muted' : 'text-foreground-secondary cursor-pointer'}`}>
                                        <span
                                            draggable={draggable}
                                            onDragStart={() => {
                                                if (draggable) setDraggedColumnId(column.id as ColumnId);
                                            }}
                                            onDragEnd={() => setDraggedColumnId(null)}
                                            onDragOver={(event) => {
                                                if (!draggable || !draggedColumnId) return;
                                                event.preventDefault();
                                            }}
                                            onDrop={(event) => {
                                                if (!draggable || !draggedColumnId) return;
                                                event.preventDefault();
                                                moveColumn(draggedColumnId, column.id as ColumnId);
                                                setDraggedColumnId(null);
                                            }}
                                            className={`text-xs ${draggable ? 'cursor-grab text-foreground-muted' : 'text-foreground-muted/40'}`}
                                            title={draggable ? 'Drag to reorder column' : 'Account Name stays first'}
                                        >
                                            ≡
                                        </span>
                                        <input
                                            type="checkbox"
                                            checked={column.getIsVisible()}
                                            disabled={isRequired}
                                            onChange={column.getToggleVisibilityHandler()}
                                            className="w-4 h-4 rounded border-border bg-background-tertiary disabled:opacity-50"
                                        />
                                        {label}
                                    </label>
                                );
                            })}
                        </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] table-auto">
                    <thead className="border-b border-border/60">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th
                                        key={header.id}
                                        draggable={!header.isPlaceholder && header.column.id !== 'accountName'}
                                        onDragStart={() => {
                                            if (!header.isPlaceholder && header.column.id !== 'accountName') {
                                                setDraggedColumnId(header.column.id as ColumnId);
                                            }
                                        }}
                                        onDragEnd={() => setDraggedColumnId(null)}
                                        onDragOver={(event) => {
                                            if (header.isPlaceholder || header.column.id === 'accountName' || !draggedColumnId) return;
                                            event.preventDefault();
                                        }}
                                        onDrop={(event) => {
                                            if (header.isPlaceholder || header.column.id === 'accountName' || !draggedColumnId) return;
                                            event.preventDefault();
                                            moveColumn(draggedColumnId, header.column.id as ColumnId);
                                            setDraggedColumnId(null);
                                        }}
                                        className={`px-2 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-foreground-muted ${
                                            header.column.id === 'accountName' ? 'w-full' : 'whitespace-nowrap'
                                        } ${
                                            !header.isPlaceholder && header.column.id !== 'accountName' ? 'cursor-grab select-none' : ''
                                        } ${
                                            draggedColumnId && draggedColumnId === header.column.id ? 'opacity-50' : ''
                                        }`}
                                        title={!header.isPlaceholder && header.column.id !== 'accountName' ? 'Drag to reorder column' : undefined}
                                    >
                                        {header.isPlaceholder ? null : (
                                            <div className="flex items-center gap-1.5">
                                                {header.column.id !== 'accountName' && (
                                                    <span className="text-[10px] text-foreground-muted/80">≡</span>
                                                )}
                                                <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                                            </div>
                                        )}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody className="divide-y divide-border/40">
                        {table.getRowModel().rows.map((row, rowIndex) => (
                            <tr
                                key={row.id}
                                ref={(el) => {
                                    if (el) rowRefs.current.set(rowIndex, el);
                                    else rowRefs.current.delete(rowIndex);
                                }}
                                className={`group hover:bg-surface-hover/20 transition-colors ${row.getCanExpand() ? 'cursor-pointer' : ''} ${rowIndex === focusedRowIndex ? 'ring-2 ring-emerald-500/50 ring-inset bg-white/[0.03]' : ''}`}
                                onClick={() => {
                                    setFocusedRowIndex(rowIndex);
                                    if (row.getCanExpand()) {
                                        handleRowToggle(row.original.guid, row.getIsExpanded());
                                    }
                                }}
                            >
                                {row.getVisibleCells().map((cell) => (
                                    <td key={cell.id} className="align-middle">
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {table.getRowModel().rows.length === 0 && (
                <div className="py-12 text-center text-foreground-secondary">
                    No accounts match the current filters.
                </div>
            )}

            <Modal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                title={modalMode === 'create' ? 'Create Account' : 'Edit Account'}
                size="lg"
            >
                <div className="p-6">
                    <AccountForm
                        mode={modalMode}
                        accountGuid={selectedAccount?.guid}
                        initialData={selectedAccount ? {
                            name: selectedAccount.name,
                            account_type: selectedAccount.account_type,
                            parent_guid: selectedAccount.parent_guid,
                            commodity_guid: selectedAccount.commodity_guid,
                            code: selectedAccount.code,
                            description: selectedAccount.description,
                            hidden: selectedAccount.hidden,
                            placeholder: selectedAccount.placeholder,
                            notes: (selectedAccount as Record<string, unknown>).notes as string ?? '',
                            tax_related: (selectedAccount as Record<string, unknown>).tax_related as boolean ?? false,
                            is_retirement: (selectedAccount as Record<string, unknown>).is_retirement as boolean ?? false,
                            retirement_account_type: (selectedAccount as Record<string, unknown>).retirement_account_type as string | null ?? null,
                        } : undefined}
                        parentGuid={parentGuid}
                        onSave={handleSave}
                        onCancel={() => setModalOpen(false)}
                    />
                </div>
            </Modal>

            <Modal
                isOpen={deleteConfirm !== null}
                onClose={() => setDeleteConfirm(null)}
                title="Delete Account"
                size="sm"
            >
                <div className="p-6 space-y-4">
                    {deleteError && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-rose-400 text-sm">
                            {deleteError}
                        </div>
                    )}
                    <p className="text-foreground-secondary">
                        Are you sure you want to delete <strong className="text-foreground">{deleteConfirm?.name}</strong>?
                    </p>
                    <p className="text-sm text-foreground-muted">
                        This action cannot be undone. Accounts with transactions cannot be deleted.
                    </p>
                    <div className="flex justify-end gap-3 pt-4">
                        <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleDelete}
                            disabled={deleting}
                            className="px-4 py-2 text-sm bg-rose-600 hover:bg-rose-500 disabled:bg-rose-600/50 text-white rounded-lg transition-colors"
                        >
                            {deleting ? 'Deleting...' : 'Delete Account'}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
