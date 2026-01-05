"use client";

import { Transaction } from '@/lib/types';
import { useState, useEffect, useRef, useCallback } from 'react';

export default function TransactionJournal({ initialTransactions }: { initialTransactions: Transaction[] }) {
    const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions);
    const [offset, setOffset] = useState(initialTransactions.length);
    const [hasMore, setHasMore] = useState(true);
    const [loading, setLoading] = useState(false);
    const loader = useRef<HTMLDivElement>(null);

    const fetchMoreTransactions = useCallback(async () => {
        if (loading || !hasMore) return;
        setLoading(true);

        try {
            const res = await fetch(`/api/transactions?limit=100&offset=${offset}`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data: Transaction[] = await res.json();

            if (data.length === 0) {
                setHasMore(false);
            } else {
                setTransactions(prev => [...prev, ...data]);
                setOffset(prev => prev + data.length);
            }
        } catch (error) {
            console.error('Error fetching more transactions:', error);
        } finally {
            setLoading(false);
        }
    }, [offset, loading, hasMore]);

    useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
            const target = entries[0];
            if (target.isIntersecting && hasMore) {
                fetchMoreTransactions();
            }
        }, { threshold: 0.1 });

        if (loader.current) {
            observer.observe(loader.current);
        }

        return () => observer.disconnect();
    }, [fetchMoreTransactions, hasMore]);

    return (
        <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-neutral-800 flex justify-between items-center">
                <h2 className="text-xl font-semibold text-neutral-100 flex items-center gap-2">
                    <span className="w-2 h-6 bg-cyan-500 rounded-full" />
                    Transaction Journal
                </h2>
                <span className="text-xs text-neutral-500 uppercase tracking-widest">
                    {transactions.length} Transactions Loaded
                </span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left">
                    <thead>
                        <tr className="bg-neutral-900/50 text-neutral-400 text-xs uppercase tracking-widest">
                            <th className="px-6 py-4 font-semibold">Date</th>
                            <th className="px-6 py-4 font-semibold">Description</th>
                            <th className="px-6 py-4 font-semibold text-right">Accounts & Amounts</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-800">
                        {transactions.map(tx => (
                            <tr key={tx.guid} className="hover:bg-white/[0.02] transition-colors group">
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-300 align-top">
                                    {new Date(tx.post_date).toLocaleDateString()}
                                </td>
                                <td className="px-6 py-4 text-sm text-neutral-100 align-top max-w-xs">
                                    <div className="font-medium">{tx.description}</div>
                                    {tx.num && <span className="text-xs text-neutral-500">#{tx.num}</span>}
                                </td>
                                <td className="px-6 py-4 text-sm align-top">
                                    <div className="space-y-2">
                                        {tx.splits?.map(split => (
                                            <div key={split.guid} className="flex justify-between gap-4">
                                                <span className="text-neutral-400 truncate max-w-[200px]">{split.account_name}</span>
                                                <span className={`font-mono ${parseFloat(split.value_decimal || '0') < 0
                                                        ? 'text-rose-400'
                                                        : 'text-emerald-400'
                                                    }`}>
                                                    {split.value_decimal}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {/* Loader trigger */}
                <div ref={loader} className="p-8 flex justify-center border-t border-neutral-800">
                    {loading ? (
                        <div className="flex items-center gap-3">
                            <div className="w-4 h-4 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                            <span className="text-sm text-neutral-400">Loading more transactions...</span>
                        </div>
                    ) : hasMore ? (
                        <span className="text-sm text-neutral-600 italic">Scroll for more</span>
                    ) : (
                        <span className="text-sm text-neutral-600 italic font-medium">✨ All transactions loaded</span>
                    )}
                </div>
            </div>
        </div>
    );
}
