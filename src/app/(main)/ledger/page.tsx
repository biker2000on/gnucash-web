'use client';

import { useEffect, useState, Suspense } from 'react';
import TransactionJournal from '@/components/TransactionJournal';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { useDateFilter } from '@/hooks/useDateFilter';
import { Transaction } from '@/lib/types';

function LedgerContent() {
    const { startDate, endDate, setDateFilter, isInitialized } = useDateFilter();
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isInitialized) return;

        async function fetchTransactions() {
            setLoading(true);
            setError(null);
            try {
                const params = new URLSearchParams();
                params.set('limit', '150');
                params.set('offset', '0');
                if (startDate) params.set('startDate', startDate);
                if (endDate) params.set('endDate', endDate);

                const res = await fetch(`/api/transactions?${params.toString()}`);
                if (!res.ok) throw new Error('Failed to fetch transactions');
                const data = await res.json();
                setTransactions(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        }

        fetchTransactions();
    }, [startDate, endDate, isInitialized]);

    return (
        <div className="space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">General Ledger</h1>
                    <p className="text-foreground-muted">View transactions and their splits across all accounts.</p>
                </div>
                <DateRangePicker
                    startDate={startDate}
                    endDate={endDate}
                    onChange={setDateFilter}
                />
            </header>

            {loading ? (
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading transactions...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-surface/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="text-rose-400">{error}</div>
                </div>
            ) : (
                <TransactionJournal
                    initialTransactions={transactions}
                    startDate={startDate}
                    endDate={endDate}
                />
            )}
        </div>
    );
}

export default function LedgerPage() {
    return (
        <Suspense fallback={
            <div className="space-y-6">
                <header>
                    <h1 className="text-3xl font-bold text-foreground">General Ledger</h1>
                    <p className="text-foreground-muted">View transactions and their splits across all accounts.</p>
                </header>
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            </div>
        }>
            <LedgerContent />
        </Suspense>
    );
}
