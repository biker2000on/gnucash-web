'use client';

import { useState, useEffect, useMemo, use, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { InlineAmountEditor } from '@/components/budget/InlineAmountEditor';
import AccountPickerDialog from '@/components/AccountPickerDialog';
import { BUDGETABLE_ACCOUNT_TYPES } from '@/lib/budget-constants';
import { BatchEditModal } from '@/components/budget/BatchEditModal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { useToast } from '@/contexts/ToastContext';
import { BudgetProgress } from './BudgetProgress';
import { BudgetYoY } from './BudgetYoY';
import type { BudgetActualsResponse } from '@/lib/budget-actuals';

interface BudgetAmount {
    id: number;
    budget_guid: string;
    account_guid: string;
    period_num: number;
    amount_num: string;
    amount_denom: string;
    amount_decimal: string;
    account_name: string;
    account_parent_guid: string | null;
    commodity_mnemonic: string;
    account: {
        guid: string;
        name: string;
        account_type: string;
        parent_guid: string | null;
    };
}

interface Budget {
    guid: string;
    name: string;
    description: string | null;
    num_periods: number;
    recurrence: {
        period_type: string;
        mult: number;
        period_start: string;
    } | null;
    amounts: BudgetAmount[];
}

interface AccountNode {
    guid: string;
    name: string;
    type: string;
    mnemonic: string;
    parentGuid: string | null;
    periods: Map<number, number>;
    ownTotal: number;      // This account's own budgeted total
    rolledUpTotal: number; // Including children's totals
    rolledUpPeriods: Map<number, number>; // Rolled up period values
    children: AccountNode[];
    depth: number;
    hasOwnBudget: boolean; // Whether this account has explicit budget amounts
}

interface BudgetDetailPageProps {
    params: Promise<{ guid: string }>;
}

export default function BudgetDetailPage({ params }: BudgetDetailPageProps) {
    const { guid } = use(params);
    const { balanceReversal } = useUserPreferences();
    const toast = useToast();
    const [budget, setBudget] = useState<Budget | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showAccountPicker, setShowAccountPicker] = useState(false);
    const [batchEditAccount, setBatchEditAccount] = useState<{ guid: string; name: string; type: string } | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set());
    const [expandLevel, setExpandLevel] = useState<number>(0);
    // The single budget cell currently being edited, as `${accountGuid}:${period}`.
    // Lifting this to the page lets Tab move the editor across cells.
    const [activeCell, setActiveCell] = useState<string | null>(null);

    // Progress vs editor view. Defaults to Progress when the budget has
    // amounts (set once after the initial fetch), Editor otherwise.
    const [view, setView] = useState<'progress' | 'editor' | null>(null);
    const [actuals, setActuals] = useState<BudgetActualsResponse | null>(null);
    const [actualsLoading, setActualsLoading] = useState(false);
    const [actualsError, setActualsError] = useState<string | null>(null);

    // View toggle state
    const [showAllAccounts, setShowAllAccounts] = useState(false);
    const [allAccounts, setAllAccounts] = useState<Array<{
        guid: string;
        name: string;
        account_type: string;
        parent_guid: string | null;
        commodity: { mnemonic: string } | null;
    }>>([]);

    // Delete confirmation state
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deletingAccountGuid, setDeletingAccountGuid] = useState<string | null>(null);

    useEffect(() => {
        async function fetchBudget() {
            try {
                const res = await fetch(`/api/budgets/${guid}`);
                if (!res.ok) {
                    if (res.status === 404) {
                        throw new Error('Budget not found');
                    }
                    throw new Error('Failed to fetch budget');
                }
                const data = await res.json();
                setBudget(data);
                setView(prev => prev ?? ((data.amounts?.length ?? 0) > 0 ? 'progress' : 'editor'));
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        }
        fetchBudget();
    }, [guid]);

    const fetchActuals = useCallback(async () => {
        setActualsLoading(true);
        setActualsError(null);
        try {
            const res = await fetch(`/api/budgets/${guid}/actuals`);
            if (!res.ok) throw new Error('Failed to load budget progress');
            const data = await res.json();
            setActuals(data);
        } catch (err) {
            setActualsError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setActualsLoading(false);
        }
    }, [guid]);

    // (Re)load actuals whenever the budget data changes so edits made in the
    // editor are reflected in the progress view.
    useEffect(() => {
        if (budget) fetchActuals();
    }, [budget, fetchActuals]);

    // Integrate with the global shortcut events (GlobalShortcuts): 'e' enters
    // the editor view; Escape returns to Progress when the budget has amounts.
    useEffect(() => {
        const handleEnterEdit = () => setView('editor');
        const handleExitEdit = () => {
            if ((budget?.amounts?.length ?? 0) > 0) {
                setView(prev => (prev === 'editor' ? 'progress' : prev));
            }
        };
        window.addEventListener('enter-edit-mode', handleEnterEdit);
        window.addEventListener('exit-edit-mode', handleExitEdit);
        return () => {
            window.removeEventListener('enter-edit-mode', handleEnterEdit);
            window.removeEventListener('exit-edit-mode', handleExitEdit);
        };
    }, [budget]);

    useEffect(() => {
        if (!showAllAccounts) return;
        async function fetchAllAccounts() {
            try {
                const res = await fetch(`/api/budgets/${guid}/accounts`);
                if (res.ok) {
                    const data = await res.json();
                    setAllAccounts(data);
                }
            } catch (err) {
                console.error('Error fetching all accounts:', err);
            }
        }
        fetchAllAccounts();
    }, [guid, showAllAccounts]);

    const refreshBudget = async () => {
        try {
            const res = await fetch(`/api/budgets/${guid}`);
            if (res.ok) {
                const data = await res.json();
                setBudget(data);
            }
        } catch (err) {
            console.error('Error refreshing budget:', err);
        }
    };

    const handleDeleteAccount = (accountGuid: string) => {
        setDeletingAccountGuid(accountGuid);
        setDeleteConfirmOpen(true);
    };

    const handleDeleteConfirm = async () => {
        if (!deletingAccountGuid) return;

        setIsDeleting(deletingAccountGuid);
        try {
            const res = await fetch(`/api/budgets/${guid}/amounts?account_guid=${deletingAccountGuid}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                await refreshBudget();
            }
        } catch (err) {
            console.error('Error deleting account:', err);
        } finally {
            setIsDeleting(null);
            setDeleteConfirmOpen(false);
            setDeletingAccountGuid(null);
        }
    };

    const handleEstimate = async (accountGuid: string, accountType: string) => {
        try {
            const res = await fetch(`/api/budgets/${guid}/estimate?account_guid=${accountGuid}&months=12`);
            if (!res.ok) throw new Error('Failed to get estimate');
            const data = await res.json();

            // getHistoricalAverage returns a natural (positive) figure. Budget
            // amounts are stored in raw GnuCash sign (income negative), so flip
            // income before persisting to match the rest of the budget system.
            const amount = accountType === 'INCOME' ? -data.average : data.average;

            // Apply estimate to all periods
            const applyRes = await fetch(`/api/budgets/${guid}/amounts/all-periods`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account_guid: accountGuid,
                    amount
                })
            });

            if (applyRes.ok) {
                toast.success('Budget estimate applied successfully');
                await refreshBudget();
            } else {
                throw new Error('Failed to apply estimate');
            }
        } catch (err) {
            console.error('Error applying estimate:', err);
            toast.error('Failed to apply estimate');
        }
    };

    const handleAmountUpdate = (accountGuid: string, periodNum: number, newValue: number) => {
        if (!budget) return;

        // Optimistic update (upsert): update the matching row, or synthesize one
        // from a sibling period so newly-created cells reflect immediately.
        setBudget(prev => {
            if (!prev) return prev;
            const idx = prev.amounts.findIndex(
                amt => amt.account_guid === accountGuid && amt.period_num === periodNum
            );
            if (idx >= 0) {
                const amounts = prev.amounts.slice();
                amounts[idx] = { ...amounts[idx], amount_decimal: newValue.toString() };
                return { ...prev, amounts };
            }
            const sibling = prev.amounts.find(amt => amt.account_guid === accountGuid);
            if (!sibling) return prev; // no metadata to clone; refreshBudget will reconcile
            const optimistic: BudgetAmount = {
                ...sibling,
                id: -Date.now(),
                period_num: periodNum,
                amount_decimal: newValue.toString(),
            };
            return { ...prev, amounts: [...prev.amounts, optimistic] };
        });
    };

    const handleAddToBudget = async (accountGuid: string) => {
        if (!budget) return;
        try {
            const res = await fetch(`/api/budgets/${budget.guid}/amounts`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account_guid: accountGuid,
                    period_num: 0,
                    amount: 0
                })
            });
            if (res.ok) {
                toast.success('Account added to budget');
                await refreshBudget();
            } else {
                throw new Error('Failed to add account');
            }
        } catch (err) {
            console.error('Error adding account to budget:', err);
            toast.error('Failed to add account to budget');
        }
    };

    const toggleExpanded = useCallback((nodeGuid: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(nodeGuid)) {
                next.delete(nodeGuid);
            } else {
                next.add(nodeGuid);
            }
            return next;
        });
    }, []);

    const expandAll = useCallback(() => {
        if (!budget) return;
        const parentGuids = new Set(budget.amounts.map(a => a.account_parent_guid).filter((g): g is string => g !== null));
        if (showAllAccounts && allAccounts.length > 0) {
            // Also include all parent guids from all accounts, and all accounts that have children
            const allParentGuids = new Set(allAccounts.map(a => a.parent_guid).filter((g): g is string => g !== null));
            for (const pg of allParentGuids) {
                parentGuids.add(pg);
            }
            // Any account that is a parent_guid of another account needs to be expandable
            for (const a of allAccounts) {
                if (allParentGuids.has(a.guid)) {
                    parentGuids.add(a.guid);
                }
            }
        }
        setExpandedNodes(parentGuids);
    }, [budget, showAllAccounts, allAccounts]);

    const collapseAll = useCallback(() => {
        setExpandedNodes(new Set());
        setExpandLevel(0);
    }, []);

    // Build hierarchical tree structure from flat amounts
    const { treeData, flattenedNodes } = useMemo(() => {
        if (!budget) return { treeData: [], flattenedNodes: [], periodTotals: [], grandTotal: 0 };

        // First, create a map of all accounts with their budget data
        const accountMap = new Map<string, {
            guid: string;
            name: string;
            type: string;
            mnemonic: string;
            parentGuid: string | null;
            periods: Map<number, number>;
            ownTotal: number;
            hasOwnBudget: boolean;
        }>();

        for (const amount of budget.amounts) {
            const existing = accountMap.get(amount.account_guid);
            const value = parseFloat(amount.amount_decimal) || 0;

            if (existing) {
                existing.periods.set(amount.period_num, value);
                existing.ownTotal += value;
            } else {
                const periods = new Map<number, number>();
                periods.set(amount.period_num, value);
                accountMap.set(amount.account_guid, {
                    guid: amount.account_guid,
                    name: amount.account_name,
                    type: amount.account.account_type,
                    mnemonic: amount.commodity_mnemonic,
                    parentGuid: amount.account_parent_guid,
                    periods,
                    ownTotal: value,
                    hasOwnBudget: true,
                });
            }
        }

        // When showing all accounts, merge in non-budgeted accounts
        if (showAllAccounts && allAccounts.length > 0) {
            // Build a set of all account GUIDs returned by the API (excludes ROOT)
            const allAccountGuids = new Set(allAccounts.map(a => a.guid));

            for (const acc of allAccounts) {
                if (!accountMap.has(acc.guid)) {
                    // If parent_guid points to an account not in allAccounts, it's the ROOT account
                    // Treat those as top-level (parentGuid = null)
                    const parentGuid = acc.parent_guid && allAccountGuids.has(acc.parent_guid)
                        ? acc.parent_guid
                        : null;

                    accountMap.set(acc.guid, {
                        guid: acc.guid,
                        name: acc.name,
                        type: acc.account_type,
                        mnemonic: acc.commodity?.mnemonic || 'USD',
                        parentGuid: parentGuid,
                        periods: new Map(),
                        ownTotal: 0,
                        hasOwnBudget: false,
                    });
                }
            }

            // Also fix parentGuid for budgeted accounts whose parent is ROOT
            // (i.e., parent_guid not in allAccountGuids means it's ROOT or missing)
            for (const [, data] of accountMap) {
                if (data.parentGuid && !allAccountGuids.has(data.parentGuid)) {
                    data.parentGuid = null;
                }
            }
        }

        // Build tree nodes
        const nodeMap = new Map<string, AccountNode>();

        // Create nodes for all accounts in accountMap
        for (const [guid, data] of accountMap) {
            nodeMap.set(guid, {
                guid: data.guid,
                name: data.name,
                type: data.type,
                mnemonic: data.mnemonic,
                parentGuid: data.parentGuid,
                periods: data.periods,
                ownTotal: data.ownTotal,
                rolledUpTotal: data.ownTotal,
                rolledUpPeriods: new Map(data.periods),
                children: [],
                depth: 0,
                hasOwnBudget: data.hasOwnBudget,
            });
        }

        // Build parent-child relationships and find roots
        const roots: AccountNode[] = [];
        for (const [, node] of nodeMap) {
            if (node.parentGuid && nodeMap.has(node.parentGuid)) {
                const parent = nodeMap.get(node.parentGuid)!;
                parent.children.push(node);
            } else {
                roots.push(node);
            }
        }

        // Sort children by name
        const sortChildren = (nodes: AccountNode[]) => {
            nodes.sort((a, b) => a.name.localeCompare(b.name));
            for (const node of nodes) {
                sortChildren(node.children);
            }
        };
        sortChildren(roots);

        // Calculate depths and rolled up totals
        const setDepthAndRollUp = (node: AccountNode, depth: number) => {
            node.depth = depth;
            for (const child of node.children) {
                setDepthAndRollUp(child, depth + 1);
                // Roll up child totals
                node.rolledUpTotal += child.rolledUpTotal;
                // Roll up period values
                for (const [period, value] of child.rolledUpPeriods) {
                    const current = node.rolledUpPeriods.get(period) || 0;
                    node.rolledUpPeriods.set(period, current + value);
                }
            }
        };

        for (const root of roots) {
            setDepthAndRollUp(root, 0);
        }

        // When showing all accounts, prune branches that have zero budget anywhere
        // (optional: keep all to show full hierarchy)

        // Flatten tree for rendering, respecting expanded state
        const flattened: AccountNode[] = [];
        const flattenTree = (nodes: AccountNode[], expanded: Set<string>) => {
            for (const node of nodes) {
                flattened.push(node);
                if (node.children.length > 0 && expanded.has(node.guid)) {
                    flattenTree(node.children, expanded);
                }
            }
        };
        flattenTree(roots, expandedNodes);

        // Calculate period totals from root nodes only (to avoid double counting)
        const totals = new Array(budget.num_periods).fill(0);
        for (const root of roots) {
            for (const [period, value] of root.rolledUpPeriods) {
                if (period >= 0 && period < budget.num_periods) {
                    totals[period] += value;
                }
            }
        }

        const total = totals.reduce((sum, val) => sum + val, 0);

        return {
            treeData: roots,
            flattenedNodes: flattened,
            periodTotals: totals,
            grandTotal: total,
        };
    }, [budget, expandedNodes, showAllAccounts, allAccounts]);

    const budgetCurrency = useMemo(() => {
        if (!budget?.amounts?.length) return 'USD';
        // Get the most common currency from budget accounts
        const currencies = budget.amounts.map(a => a.commodity_mnemonic).filter(Boolean);
        if (!currencies.length) return 'USD';
        // Return most frequent
        const freq = new Map<string, number>();
        currencies.forEach(c => freq.set(c, (freq.get(c) || 0) + 1));
        return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }, [budget]);

    const existingAccountGuids = useMemo(() =>
        flattenedNodes.filter(a => a.hasOwnBudget).map(a => a.guid),
        [flattenedNodes]
    );

    // Editable cells in visual (row-major) order, so Tab can walk them.
    const editableCellIds = useMemo(() => {
        const ids: string[] = [];
        const periods = budget?.num_periods ?? 0;
        for (const node of flattenedNodes) {
            if (!node.hasOwnBudget) continue;
            for (let i = 0; i < periods; i++) ids.push(`${node.guid}:${i}`);
        }
        return ids;
    }, [flattenedNodes, budget?.num_periods]);

    const editableIndex = useMemo(() => {
        const m = new Map<string, number>();
        editableCellIds.forEach((id, i) => m.set(id, i));
        return m;
    }, [editableCellIds]);

    const navigateCell = useCallback((cellId: string, dir: 1 | -1) => {
        const idx = editableIndex.get(cellId);
        if (idx === undefined) return;
        setActiveCell(editableCellIds[idx + dir] ?? null);
    }, [editableIndex, editableCellIds]);

    const handleLevelChange = useCallback((level: number) => {
        setExpandLevel(level);
        const toExpand = new Set<string>();
        const traverse = (nodes: AccountNode[], depth: number) => {
            for (const node of nodes) {
                if (depth < level && node.children.length > 0) {
                    toExpand.add(node.guid);
                    traverse(node.children, depth + 1);
                }
            }
        };
        traverse(treeData, 0);
        setExpandedNodes(toExpand);
    }, [treeData]);

    const autoExpandBudgeted = useCallback(() => {
        const toExpand = new Set<string>();
        const findBudgeted = (nodes: AccountNode[], ancestors: string[]) => {
            for (const node of nodes) {
                if (node.hasOwnBudget) {
                    ancestors.forEach(a => toExpand.add(a));
                }
                if (node.children.length > 0) {
                    findBudgeted(node.children, [...ancestors, node.guid]);
                }
            }
        };
        findBudgeted(treeData, []);
        setExpandedNodes(toExpand);
    }, [treeData]);

    // Compute footer summary rows by account type
    const { incomePeriods, expensePeriods, transferPeriods, remainingPeriods,
            incomeTotal, expenseTotal, transferTotal, remainingTotal } = useMemo(() => {
        if (!budget) {
            const empty = new Array(0).fill(0);
            return {
                incomePeriods: empty, expensePeriods: empty, transferPeriods: empty, remainingPeriods: empty,
                incomeTotal: 0, expenseTotal: 0, transferTotal: 0, remainingTotal: 0
            };
        }

        const incomeRoots = treeData.filter(n => n.type === 'INCOME');
        const expenseRoots = treeData.filter(n => n.type === 'EXPENSE');
        const transferRoots = treeData.filter(n => ['ASSET', 'LIABILITY', 'BANK', 'CASH'].includes(n.type));

        const sumPeriods = (nodes: AccountNode[]) => {
            const sums = new Array(budget.num_periods).fill(0);
            for (const node of nodes) {
                for (let i = 0; i < budget.num_periods; i++) {
                    sums[i] += node.rolledUpPeriods.get(i) || 0;
                }
            }
            return sums;
        };

        const inc = sumPeriods(incomeRoots);
        const exp = sumPeriods(expenseRoots);
        const xfer = sumPeriods(transferRoots);

        // Income is stored as negative in GnuCash, negate for display
        const incDisplay = inc.map(v => -v);
        // Liabilities within transfers are stored as negative, show as-is for net effect
        const rem = incDisplay.map((v, i) => v - exp[i] - xfer[i]);

        return {
            incomePeriods: incDisplay,
            expensePeriods: exp,
            transferPeriods: xfer,
            remainingPeriods: rem,
            incomeTotal: incDisplay.reduce((s, v) => s + v, 0),
            expenseTotal: exp.reduce((s, v) => s + v, 0),
            transferTotal: xfer.reduce((s, v) => s + v, 0),
            remainingTotal: rem.reduce((s, v) => s + v, 0),
        };
    }, [budget, treeData]);

    const getPeriodLabel = (num: number, index: number) => {
        const periodType = budget?.recurrence?.period_type;
        const periodStart = budget?.recurrence?.period_start;

        if (periodType === 'year') {
            if (periodStart) {
                const startYear = new Date(periodStart).getFullYear();
                return `${startYear + index}`;
            }
            return num === 1 ? 'Annual' : `Year ${index + 1}`;
        }

        if (periodType === 'month') {
            if (num === 12) {
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                return months[index];
            }
            if (num === 4) {
                return `Q${index + 1}`;
            }
        }

        // Fallback: use existing heuristic behavior
        if (num === 12) {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            return months[index];
        }
        if (num === 4) {
            return `Q${index + 1}`;
        }
        if (num === 1) {
            return 'Annual';
        }
        return `P${index + 1}`;
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="flex items-center gap-4">
                    <Link
                        href="/budgets"
                        className="p-2 rounded-lg hover:bg-surface-hover text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <div className="h-8 w-48 bg-background-tertiary rounded animate-pulse" />
                </div>
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading budget...</span>
                    </div>
                </div>
            </div>
        );
    }

    if (error || !budget) {
        return (
            <div className="space-y-6">
                <div className="flex items-center gap-4">
                    <Link
                        href="/budgets"
                        className="p-2 rounded-lg hover:bg-surface-hover text-foreground-secondary hover:text-foreground transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <h1 className="text-3xl font-bold text-foreground">Budget Not Found</h1>
                </div>
                <div className="bg-surface/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 text-center">
                    <div className="text-rose-400">{error || 'Budget not found'}</div>
                    <Link
                        href="/budgets"
                        className="inline-block mt-4 px-4 py-2 bg-background-tertiary hover:bg-border-hover text-foreground rounded-lg transition-colors"
                    >
                        Back to Budgets
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <>
            {/* Header - stays in normal container */}
            <div className="space-y-6 mb-6">
                <header className="flex items-start gap-3">
                    <Link
                        href="/budgets"
                        className="p-2 mt-0.5 rounded-lg hover:bg-surface-hover text-foreground-secondary hover:text-foreground transition-colors shrink-0"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <div className="flex-1 min-w-0">
                        <PageHeader
                            title={budget.name}
                            subtitle={budget.description ?? undefined}
                            actions={
                                <button
                                    onClick={() => setShowAccountPicker(true)}
                                    className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                    </svg>
                                    Add Account
                                </button>
                            }
                            toolbar={
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-primary/10 text-primary border border-primary/20">
                                        {budget.num_periods === 12 ? 'Monthly' : budget.num_periods === 4 ? 'Quarterly' : `${budget.num_periods} Periods`}
                                    </span>
                                    <span className="text-foreground-muted text-sm">
                                        {flattenedNodes.length} accounts
                                    </span>
                                </div>
                            }
                        />
                    </div>
                </header>

                {/* View tabs: Progress (actuals/pacing) vs Editor (amounts) */}
                <div className="flex items-center gap-1 border-b border-border">
                    <button
                        onClick={() => setView('progress')}
                        className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            view === 'progress'
                                ? 'border-primary text-primary'
                                : 'border-transparent text-foreground-secondary hover:text-foreground'
                        }`}
                    >
                        Progress
                    </button>
                    <button
                        onClick={() => setView('editor')}
                        className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            view === 'editor'
                                ? 'border-primary text-primary'
                                : 'border-transparent text-foreground-secondary hover:text-foreground'
                        }`}
                    >
                        Editor
                    </button>
                </div>

                {/* Summary Cards (editor view) */}
                {view === 'editor' && (
                <StatGrid cols={4}>
                    <StatCard
                        label="Total Income"
                        value={formatCurrency(incomeTotal.toString(), budgetCurrency)}
                        tone="positive"
                    />
                    <StatCard
                        label="Total Expenses"
                        value={formatCurrency(expenseTotal.toString(), budgetCurrency)}
                        tone="negative"
                    />
                    <StatCard
                        label="Average per Period"
                        value={formatCurrency((incomeTotal / budget.num_periods).toString(), budgetCurrency)}
                        tone="primary"
                    />
                    <StatCard
                        label={showAllAccounts ? 'Accounts Shown' : 'Budgeted Accounts'}
                        value={
                            <>
                                {flattenedNodes.length}
                                {showAllAccounts && (
                                    <span className="text-sm font-normal text-foreground-muted ml-2">
                                        ({flattenedNodes.filter(n => n.hasOwnBudget).length} budgeted)
                                    </span>
                                )}
                            </>
                        }
                    />
                </StatGrid>
                )}
            </div>

            {/* Progress view: budget vs actual with pacing + YoY */}
            {view === 'progress' && (
                <div className="space-y-6">
                    {actualsLoading && !actuals ? (
                        <div className="bg-surface border border-border rounded-lg p-12 flex items-center justify-center">
                            <div className="flex items-center gap-3">
                                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                                <span className="text-foreground-secondary">Loading budget progress...</span>
                            </div>
                        </div>
                    ) : actualsError ? (
                        <div className="bg-surface border border-rose-800/50 rounded-lg p-8 text-center text-rose-400">
                            {actualsError}
                        </div>
                    ) : actuals ? (
                        <>
                            <BudgetProgress data={actuals} />
                            {actuals.yoy && (
                                <BudgetYoY
                                    yoy={actuals.yoy}
                                    currency={actuals.currency}
                                    windowLabel={
                                        actuals.yoy.periodsCompared.length > 0
                                            ? `${actuals.periods[actuals.yoy.periodsCompared[0]]?.label} – ${actuals.periods[actuals.yoy.periodsCompared[actuals.yoy.periodsCompared.length - 1]]?.label}`
                                            : undefined
                                    }
                                />
                            )}
                        </>
                    ) : null}
                </div>
            )}

            {/* Budget Table - Full Width (editor view) */}
            {view === 'editor' && (
            <div>
                {flattenedNodes.length === 0 ? (
                    <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 text-center">
                        <svg className="w-16 h-16 mx-auto text-border-hover mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        <h3 className="text-lg font-medium text-foreground-secondary mb-2">No Budget Allocations</h3>
                        <p className="text-foreground-muted mb-4">
                            This budget has no account allocations yet.
                        </p>
                        <button
                            onClick={() => setShowAccountPicker(true)}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            Add Your First Account
                        </button>
                    </div>
                ) : (
                    <div className="bg-surface/30 backdrop-blur-xl border-y border-border">
                        {/* Expand/Collapse Controls */}
                        <div className="px-4 py-2 bg-surface-hover/50 border-b border-border">
                            <FilterBar
                                primary={
                                    <button
                                        onClick={() => setShowAllAccounts(!showAllAccounts)}
                                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                                            showAllAccounts
                                                ? 'bg-primary/20 text-primary border border-primary/30'
                                                : 'bg-surface text-foreground-secondary border border-border hover:bg-surface-hover'
                                        }`}
                                    >
                                        {showAllAccounts ? 'All Accounts' : 'Budgeted Only'}
                                    </button>
                                }
                            >
                                <button
                                    onClick={expandAll}
                                    className="text-xs text-foreground-secondary hover:text-foreground px-2 py-1 rounded hover:bg-surface-hover transition-colors"
                                >
                                    Expand All
                                </button>
                                <button
                                    onClick={collapseAll}
                                    className="text-xs text-foreground-secondary hover:text-foreground px-2 py-1 rounded hover:bg-surface-hover transition-colors"
                                >
                                    Collapse All
                                </button>
                                <button
                                    onClick={autoExpandBudgeted}
                                    className="text-xs text-primary hover:text-primary-hover px-2 py-1 rounded hover:bg-primary/10 transition-colors"
                                    title="Expand only branches that contain budgeted accounts"
                                >
                                    Auto-expand
                                </button>
                                <select
                                    value={expandLevel}
                                    onChange={(e) => handleLevelChange(parseInt(e.target.value))}
                                    className="text-xs bg-surface text-foreground-secondary border border-border rounded px-2 py-1"
                                >
                                    <option value="0">Collapse All</option>
                                    <option value="1">Level 1</option>
                                    <option value="2">Level 2</option>
                                    <option value="3">Level 3</option>
                                    <option value="99">Expand All</option>
                                </select>
                            </FilterBar>
                        </div>
                        <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-300px)]">
                            <table className="w-full text-sm max-md:text-xs">
                                <thead className="sticky top-0 z-20">
                                    <tr className="bg-background-secondary text-foreground-secondary text-xs uppercase tracking-widest shadow-md">
                                        <th className="px-4 py-3 max-md:px-1.5 max-md:py-1 text-left font-semibold sticky left-0 bg-background-secondary z-30 min-w-[250px] max-md:min-w-[160px]">Account</th>
                                        {Array.from({ length: budget.num_periods }, (_, i) => (
                                            <th key={i} className="px-3 py-3 max-md:px-1.5 max-md:py-1 text-right font-semibold min-w-[90px]">
                                                {getPeriodLabel(budget.num_periods, i)}
                                            </th>
                                        ))}
                                        <th className="px-4 py-3 max-md:px-1.5 max-md:py-1 text-right font-semibold bg-background-tertiary/30 min-w-[100px]">Total</th>
                                        <th className="px-3 py-3 max-md:px-1.5 max-md:py-1 text-center font-semibold min-w-[120px]">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border/50">
                                    {flattenedNodes.map(account => {
                                        const hasChildren = account.children.length > 0;
                                        const isExpanded = expandedNodes.has(account.guid);
                                        const showRolledUp = hasChildren && !account.hasOwnBudget;
                                        const displayTotal = showRolledUp ? account.rolledUpTotal : account.ownTotal;
                                        const displayPeriods = showRolledUp ? account.rolledUpPeriods : account.periods;
                                        // Non-budgeted account with no budget in subtree
                                        const isUnbudgeted = !account.hasOwnBudget && account.rolledUpTotal === 0;

                                        return (
                                            <tr key={account.guid} className={`hover:bg-white/[0.02] transition-colors ${isUnbudgeted ? 'opacity-50' : ''}`}>
                                                <td className="px-4 py-3 max-md:px-1.5 max-md:py-1 font-medium text-foreground sticky left-0 bg-background/90 backdrop-blur-sm z-10">
                                                    <div
                                                        className="flex items-center gap-2"
                                                        style={{ paddingLeft: `${account.depth * 20}px` }}
                                                    >
                                                        {hasChildren ? (
                                                            <button
                                                                onClick={() => toggleExpanded(account.guid)}
                                                                className="p-0.5 rounded hover:bg-border-hover transition-colors"
                                                            >
                                                                <svg
                                                                    className={`w-4 h-4 text-foreground-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                                                                    fill="none"
                                                                    stroke="currentColor"
                                                                    viewBox="0 0 24 24"
                                                                >
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                                </svg>
                                                            </button>
                                                        ) : (
                                                            <span className="w-5" />
                                                        )}
                                                        <div>
                                                            <Link
                                                                href={`/accounts/${account.guid}`}
                                                                className={`hover:text-primary transition-colors ${isUnbudgeted ? 'text-foreground-muted' : ''}`}
                                                            >
                                                                {account.name}
                                                            </Link>
                                                            <div className="text-xs text-foreground-muted">
                                                                {account.type}
                                                                {showRolledUp && account.rolledUpTotal !== 0 && (
                                                                    <span className="ml-2 text-primary">(subtotal)</span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                {Array.from({ length: budget.num_periods }, (_, i) => {
                                                    const value = displayPeriods.get(i) || 0;
                                                    const ownValue = account.periods.get(i) || 0;
                                                    const cellId = `${account.guid}:${i}`;

                                                    // Show editor for accounts with their own budget
                                                    if (account.hasOwnBudget) {
                                                        return (
                                                            <td key={i} className="px-1 py-1">
                                                                <InlineAmountEditor
                                                                    value={ownValue}
                                                                    budgetGuid={budget.guid}
                                                                    accountGuid={account.guid}
                                                                    periodNum={i}
                                                                    currency={account.mnemonic}
                                                                    accountType={account.type}
                                                                    balanceReversal={balanceReversal}
                                                                    onUpdate={(newValue) => handleAmountUpdate(account.guid, i, newValue)}
                                                                    onError={(msg) => toast.error(msg)}
                                                                    isActive={activeCell === cellId}
                                                                    onActivate={() => setActiveCell(cellId)}
                                                                    onNavigate={(dir) => navigateCell(cellId, dir)}
                                                                    onDeactivate={() => setActiveCell(null)}
                                                                />
                                                            </td>
                                                        );
                                                    } else if (showAllAccounts && value === 0) {
                                                        // Any BLANK cell in All Accounts view is clickable to add a
                                                        // budget amount — works for leaf AND parent accounts.
                                                        return (
                                                            <td key={i} className="px-2 py-1 text-right text-foreground-muted cursor-pointer hover:bg-surface-hover/50 transition-colors"
                                                                onClick={async () => {
                                                                    try {
                                                                        await fetch(`/api/budgets/${budget.guid}/amounts`, {
                                                                            method: 'PATCH',
                                                                            headers: { 'Content-Type': 'application/json' },
                                                                            body: JSON.stringify({
                                                                                account_guid: account.guid,
                                                                                period_num: i,
                                                                                amount: 0
                                                                            })
                                                                        });
                                                                        await refreshBudget();
                                                                        // Open the freshly-created cell for editing.
                                                                        setActiveCell(cellId);
                                                                    } catch (err) {
                                                                        console.error('Error creating budget entry:', err);
                                                                        toast.error('Failed to add budget amount');
                                                                    }
                                                                }}
                                                                title="Click to add budget amount"
                                                            >
                                                                {'—'}
                                                            </td>
                                                        );
                                                    } else {
                                                        // Show rolled up value (read-only) or dash for unbudgeted
                                                        const displayValue = applyBalanceReversal(value, account.type, balanceReversal);
                                                        const isSubtotal = showRolledUp && account.rolledUpTotal !== 0;
                                                        return (
                                                            <td key={i} className={`px-2 py-1 max-md:px-1.5 text-right font-mono text-sm max-md:text-xs ${
                                                                isSubtotal
                                                                    ? `italic ${displayValue < 0 ? 'text-rose-400' : 'text-foreground-muted'}`
                                                                    : displayValue < 0 ? 'text-rose-400' : 'text-primary'
                                                            }`}>
                                                                {value === 0 ? '—' : formatCurrency(displayValue, account.mnemonic)}
                                                            </td>
                                                        );
                                                    }
                                                })}
                                                {(() => {
                                                    const totalDisplay = applyBalanceReversal(displayTotal, account.type, balanceReversal);
                                                    return (
                                                        <td className={`px-4 py-3 max-md:px-1.5 max-md:py-1 text-right font-mono font-semibold bg-background-tertiary/30 ${
                                                            isUnbudgeted
                                                                ? 'text-foreground-muted'
                                                                : showRolledUp && !account.hasOwnBudget
                                                                    ? `italic ${totalDisplay < 0 ? 'text-rose-400' : 'text-foreground-muted'}`
                                                                    : totalDisplay < 0 ? 'text-rose-400' : 'text-emerald-400'
                                                        }`}>
                                                            {isUnbudgeted
                                                                ? '—'
                                                                : formatCurrency(totalDisplay, account.mnemonic)
                                                            }
                                                        </td>
                                                    );
                                                })()}
                                                <td className="px-2 py-2 max-md:px-1 max-md:py-1 text-center">
                                                    {account.hasOwnBudget ? (
                                                        <div className="flex items-center justify-center gap-1">
                                                            <button
                                                                onClick={() => setBatchEditAccount({ guid: account.guid, name: account.name, type: account.type })}
                                                                className="p-1.5 text-foreground-secondary hover:text-primary hover:bg-primary/10 rounded transition-colors"
                                                                title="Set all periods"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                                                </svg>
                                                            </button>
                                                            <button
                                                                onClick={() => handleEstimate(account.guid, account.type)}
                                                                className="p-1.5 text-foreground-secondary hover:text-primary hover:bg-primary/10 rounded transition-colors"
                                                                title="Estimate from history"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                                                </svg>
                                                            </button>
                                                            <button
                                                                onClick={() => handleDeleteAccount(account.guid)}
                                                                disabled={isDeleting === account.guid}
                                                                className="p-1.5 text-foreground-secondary hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors disabled:opacity-50"
                                                                title="Remove from budget"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                                </svg>
                                                            </button>
                                                        </div>
                                                    ) : showAllAccounts ? (
                                                        <button
                                                            onClick={() => handleAddToBudget(account.guid)}
                                                            className="p-1.5 text-foreground-secondary hover:text-primary hover:bg-primary/10 rounded transition-colors"
                                                            title="Add to budget"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                                            </svg>
                                                        </button>
                                                    ) : null}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot className="sticky bottom-0 z-20">
                                    {/* Income row */}
                                    <tr className="bg-background-tertiary/80 font-semibold border-t border-border">
                                        <td className="px-4 py-2 max-md:px-1.5 max-md:py-1 text-emerald-400 sticky left-0 bg-background-tertiary/80 z-30">
                                            Income
                                        </td>
                                        {incomePeriods.map((val, i) => (
                                            <td key={i} className="px-3 py-2 max-md:px-1.5 max-md:py-1 text-right font-mono text-emerald-400">
                                                {formatCurrency(val.toString(), budgetCurrency)}
                                            </td>
                                        ))}
                                        <td className="px-4 py-2 max-md:px-1.5 max-md:py-1 text-right font-mono text-emerald-400 bg-emerald-500/10">
                                            {formatCurrency(incomeTotal.toString(), budgetCurrency)}
                                        </td>
                                        <td className="px-2 py-2"></td>
                                    </tr>
                                    {/* Expense row */}
                                    <tr className="bg-background-tertiary/80 font-semibold">
                                        <td className="px-4 py-2 max-md:px-1.5 max-md:py-1 text-rose-400 sticky left-0 bg-background-tertiary/80 z-30">
                                            Expenses
                                        </td>
                                        {expensePeriods.map((val, i) => (
                                            <td key={i} className="px-3 py-2 max-md:px-1.5 max-md:py-1 text-right font-mono text-rose-400">
                                                {formatCurrency(val.toString(), budgetCurrency)}
                                            </td>
                                        ))}
                                        <td className="px-4 py-2 max-md:px-1.5 max-md:py-1 text-right font-mono text-rose-400 bg-rose-500/10">
                                            {formatCurrency(expenseTotal.toString(), budgetCurrency)}
                                        </td>
                                        <td className="px-2 py-2"></td>
                                    </tr>
                                    {/* Transfers row */}
                                    <tr className="bg-background-tertiary/80 font-semibold">
                                        <td className="px-4 py-2 max-md:px-1.5 max-md:py-1 text-foreground-secondary sticky left-0 bg-background-tertiary/80 z-30">
                                            Transfers
                                        </td>
                                        {transferPeriods.map((val, i) => (
                                            <td key={i} className="px-3 py-2 max-md:px-1.5 max-md:py-1 text-right font-mono text-foreground-secondary">
                                                {formatCurrency(val.toString(), budgetCurrency)}
                                            </td>
                                        ))}
                                        <td className="px-4 py-2 max-md:px-1.5 max-md:py-1 text-right font-mono text-foreground-secondary bg-background-tertiary/30">
                                            {formatCurrency(transferTotal.toString(), budgetCurrency)}
                                        </td>
                                        <td className="px-2 py-2"></td>
                                    </tr>
                                    {/* Remaining to Budget row */}
                                    <tr className="bg-background-tertiary font-semibold shadow-[0_-2px_10px_rgba(0,0,0,0.3)]">
                                        <td className="px-4 py-3 max-md:px-1.5 max-md:py-1 text-foreground sticky left-0 bg-background-tertiary z-30">
                                            Remaining to Budget
                                        </td>
                                        {remainingPeriods.map((val, i) => (
                                            <td key={i} className={`px-3 py-3 max-md:px-1.5 max-md:py-1 text-right font-mono ${val < 0 ? 'text-rose-400' : 'text-primary'}`}>
                                                {formatCurrency(val.toString(), budgetCurrency)}
                                            </td>
                                        ))}
                                        <td className={`px-4 py-3 max-md:px-1.5 max-md:py-1 text-right font-mono font-bold ${remainingTotal < 0 ? 'text-rose-400 bg-rose-500/10' : 'text-emerald-400 bg-emerald-500/10'}`}>
                                            {formatCurrency(remainingTotal.toString(), budgetCurrency)}
                                        </td>
                                        <td className="px-2 py-3"></td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>
                )}
            </div>
            )}

            {/* Account Picker (shared app-wide dialog) */}
            <AccountPickerDialog
                isOpen={showAccountPicker}
                onClose={() => setShowAccountPicker(false)}
                title="Add account to budget"
                accountTypes={BUDGETABLE_ACCOUNT_TYPES}
                excludeAccountGuids={existingAccountGuids}
                onSelect={async (accountGuid) => {
                    try {
                        const res = await fetch(`/api/budgets/${budget.guid}/accounts`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ account_guid: accountGuid }),
                        });
                        if (!res.ok) {
                            const data = await res.json().catch(() => ({}));
                            throw new Error(data.error || 'Failed to add account');
                        }
                        toast.success('Account added to budget');
                        await refreshBudget();
                    } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Failed to add account to budget');
                    }
                }}
            />

            {/* Batch Edit Modal */}
            {batchEditAccount && (
                <BatchEditModal
                    isOpen={!!batchEditAccount}
                    onClose={() => setBatchEditAccount(null)}
                    budgetGuid={budget.guid}
                    accountGuid={batchEditAccount.guid}
                    accountName={batchEditAccount.name}
                    accountType={batchEditAccount.type}
                    balanceReversal={balanceReversal}
                    numPeriods={budget.num_periods}
                    onUpdate={refreshBudget}
                />
            )}

            {/* Delete Account Confirmation Dialog */}
            <ConfirmationDialog
                isOpen={deleteConfirmOpen}
                onConfirm={handleDeleteConfirm}
                onCancel={() => {
                    setDeleteConfirmOpen(false);
                    setDeletingAccountGuid(null);
                }}
                title="Remove Account from Budget"
                message="Are you sure you want to remove this account from the budget? All budget amounts for this account will be deleted."
                confirmLabel="Remove"
                confirmVariant="danger"
                isLoading={isDeleting === deletingAccountGuid}
            />
        </>
    );
}
