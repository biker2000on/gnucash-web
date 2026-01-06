"use client";

import { AccountWithChildren } from '@/lib/types';
import { useState, useMemo, useEffect } from 'react';

type SortKey = 'name' | 'total_balance' | 'period_balance';

function AccountNode({ account, showHidden, filterText }: { account: AccountWithChildren, showHidden: boolean, filterText: string }) {
    const [isExpanded, setIsExpanded] = useState(true);

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

    return (
        <div className="ml-4">
            <div
                className={`flex items-center gap-4 py-2 px-3 rounded-lg transition-colors cursor-pointer ${hasChildren ? 'hover:bg-neutral-800/50' : 'hover:bg-neutral-800/20'
                    } ${account.hidden ? 'opacity-50 grayscale' : ''}`}
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    {hasChildren && (
                        <span className={`text-[10px] transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                            ▶
                        </span>
                    )}
                    <span className={`text-neutral-300 font-medium truncate ${filterText && account.name.toLowerCase().includes(filterText.toLowerCase()) ? 'text-emerald-400 underline underline-offset-4 decoration-emerald-500/50' : ''}`}>
                        {account.name}
                    </span>
                    {account.hidden === 1 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500 border border-neutral-700">
                            HIDDEN
                        </span>
                    )}
                </div>

                <div className="flex gap-6 text-right shrink-0">
                    <div className="flex flex-col">
                        <span className="text-[10px] text-neutral-500 uppercase tracking-tighter">Period</span>
                        <span className={`font-mono text-sm ${aggPeriod < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {aggPeriod.toFixed(2)}
                        </span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[10px] text-neutral-500 uppercase tracking-tighter">Total</span>
                        <span className={`font-mono text-sm font-bold ${aggTotal < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {aggTotal.toFixed(2)}
                        </span>
                    </div>
                </div>
            </div>
            {isExpanded && hasChildren && (
                <div className="border-l border-neutral-800/50 ml-5 mt-1">
                    {account.children.map(child => (
                        <AccountNode key={child.guid} account={child} showHidden={showHidden} filterText={filterText} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function AccountHierarchy({ accounts }: { accounts: AccountWithChildren[] }) {
    const [showHidden, setShowHidden] = useState(false);
    const [filterText, setFilterText] = useState('');
    const [sortKey, setSortKey] = useState<SortKey>('name');

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
                    />
                ))}
            </div>
        </div>
    );
}
