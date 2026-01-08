"use client";

import { AccountWithChildren } from '@/lib/types';
import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';

type SortKey = 'name' | 'total_balance' | 'period_balance';

function AccountNode({
    account,
    showHidden,
    filterText,
    depth = 0,
    expandToDepth = Infinity,
    expandedNodes,
    setExpandedNodes
}: {
    account: AccountWithChildren;
    showHidden: boolean;
    filterText: string;
    depth?: number;
    expandToDepth?: number;
    expandedNodes: Set<string>;
    setExpandedNodes: (updater: (prev: Set<string>) => Set<string>) => void;
}) {
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
        let total = parseFloat(acc.total_balance || '0');
        let period = parseFloat(acc.period_balance || '0');

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
                className={`flex items-center gap-4 py-2 px-3 rounded-lg transition-colors cursor-pointer ${hasChildren ? 'hover:bg-neutral-800/50' : 'hover:bg-neutral-800/20'
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
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function AccountHierarchy({ accounts }: { accounts: AccountWithChildren[] }) {
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

    return (
        <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6 shadow-2xl">
            <div className="flex flex-col gap-6 mb-8 pb-4 border-b border-neutral-800/50">
                <div className="flex justify-between items-center">
                    <h2 className="text-xl font-semibold text-neutral-100 flex items-center gap-2">
                        <span className="w-2 h-6 bg-emerald-500 rounded-full" />
                        Account Assets & Liabilities
                    </h2>
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
                    />
                ))}
            </div>
        </div>
    );
}
