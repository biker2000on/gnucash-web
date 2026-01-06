"use client";

import { Transaction } from '@/lib/types';
import { useState, useEffect, useRef, useCallback } from 'react';

export default function TransactionJournal({ initialTransactions }: { initialTransactions: Transaction[] }) {
    const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions);
    const [offset, setOffset] = useState(initialTransactions.length);
    const [hasMore, setHasMore] = useState(true);
    const [loading, setLoading] = useState(false);
    const [filterText, setFilterText] = useState('');
    const [debouncedFilter, setDebouncedFilter] = useState('');
    const loader = useRef<HTMLDivElement>(null);

    // Debounce filter input
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedFilter(filterText);
        }, 300);
        return () => clearTimeout(timer);
    }, [filterText]);

    // Reset and fetch when filter changes
    useEffect(() => {
        const resetAndFetch = async () => {
            setLoading(true);
            try {
                const res = await fetch(`/api/transactions?limit=100&offset=0&search=${encodeURIComponent(debouncedFilter)}`);
                if (!res.ok) throw new Error('Failed to fetch');
                const data: Transaction[] = await res.json();
                setTransactions(data);
                setOffset(data.length);
                setHasMore(data.length >= 100);
            } catch (error) {
                console.error('Error filtering transactions:', error);
            } finally {
                setLoading(false);
            }
        };

        if (debouncedFilter !== undefined) {
            resetAndFetch();
        }
    }, [debouncedFilter]);

    const fetchMoreTransactions = useCallback(async () => {
        if (loading || !hasMore) return;
        setLoading(true);

        try {
            const res = await fetch(`/api/transactions?limit=100&offset=${offset}&search=${encodeURIComponent(debouncedFilter)}`);
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
    }, [offset, loading, hasMore, debouncedFilter]);

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
            <div className="p-6 border-b border-neutral-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="flex items-center gap-3">
                    <h2 className="text-xl font-semibold text-neutral-100 flex items-center gap-2">
                        <span className="w-2 h-6 bg-cyan-500 rounded-full" />
                        General Ledger
                    </h2>
                    <span className="text-xs text-neutral-500 uppercase tracking-widest pt-1">
                        {transactions.length} Loaded
                    </span>
                </div>

                <div className="relative w-full md:w-64">
                    <input
                        type="text"
                        placeholder="Search description, # or account..."
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-2 text-sm text-neutral-200 focus:outline-none focus:border-cyan-500/50 transition-all pl-10"
                        value={filterText}
                        onChange={(e) => setFilterText(e.target.value)}
                    />
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 text-lg">
                        🔍
                    </span>
                    {filterText && (
                        <button
                            onClick={() => setFilterText('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
                        >
                            ✕
                        </button>
                    )}
                </div>
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
