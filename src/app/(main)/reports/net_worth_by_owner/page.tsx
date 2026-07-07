'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { MobileCard } from '@/components/ui/MobileCard';
import { ReportFilters } from '@/lib/reports/types';
import type { NetWorthByOwnerData, OwnerBucket } from '@/lib/reports/net-worth-by-owner';
import { formatCurrency } from '@/lib/format';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: null,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
    ASSET: 'Asset',
    BANK: 'Bank',
    CASH: 'Cash',
    STOCK: 'Stock',
    MUTUAL: 'Mutual Fund',
    RECEIVABLE: 'Receivable',
    LIABILITY: 'Liability',
    CREDIT: 'Credit Card',
    PAYABLE: 'Payable',
};

function Amount({ value, currency }: { value: number; currency: string }) {
    return (
        <span className={`font-mono ${value < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
            {formatCurrency(value, currency)}
        </span>
    );
}

function OwnerSummaryCard({ bucket, currency }: { bucket: OwnerBucket; currency: string }) {
    return (
        <div className="bg-surface/30 border border-border rounded-xl p-4">
            <div className="text-xs text-foreground-muted uppercase tracking-wider">{bucket.label}</div>
            <div className={`mt-1 text-xl font-bold font-mono ${bucket.netWorth < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {formatCurrency(bucket.netWorth, currency)}
            </div>
            <div className="mt-2 space-y-0.5 text-sm">
                <div className="flex justify-between gap-4">
                    <span className="text-foreground-muted">Assets</span>
                    <span className="font-mono text-foreground-secondary">{formatCurrency(bucket.totalAssets, currency)}</span>
                </div>
                <div className="flex justify-between gap-4">
                    <span className="text-foreground-muted">Liabilities</span>
                    <span className="font-mono text-foreground-secondary">{formatCurrency(bucket.totalLiabilities, currency)}</span>
                </div>
            </div>
        </div>
    );
}

function OwnerSection({ bucket, currency }: { bucket: OwnerBucket; currency: string }) {
    return (
        <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-4 px-4 sm:px-6">
                <h3 className="text-base font-semibold text-foreground">{bucket.label}</h3>
                <span className="text-sm text-foreground-muted">
                    Net worth: <Amount value={bucket.netWorth} currency={currency} />
                </span>
            </div>

            {/* Desktop table */}
            <div className="hidden md:block px-6">
                <table className="w-full">
                    <thead>
                        <tr className="border-b border-border/60 text-[11px] font-bold uppercase tracking-wider text-foreground-muted">
                            <th className="py-2 text-left">Account</th>
                            <th className="py-2 text-left">Type</th>
                            <th className="py-2 text-right">Balance</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                        {bucket.accounts.map(account => (
                            <tr key={account.guid}>
                                <td className="py-1.5 pr-4 text-sm text-foreground-secondary">{account.fullname}</td>
                                <td className="py-1.5 pr-4 text-sm text-foreground-muted whitespace-nowrap">
                                    {ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type}
                                </td>
                                <td className="py-1.5 text-right text-sm whitespace-nowrap">
                                    <Amount
                                        value={account.category === 'liability' ? -account.balance : account.balance}
                                        currency={currency}
                                    />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t border-border/60 text-sm">
                            <td className="py-2 font-semibold text-foreground" colSpan={2}>
                                Total assets / liabilities
                            </td>
                            <td className="py-2 text-right font-mono text-foreground-secondary whitespace-nowrap">
                                {formatCurrency(bucket.totalAssets, currency)} / {formatCurrency(bucket.totalLiabilities, currency)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden">
                {bucket.accounts.map(account => (
                    <MobileCard
                        key={account.guid}
                        fields={[
                            { label: 'Account', value: account.fullname },
                            { label: 'Type', value: ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type },
                            {
                                label: 'Balance',
                                value: (
                                    <Amount
                                        value={account.category === 'liability' ? -account.balance : account.balance}
                                        currency={currency}
                                    />
                                ),
                            },
                        ]}
                    />
                ))}
            </div>
        </section>
    );
}

export default function NetWorthByOwnerPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<NetWorthByOwnerData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.endDate) params.set('asOf', filters.endDate);

            const res = await fetch(`/api/reports/net-worth-by-owner?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const currency = reportData?.currency ?? 'USD';

    return (
        <ReportViewer
            title="Net Worth by Owner"
            description="Assets, liabilities, and net worth grouped by owner — joint accounts are shown as their own bucket"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
            reportData={reportData ?? undefined}
        >
            {reportData && (
                <div className="py-6 space-y-8">
                    <p className="px-4 sm:px-6 text-xs text-foreground-muted">
                        Balances as of {reportData.asOf}. Ownership comes from each account&apos;s Owner
                        preference, inherited from the nearest ancestor when unset.
                    </p>

                    {reportData.buckets.length === 0 ? (
                        <div className="px-4 sm:px-6 py-8 text-center text-foreground-secondary">
                            No balance-sheet accounts with balances found. Set an Owner on your
                            accounts (Edit Account → Owner) to populate this report.
                        </div>
                    ) : (
                        <>
                            {/* Summary cards */}
                            <div className="px-4 sm:px-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                {reportData.buckets.map(bucket => (
                                    <OwnerSummaryCard key={bucket.owner} bucket={bucket} currency={currency} />
                                ))}
                            </div>

                            {/* Household total */}
                            <div className="px-4 sm:px-6 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm border-y border-border/60 py-3">
                                <span className="font-semibold text-foreground">Household total</span>
                                <span className="text-foreground-muted">
                                    Assets <span className="font-mono text-foreground-secondary">{formatCurrency(reportData.totals.totalAssets, currency)}</span>
                                </span>
                                <span className="text-foreground-muted">
                                    Liabilities <span className="font-mono text-foreground-secondary">{formatCurrency(reportData.totals.totalLiabilities, currency)}</span>
                                </span>
                                <span className="text-foreground-muted">
                                    Net worth <Amount value={reportData.totals.netWorth} currency={currency} />
                                </span>
                            </div>

                            {/* Per-owner account detail */}
                            <div className="space-y-8">
                                {reportData.buckets.map(bucket => (
                                    <OwnerSection key={bucket.owner} bucket={bucket} currency={currency} />
                                ))}
                            </div>
                        </>
                    )}
                </div>
            )}
        </ReportViewer>
    );
}
