'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import AccountHierarchy from '@/components/AccountHierarchy';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { useDateFilter } from '@/hooks/useDateFilter';
import { AccountWithChildren } from '@/lib/types';

function AccountsContent() {
    const { startDate, endDate, setDateFilter, isInitialized } = useDateFilter();
    const [accounts, setAccounts] = useState<AccountWithChildren[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isInitialized) return;

        async function fetchAccounts() {
            setLoading(true);
            setError(null);
            try {
                const params = new URLSearchParams();
                if (startDate) params.set('startDate', startDate);
                if (endDate) params.set('endDate', endDate);

                const url = `/api/accounts${params.toString() ? `?${params.toString()}` : ''}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error('Failed to fetch accounts');
                const data = await res.json();
                setAccounts(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        }

        fetchAccounts();
    }, [startDate, endDate, isInitialized]);

    return (
        <div className="space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-neutral-100">Accounts</h1>
                    <p className="text-neutral-500">Explore your GnuCash account structure.</p>
                </div>
                <DateRangePicker
                    startDate={startDate}
                    endDate={endDate}
                    onChange={setDateFilter}
                />
            </header>

            {loading ? (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                        <span className="text-neutral-400">Loading accounts...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="text-rose-400">{error}</div>
                </div>
            ) : (
                <AccountHierarchy accounts={accounts} />
            )}
        </div>
    );
}

export default function AccountsPage() {
    return (
        <Suspense fallback={
            <div className="space-y-6">
                <header>
                    <h1 className="text-3xl font-bold text-neutral-100">Accounts</h1>
                    <p className="text-neutral-500">Explore your GnuCash account structure.</p>
                </header>
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                        <span className="text-neutral-400">Loading...</span>
                    </div>
                </div>
            </div>
        }>
            <AccountsContent />
        </Suspense>
    );
}
