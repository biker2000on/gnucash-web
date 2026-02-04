'use client';

import { Suspense } from 'react';
import AccountHierarchy from '@/components/AccountHierarchy';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { useDateFilter } from '@/hooks/useDateFilter';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { AccountWithChildren } from '@/lib/types';

function AccountsContent() {
    const { startDate, endDate, setDateFilter, isInitialized } = useDateFilter();

    // Use React Query hook with date filtering
    const { data, isLoading, error } = useAccounts({
        flat: false,
        startDate: isInitialized ? startDate : undefined,
        endDate: isInitialized ? endDate : undefined,
    });

    // Type assertion since we know flat=false returns AccountWithChildren[]
    const accounts = (data || []) as AccountWithChildren[];

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

            {isLoading ? (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                        <span className="text-neutral-400">Loading accounts...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="text-rose-400">{error instanceof Error ? error.message : 'An error occurred'}</div>
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
