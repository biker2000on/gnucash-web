"use client";

import { Transaction, Split } from '@/lib/types';
import { useState, useEffect, useRef, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';

export interface AccountTransaction extends Transaction {
    running_balance: string;
    account_split_value: string;
    commodity_mnemonic: string;
}

interface AccountLedgerProps {
    accountGuid: string;
    initialTransactions: AccountTransaction[];
    startDate?: string | null;
    endDate?: string | null;
}

export default function AccountLedger({
    accountGuid,
    initialTransactions,
    startDate,
    endDate
}: AccountLedgerProps) {
    const [transactions, setTransactions] = useState<AccountTransaction[]>(initialTransactions);
    const [offset, setOffset] = useState(initialTransactions.length);
    const [hasMore, setHasMore] = useState(initialTransactions.length >= 100);
    const [loading, setLoading] = useState(false);
    const [expandedTxs, setExpandedTxs] = useState<Record<string, boolean>>({});
    const loader = useRef<HTMLDivElement>(null);

    // Reset when initialTransactions change (e.g., date filter changed)
    useEffect(() => {
        setTransactions(initialTransactions);
        setOffset(initialTransactions.length);
        setHasMore(initialTransactions.length >= 100);
    }, [initialTransactions]);

    const toggleExpand = (guid: string) => {
        setExpandedTxs(prev => ({ ...prev, [guid]: !prev[guid] }));
    };

    // Build URL params helper
    const buildUrlParams = useCallback((extraParams: Record<string, string | number> = {}) => {
        const params = new URLSearchParams();
        params.set('limit', '100');
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        Object.entries(extraParams).forEach(([key, value]) => {
            params.set(key, String(value));
        });
        return params.toString();
    }, [startDate, endDate]);

    const fetchMoreTransactions = useCallback(async () => {
        if (loading || !hasMore) return;
        setLoading(true);

        try {
            const params = buildUrlParams({ offset });
            const res = await fetch(`/api/accounts/${accountGuid}/transactions?${params}`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data: AccountTransaction[] = await res.json();

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

    return (
        <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-neutral-900/50 text-neutral-400 text-[10px] uppercase tracking-[0.2em] font-bold">
                            <th className="px-6 py-4">Date</th>
                            <th className="px-6 py-4">Description</th>
                            <th className="px-6 py-4">Transfer / Splits</th>
                            <th className="px-6 py-4 text-right">Amount</th>
                            <th className="px-6 py-4 text-right">Balance</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-800/50">
                        {transactions.map(tx => {
                            const isMultiSplit = (tx.splits?.length || 0) > 2;
                            const isExpanded = expandedTxs[tx.guid];
                            const otherSplits = tx.splits?.filter(s => s.account_guid !== accountGuid) || [];
                            const amount = parseFloat(tx.account_split_value);

                            return (
                                <tr key={tx.guid} className="hover:bg-white/[0.02] transition-colors group">
                                    <td className="px-6 py-4 whitespace-nowrap text-xs text-neutral-400 align-top font-mono">
                                        {new Date(tx.post_date).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4 text-sm text-neutral-100 align-top">
                                        <div className="font-medium">{tx.description}</div>
                                        {tx.num && <span className="text-[10px] text-neutral-500 font-mono">#{tx.num}</span>}
                                    </td>
                                    <td className="px-6 py-4 text-sm align-top">
                                        {isMultiSplit && !isExpanded ? (
                                            <button
                                                onClick={() => toggleExpand(tx.guid)}
                                                className="text-neutral-500 hover:text-cyan-400 transition-colors flex items-center gap-1 italic text-xs"
                                            >
                                                <span>-- Multiple Splits --</span>
                                                <span className="text-[10px]">▼</span>
                                            </button>
                                        ) : (
                                            <div className="space-y-1">
                                                {otherSplits.map((split, idx) => (
                                                    <div key={split.guid} className="flex justify-between items-center text-xs">
                                                        <span className="text-neutral-400 truncate max-w-[180px]">
                                                            {split.account_name}
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
                                                        ▲ Show less
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    <td className={`px-6 py-4 text-sm font-mono text-right align-top ${amount < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                        {formatCurrency(tx.account_split_value, tx.commodity_mnemonic)}
                                    </td>
                                    <td className={`px-6 py-4 text-sm font-mono text-right align-top font-bold ${parseFloat(tx.running_balance) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                        {formatCurrency(tx.running_balance, tx.commodity_mnemonic)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                <div ref={loader} className="p-8 flex justify-center border-t border-neutral-800/50">
                    {loading ? (
                        <div className="flex items-center gap-3">
                            <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                            <span className="text-xs text-neutral-500 uppercase tracking-widest">Updating Ledger...</span>
                        </div>
                    ) : hasMore ? (
                        <span className="text-xs text-neutral-600 uppercase tracking-widest animate-pulse">Scroll for history</span>
                    ) : (
                        <span className="text-xs text-neutral-600 uppercase tracking-widest font-bold">End of Records</span>
                    )}
                </div>
            </div>
        </div>
    );
}
