"use client";

import { AccountWithChildren } from '@/lib/types';
import { useState, useMemo, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency, applyBalanceReversal, BalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { Modal } from './ui/Modal';
import { AccountForm } from './AccountForm';

type SortKey = 'name' | 'total_balance' | 'period_balance';

interface AccountNodeProps {
    account: AccountWithChildren;
    showHidden: boolean;
    filterText: string;
    depth?: number;
    expandToDepth?: number;
    expandedNodes: Set<string>;
    setExpandedNodes: (updater: (prev: Set<string>) => Set<string>) => void;
    onEdit?: (account: AccountWithChildren) => void;
    onDelete?: (account: AccountWithChildren) => void;
    onNewChild?: (parent: AccountWithChildren) => void;
    balanceReversal: BalanceReversal;
}

function AccountNode({
    account,
    showHidden,
    filterText,
    depth = 0,
    expandToDepth = Infinity,
    expandedNodes,
    setExpandedNodes,
    onEdit,
    onDelete,
    onNewChild,
    balanceReversal,
}: AccountNodeProps) {
    // Determine initial expansion state
    // Priority: 1) User manually expanded/collapsed, 2) Global depth setting
    const hasUserPreference = expandedNodes.has(account.guid);
    const initialExpanded = hasUserPreference ? expandedNodes.has(account.guid) : (depth < expandToDepth);
    const [isExpanded, setIsExpanded] = useState(initialExpanded);
    const [hasManualToggle, setHasManualToggle] = useState(hasUserPreference);

    // Recursive search check: does this node or any child match the filter?
    const hasMatch = (acc: AccountWithChildren): boolean => {
        if (acc.name.toLowerCase().includes(filterText.toLowerCase())) return true;
        return acc.children.some(child => (showHidden || !child.hidden) && hasMatch(child));
    };

    const matches = filterText ? hasMatch(account) : true;

    // Auto-expand if there's a match inside and search is active
    useEffect(() => {
        if (filterText && matches) {
            setIsExpanded(true);
        }
    }, [filterText, matches]);

    // Update expansion state when global expandToDepth changes
    // But only if the user hasn't manually toggled this node
    useEffect(() => {
        if (!hasManualToggle) {
            setIsExpanded(depth < expandToDepth);
        }
    }, [expandToDepth, depth, hasManualToggle]);

    if (!matches) return null;
    if (account.hidden && !showHidden) return null;

    const hasChildren = account.children.length > 0;

    // Recursive balance calculation for children that are visible
    const getAggregatedBalances = (acc: AccountWithChildren): { total: number, period: number } => {
        // Apply balance reversal to this account's balances based on its type
        let total = applyBalanceReversal(
            parseFloat(acc.total_balance || '0'),
            acc.account_type,
            balanceReversal
        );
        let period = applyBalanceReversal(
            parseFloat(acc.period_balance || '0'),
            acc.account_type,
            balanceReversal
        );

        acc.children.forEach(child => {
            if (!child.hidden || showHidden) {
                const childBal = getAggregatedBalances(child);
                total += childBal.total;
                period += childBal.period;
            }
        });

        return { total, period };
    };

    const { total: aggTotal, period: aggPeriod } = getAggregatedBalances(account);

    const handleToggle = () => {
        const newExpanded = !isExpanded;
        setIsExpanded(newExpanded);
        setHasManualToggle(true); // Mark that user has manually toggled this node
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (newExpanded) {
                next.add(account.guid);
            } else {
                next.delete(account.guid);
            }
            return next;
        });
    };

    return (
        <div className="ml-4">
            <div
                className={`group flex items-center gap-4 py-2 px-3 rounded-lg transition-colors cursor-pointer ${hasChildren ? 'hover:bg-neutral-800/50' : 'hover:bg-neutral-800/20'
                    } ${account.hidden ? 'opacity-50 grayscale' : ''}`}
                onClick={handleToggle}
            >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    {hasChildren && (
                        <span className={`text-[10px] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                            ▶
                        </span>
                    )}
                    <Link
                        href={`/accounts/${account.guid}`}
                        className={`text-neutral-300 font-medium truncate hover:text-emerald-400 transition-colors ${filterText && account.name.toLowerCase().includes(filterText.toLowerCase()) ? 'text-emerald-400 underline underline-offset-4 decoration-emerald-500/50' : ''}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {account.name}
                    </Link>
                    <Link
                        href={`/accounts/${account.guid}`}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-neutral-700 rounded text-neutral-500 hover:text-emerald-400 ml-1"
                        title="View Ledger"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                        </svg>
                    </Link>
                    {account.hidden === 1 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500 border border-neutral-700 ml-2">
                            HIDDEN
                        </span>
                    )}

                    {/* Action buttons - visible on hover */}
                    <div className="opacity-0 group-hover:opacity-100 flex gap-1 ml-2 transition-opacity">
                        {onNewChild && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onNewChild(account); }}
                                className="p-1 rounded hover:bg-emerald-500/20 text-neutral-500 hover:text-emerald-400 transition-colors"
                                title="Add Child Account"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                            </button>
                        )}
                        {onEdit && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onEdit(account); }}
                                className="p-1 rounded hover:bg-cyan-500/20 text-neutral-500 hover:text-cyan-400 transition-colors"
                                title="Edit Account"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                            </button>
                        )}
                        {onDelete && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onDelete(account); }}
                                className="p-1 rounded hover:bg-rose-500/20 text-neutral-500 hover:text-rose-400 transition-colors"
                                title="Delete Account"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                            </button>
                        )}
                    </div>
                </div>

                <div className="flex gap-6 text-right shrink-0">
                    <div className="flex flex-col">
                        <span className="text-[10px] text-neutral-500 uppercase tracking-tighter">Period</span>
                        <span className={`font-mono text-sm ${aggPeriod < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {formatCurrency(aggPeriod, account.commodity_mnemonic)}
                        </span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[10px] text-neutral-500 uppercase tracking-tighter">Total</span>
                        <span className={`font-mono text-sm font-bold ${aggTotal < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {formatCurrency(aggTotal, account.commodity_mnemonic)}
                        </span>
                    </div>
                </div>
            </div>
            {isExpanded && hasChildren && (
                <div className="border-l border-neutral-800/50 ml-5 mt-1">
                    {account.children.map(child => (
                        <AccountNode
                            key={child.guid}
                            account={child}
                            showHidden={showHidden}
                            filterText={filterText}
                            depth={depth + 1}
                            expandToDepth={expandToDepth}
                            expandedNodes={expandedNodes}
                            setExpandedNodes={setExpandedNodes}
                            onEdit={onEdit}
                            onDelete={onDelete}
                            onNewChild={onNewChild}
                            balanceReversal={balanceReversal}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

interface AccountHierarchyProps {
    accounts: AccountWithChildren[];
    onRefresh?: () => void;
}

export default function AccountHierarchy({ accounts, onRefresh }: AccountHierarchyProps) {
    const { balanceReversal } = useUserPreferences();

    // Initialize state from localStorage with fallback defaults
    const [showHidden, setShowHidden] = useState(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('accountHierarchy.showHidden');
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
            return saved ? (saved === 'Infinity' ? Infinity : parseInt(saved)) : Infinity;
        }
        return Infinity;
    });

    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('accountHierarchy.expandedNodes');
            return saved ? new Set(JSON.parse(saved)) : new Set();
        }
        return new Set();
    });

    // Modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
    const [selectedAccount, setSelectedAccount] = useState<AccountWithChildren | null>(null);
    const [parentGuid, setParentGuid] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<AccountWithChildren | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    // Persist state changes to localStorage
    useEffect(() => {
        localStorage.setItem('accountHierarchy.showHidden', JSON.stringify(showHidden));
    }, [showHidden]);

    useEffect(() => {
        localStorage.setItem('accountHierarchy.sortKey', sortKey);
    }, [sortKey]);

    useEffect(() => {
        localStorage.setItem('accountHierarchy.expandToDepth', expandToDepth === Infinity ? 'Infinity' : expandToDepth.toString());
    }, [expandToDepth]);

    useEffect(() => {
        localStorage.setItem('accountHierarchy.expandedNodes', JSON.stringify(Array.from(expandedNodes)));
    }, [expandedNodes]);

    const sortTree = (accs: AccountWithChildren[]): AccountWithChildren[] => {
        return [...accs].sort((a, b) => {
            if (sortKey === 'name') return a.name.localeCompare(b.name);
            if (sortKey === 'total_balance') return parseFloat(b.total_balance || '0') - parseFloat(a.total_balance || '0');
            if (sortKey === 'period_balance') return parseFloat(b.period_balance || '0') - parseFloat(a.period_balance || '0');
            return 0;
        }).map(acc => ({
            ...acc,
            children: sortTree(acc.children)
        }));
    };

    const sortedAccounts = useMemo(() => sortTree(accounts), [accounts, sortKey]);

    // Account CRUD handlers
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

    const handleEdit = useCallback((account: AccountWithChildren) => {
        setSelectedAccount(account);
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
            onRefresh?.();
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Failed to delete account');
        } finally {
            setDeleting(false);
        }
    }, [deleteConfirm, onRefresh]);

    const handleSave = useCallback(async (data: {
        name: string;
        account_type: string;
        parent_guid: string | null;
        commodity_guid: string;
        code: string;
        description: string;
        hidden: number;
        placeholder: number;
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
        onRefresh?.();
    }, [modalMode, selectedAccount, onRefresh]);

    return (
        <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6 shadow-2xl">
            <div className="flex flex-col gap-6 mb-8 pb-4 border-b border-neutral-800/50">
                <div className="flex justify-between items-center">
                    <h2 className="text-xl font-semibold text-neutral-100 flex items-center gap-2">
                        <span className="w-2 h-6 bg-emerald-500 rounded-full" />
                        Account Assets & Liabilities
                    </h2>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={handleNewAccount}
                            className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            New Account
                        </button>
                        <div className="flex items-center gap-3">
                            <span className="text-sm text-neutral-400">Show Hidden</span>
                            <button
                                onClick={() => setShowHidden(!showHidden)}
                                className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out ${showHidden ? 'bg-emerald-500' : 'bg-neutral-700'
                                    }`}
                            >
                                <div className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out ${showHidden ? 'translate-x-6' : 'translate-x-0'
                                    }`} />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col md:flex-row gap-4">
                    <div className="relative flex-1">
                        <input
                            type="text"
                            placeholder="Filter accounts..."
                            className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all"
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                        />
                        {filterText && (
                            <button
                                onClick={() => setFilterText('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
                            >
                                ✕
                            </button>
                        )}
                    </div>

                    {/* Tree Expansion Controls */}
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-neutral-500 uppercase tracking-widest font-bold">Expand</span>
                        <div className="flex gap-1">
                            <button
                                onClick={() => {
                                    setExpandToDepth(0);
                                    setExpandedNodes(new Set()); // Clear manual toggles
                                }}
                                className="bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 hover:border-emerald-500/50 transition-all"
                                title="Collapse All"
                            >
                                Collapse All
                            </button>
                            <button
                                onClick={() => {
                                    setExpandToDepth(Infinity);
                                    setExpandedNodes(new Set()); // Clear manual toggles
                                }}
                                className="bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 hover:border-emerald-500/50 transition-all"
                                title="Expand All"
                            >
                                Expand All
                            </button>
                        </div>
                        <select
                            className="bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                            value={expandToDepth === Infinity ? 'all' : expandToDepth}
                            onChange={(e) => {
                                setExpandToDepth(e.target.value === 'all' ? Infinity : parseInt(e.target.value));
                                setExpandedNodes(new Set()); // Clear manual toggles
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
                        <span className="text-xs text-neutral-500 uppercase tracking-widest font-bold">Sort By</span>
                        <select
                            className="bg-neutral-950/50 border border-neutral-800 rounded-xl px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 transition-all cursor-pointer"
                            value={sortKey}
                            onChange={(e) => setSortKey(e.target.value as SortKey)}
                        >
                            <option value="name">Name</option>
                            <option value="total_balance">Total Balance</option>
                            <option value="period_balance">Period Balance</option>
                        </select>
                    </div>
                </div>
            </div>

            <div className="space-y-1 overflow-x-hidden">
                {sortedAccounts.map(acc => (
                    <AccountNode
                        key={acc.guid}
                        account={acc}
                        showHidden={showHidden}
                        filterText={filterText}
                        depth={0}
                        expandToDepth={expandToDepth}
                        expandedNodes={expandedNodes}
                        setExpandedNodes={setExpandedNodes}
                        onEdit={handleEdit}
                        onDelete={handleDeleteConfirm}
                        onNewChild={handleNewChild}
                        balanceReversal={balanceReversal}
                    />
                ))}
            </div>

            {/* Account Form Modal */}
            <Modal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                title={modalMode === 'create' ? 'Create Account' : 'Edit Account'}
                size="lg"
            >
                <div className="p-6">
                    <AccountForm
                        mode={modalMode}
                        initialData={selectedAccount ? {
                            name: selectedAccount.name,
                            account_type: selectedAccount.account_type,
                            parent_guid: selectedAccount.parent_guid,
                            commodity_guid: selectedAccount.commodity_guid,
                            code: selectedAccount.code,
                            description: selectedAccount.description,
                            hidden: selectedAccount.hidden,
                            placeholder: selectedAccount.placeholder,
                        } : undefined}
                        parentGuid={parentGuid}
                        onSave={handleSave}
                        onCancel={() => setModalOpen(false)}
                    />
                </div>
            </Modal>

            {/* Delete Confirmation Modal */}
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
                    <p className="text-neutral-300">
                        Are you sure you want to delete <strong className="text-neutral-100">{deleteConfirm?.name}</strong>?
                    </p>
                    <p className="text-sm text-neutral-500">
                        This action cannot be undone. Accounts with transactions cannot be deleted.
                    </p>
                    <div className="flex justify-end gap-3 pt-4">
                        <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
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
