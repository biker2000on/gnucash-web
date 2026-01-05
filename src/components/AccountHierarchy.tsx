"use client";

import { AccountWithChildren } from '@/lib/types';
import { useState } from 'react';

function AccountNode({ account, showHidden }: { account: AccountWithChildren, showHidden: boolean }) {
    const [isExpanded, setIsExpanded] = useState(true);

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
                    <span className="text-neutral-300 font-medium truncate">{account.name}</span>
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
                        <AccountNode key={child.guid} account={child} showHidden={showHidden} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function AccountHierarchy({ accounts }: { accounts: AccountWithChildren[] }) {
    const [showHidden, setShowHidden] = useState(false);

    return (
        <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6 shadow-2xl">
            <div className="flex justify-between items-center mb-8 pb-4 border-b border-neutral-800/50">
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
            <div className="space-y-1">
                {accounts.map(acc => (
                    <AccountNode key={acc.guid} account={acc} showHidden={showHidden} />
                ))}
            </div>
        </div>
    );
}
