'use client';

import { useState, useEffect, useMemo, use, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { InlineAmountEditor } from '@/components/budget/InlineAmountEditor';
import { AccountPickerModal } from '@/components/budget/AccountPickerModal';
import { BatchEditModal } from '@/components/budget/BatchEditModal';

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
    const [budget, setBudget] = useState<Budget | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showAccountPicker, setShowAccountPicker] = useState(false);
    const [batchEditAccount, setBatchEditAccount] = useState<{ guid: string; name: string } | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set());

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
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        }
        fetchBudget();
    }, [guid]);

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

    const handleDeleteAccount = async (accountGuid: string) => {
        if (!confirm('Remove this account from the budget?')) return;

        setIsDeleting(accountGuid);
        try {
            const res = await fetch(`/api/budgets/${guid}/amounts?account_guid=${accountGuid}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                await refreshBudget();
            }
        } catch (err) {
            console.error('Error deleting account:', err);
        } finally {
            setIsDeleting(null);
        }
    };

    const handleEstimate = async (accountGuid: string) => {
        try {
            const res = await fetch(`/api/budgets/${guid}/estimate?account_guid=${accountGuid}&months=12`);
            if (!res.ok) throw new Error('Failed to get estimate');
            const data = await res.json();

            // Apply estimate to all periods
            const applyRes = await fetch(`/api/budgets/${guid}/amounts/all-periods`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account_guid: accountGuid,
                    amount: data.average
                })
            });

            if (applyRes.ok) {
                await refreshBudget();
            }
        } catch (err) {
            console.error('Error applying estimate:', err);
            alert('Failed to apply estimate');
        }
    };

    const handleAmountUpdate = (accountGuid: string, periodNum: number, newValue: number) => {
        if (!budget) return;

        // Optimistic update
        setBudget(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                amounts: prev.amounts.map(amt =>
                    amt.account_guid === accountGuid && amt.period_num === periodNum
                        ? { ...amt, amount_decimal: newValue.toString() }
                        : amt
                )
            };
        });
    };

    const handleAccountAdded = async () => {
        await refreshBudget();
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
        const allGuids = new Set(budget.amounts.map(a => a.account_parent_guid).filter((g): g is string => g !== null));
        setExpandedNodes(allGuids);
    }, [budget]);

    const collapseAll = useCallback(() => {
        setExpandedNodes(new Set());
    }, []);

    // Build hierarchical tree structure from flat amounts
    const { treeData, flattenedNodes, periodTotals, grandTotal } = useMemo(() => {
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
                });
            }
        }

        // Build tree nodes
        const nodeMap = new Map<string, AccountNode>();
        const budgetedGuids = new Set(accountMap.keys());

        // Create nodes for all budgeted accounts
        for (const [guid, data] of accountMap) {
            nodeMap.set(guid, {
                ...data,
                rolledUpTotal: data.ownTotal,
                rolledUpPeriods: new Map(data.periods),
                children: [],
                depth: 0,
                hasOwnBudget: true,
            });
        }

        // Also add parent nodes that aren't budgeted themselves but have budgeted children
        // We need to collect parent chain for each budgeted account
        const parentChains = new Map<string, string[]>();
        for (const [guid, data] of accountMap) {
            if (data.parentGuid && !budgetedGuids.has(data.parentGuid)) {
                // This parent isn't budgeted, we'd need to fetch it
                // For now, we'll just show the flat list if parent info is missing
            }
        }

        // Build parent-child relationships and find roots
        const roots: AccountNode[] = [];
        for (const [guid, node] of nodeMap) {
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
                if (period >= 1 && period <= budget.num_periods) {
                    totals[period - 1] += value;
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
    }, [budget, expandedNodes]);

    const existingAccountGuids = useMemo(() =>
        flattenedNodes.map(a => a.guid),
        [flattenedNodes]
    );

    const getPeriodLabel = (num: number, index: number) => {
        if (num === 12) {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            return months[index];
        }
        if (num === 4) {
            return `Q${index + 1}`;
        }
        return `P${index + 1}`;
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="flex items-center gap-4">
                    <Link
                        href="/budgets"
                        className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <div className="h-8 w-48 bg-neutral-800 rounded animate-pulse" />
                </div>
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                        <span className="text-neutral-400">Loading budget...</span>
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
                        className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </Link>
                    <h1 className="text-3xl font-bold text-neutral-100">Budget Not Found</h1>
                </div>
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 text-center">
                    <div className="text-rose-400">{error || 'Budget not found'}</div>
                    <Link
                        href="/budgets"
                        className="inline-block mt-4 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg transition-colors"
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
                <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/budgets"
                            className="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                        </Link>
                        <div>
                            <h1 className="text-3xl font-bold text-neutral-100">{budget.name}</h1>
                            {budget.description && (
                                <p className="text-neutral-500">{budget.description}</p>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                            {budget.num_periods === 12 ? 'Monthly' : budget.num_periods === 4 ? 'Quarterly' : `${budget.num_periods} Periods`}
                        </span>
                        <span className="text-neutral-500 text-sm">
                            {flattenedNodes.length} accounts
                        </span>
                        <button
                            onClick={() => setShowAccountPicker(true)}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            Add Account
                        </button>
                    </div>
                </header>

                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6">
                        <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Total Budget</div>
                        <div className="text-2xl font-bold text-emerald-400">
                            {formatCurrency(grandTotal.toString(), 'USD')}
                        </div>
                    </div>
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6">
                        <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Average per Period</div>
                        <div className="text-2xl font-bold text-cyan-400">
                            {formatCurrency((grandTotal / budget.num_periods).toString(), 'USD')}
                        </div>
                    </div>
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6">
                        <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Budgeted Accounts</div>
                        <div className="text-2xl font-bold text-neutral-200">{flattenedNodes.length}</div>
                    </div>
                </div>
            </div>

            {/* Budget Table - Full Width */}
            <div>
                {flattenedNodes.length === 0 ? (
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-12 text-center">
                        <svg className="w-16 h-16 mx-auto text-neutral-700 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        <h3 className="text-lg font-medium text-neutral-300 mb-2">No Budget Allocations</h3>
                        <p className="text-neutral-500 mb-4">
                            This budget has no account allocations yet.
                        </p>
                        <button
                            onClick={() => setShowAccountPicker(true)}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            Add Your First Account
                        </button>
                    </div>
                ) : (
                    <div className="bg-neutral-900/30 backdrop-blur-xl border-y border-neutral-800 overflow-hidden">
                        {/* Expand/Collapse Controls */}
                        <div className="px-4 py-2 bg-neutral-900/50 border-b border-neutral-800 flex items-center gap-2">
                            <button
                                onClick={expandAll}
                                className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 rounded hover:bg-neutral-800 transition-colors"
                            >
                                Expand All
                            </button>
                            <button
                                onClick={collapseAll}
                                className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 rounded hover:bg-neutral-800 transition-colors"
                            >
                                Collapse All
                            </button>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="sticky top-0 z-20">
                                    <tr className="bg-neutral-900 text-neutral-400 text-xs uppercase tracking-widest shadow-md">
                                        <th className="px-4 py-3 text-left font-semibold sticky left-0 bg-neutral-900 z-30 min-w-[250px]">Account</th>
                                        {Array.from({ length: budget.num_periods }, (_, i) => (
                                            <th key={i} className="px-3 py-3 text-right font-semibold min-w-[90px]">
                                                {getPeriodLabel(budget.num_periods, i)}
                                            </th>
                                        ))}
                                        <th className="px-4 py-3 text-right font-semibold bg-neutral-800/50 min-w-[100px]">Total</th>
                                        <th className="px-3 py-3 text-center font-semibold min-w-[120px]">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-neutral-800/50">
                                    {flattenedNodes.map(account => {
                                        const hasChildren = account.children.length > 0;
                                        const isExpanded = expandedNodes.has(account.guid);
                                        const showRolledUp = hasChildren && !account.hasOwnBudget;
                                        const displayTotal = showRolledUp ? account.rolledUpTotal : account.ownTotal;
                                        const displayPeriods = showRolledUp ? account.rolledUpPeriods : account.periods;

                                        return (
                                            <tr key={account.guid} className="hover:bg-white/[0.02] transition-colors">
                                                <td className="px-4 py-3 font-medium text-neutral-200 sticky left-0 bg-neutral-950/90 backdrop-blur-sm z-10">
                                                    <div
                                                        className="flex items-center gap-2"
                                                        style={{ paddingLeft: `${account.depth * 20}px` }}
                                                    >
                                                        {hasChildren ? (
                                                            <button
                                                                onClick={() => toggleExpanded(account.guid)}
                                                                className="p-0.5 rounded hover:bg-neutral-700 transition-colors"
                                                            >
                                                                <svg
                                                                    className={`w-4 h-4 text-neutral-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
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
                                                                className="hover:text-cyan-400 transition-colors"
                                                            >
                                                                {account.name}
                                                            </Link>
                                                            <div className="text-xs text-neutral-500">
                                                                {account.type}
                                                                {showRolledUp && (
                                                                    <span className="ml-2 text-cyan-600">(subtotal)</span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                {Array.from({ length: budget.num_periods }, (_, i) => {
                                                    const value = displayPeriods.get(i + 1) || 0;
                                                    const ownValue = account.periods.get(i + 1) || 0;

                                                    // Only show editor for accounts with their own budget
                                                    if (account.hasOwnBudget) {
                                                        return (
                                                            <td key={i} className="px-1 py-1">
                                                                <InlineAmountEditor
                                                                    value={ownValue}
                                                                    budgetGuid={budget.guid}
                                                                    accountGuid={account.guid}
                                                                    periodNum={i + 1}
                                                                    currency={account.mnemonic}
                                                                    accountType={account.type}
                                                                    balanceReversal={balanceReversal}
                                                                    onUpdate={(newValue) => handleAmountUpdate(account.guid, i + 1, newValue)}
                                                                />
                                                            </td>
                                                        );
                                                    } else {
                                                        // Show rolled up value (read-only)
                                                        const displayValue = applyBalanceReversal(value, account.type, balanceReversal);
                                                        return (
                                                            <td key={i} className={`px-2 py-1 text-right font-mono text-sm ${displayValue < 0 ? 'text-rose-400' : 'text-cyan-600'}`}>
                                                                {value === 0 ? '—' : formatCurrency(displayValue, account.mnemonic)}
                                                            </td>
                                                        );
                                                    }
                                                })}
                                                <td className={`px-4 py-3 text-right font-mono font-semibold bg-neutral-800/30 ${applyBalanceReversal(displayTotal, account.type, balanceReversal) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                                    {formatCurrency(applyBalanceReversal(displayTotal, account.type, balanceReversal), account.mnemonic)}
                                                </td>
                                                <td className="px-2 py-2 text-center">
                                                    {account.hasOwnBudget && (
                                                        <div className="flex items-center justify-center gap-1">
                                                            <button
                                                                onClick={() => setBatchEditAccount({ guid: account.guid, name: account.name })}
                                                                className="p-1.5 text-neutral-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors"
                                                                title="Set all periods"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                                                </svg>
                                                            </button>
                                                            <button
                                                                onClick={() => handleEstimate(account.guid)}
                                                                className="p-1.5 text-neutral-400 hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
                                                                title="Estimate from history"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                                                </svg>
                                                            </button>
                                                            <button
                                                                onClick={() => handleDeleteAccount(account.guid)}
                                                                disabled={isDeleting === account.guid}
                                                                className="p-1.5 text-neutral-400 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors disabled:opacity-50"
                                                                title="Remove from budget"
                                                            >
                                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                                </svg>
                                                            </button>
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot className="sticky bottom-0 z-20">
                                    <tr className="bg-neutral-800 font-semibold shadow-[0_-2px_10px_rgba(0,0,0,0.3)]">
                                        <td className="px-4 py-3 text-neutral-200 sticky left-0 bg-neutral-800 z-30">
                                            Total
                                        </td>
                                        {periodTotals.map((total, i) => (
                                            <td key={i} className="px-3 py-3 text-right font-mono text-cyan-400">
                                                {formatCurrency(total.toString(), 'USD')}
                                            </td>
                                        ))}
                                        <td className="px-4 py-3 text-right font-mono text-emerald-400 bg-emerald-500/10">
                                            {formatCurrency(grandTotal.toString(), 'USD')}
                                        </td>
                                        <td className="px-2 py-3"></td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>
                )}
            </div>

            {/* Account Picker Modal */}
            <AccountPickerModal
                isOpen={showAccountPicker}
                onClose={() => setShowAccountPicker(false)}
                budgetGuid={budget.guid}
                existingAccountGuids={existingAccountGuids}
                onAccountAdded={handleAccountAdded}
            />

            {/* Batch Edit Modal */}
            {batchEditAccount && (
                <BatchEditModal
                    isOpen={!!batchEditAccount}
                    onClose={() => setBatchEditAccount(null)}
                    budgetGuid={budget.guid}
                    accountGuid={batchEditAccount.guid}
                    accountName={batchEditAccount.name}
                    numPeriods={budget.num_periods}
                    onUpdate={refreshBudget}
                />
            )}
        </>
    );
}
