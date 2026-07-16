'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { MobileCard } from '@/components/ui/MobileCard';
import { ReportFilters } from '@/lib/reports/types';
import type {
    MemberSpendingData,
    MemberSpendingBucket,
    MemberSpendingCategory,
} from '@/lib/reports/member-spending';
import { formatCurrency } from '@/lib/format';
import { TransactionDrilldownModal, DrilldownTarget } from '@/components/reports/TransactionDrilldownModal';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function Amount({ value, currency }: { value: number; currency: string }) {
    return (
        <span className={`font-mono ${value < 0 ? 'text-emerald-400' : 'text-foreground'}`}>
            {formatCurrency(value, currency)}
        </span>
    );
}

function MemberSummaryCard({
    bucket,
    currency,
    householdTotal,
}: {
    bucket: MemberSpendingBucket;
    currency: string;
    householdTotal: number;
}) {
    const share = householdTotal > 0 ? Math.round((bucket.total / householdTotal) * 100) : 0;
    return (
        <div className="bg-surface/30 border border-border rounded-xl p-4">
            <div className="text-xs text-foreground-muted uppercase tracking-wider">{bucket.label}</div>
            <div className="mt-1 text-xl font-bold font-mono text-foreground">
                {formatCurrency(bucket.total, currency)}
            </div>
            <div className="mt-2 text-sm text-foreground-muted">
                {share}% of household spending · {bucket.categories.length}{' '}
                categor{bucket.categories.length === 1 ? 'y' : 'ies'}
            </div>
        </div>
    );
}

function MemberSection({
    bucket,
    currency,
    onCategoryClick,
}: {
    bucket: MemberSpendingBucket;
    currency: string;
    onCategoryClick: (category: MemberSpendingCategory) => void;
}) {
    return (
        <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-4 px-4 sm:px-6">
                <h3 className="text-base font-semibold text-foreground">{bucket.label}</h3>
                <span className="text-sm text-foreground-muted">
                    Total: <span className="font-mono text-foreground">{formatCurrency(bucket.total, currency)}</span>
                </span>
            </div>

            {/* Desktop table */}
            <div className="hidden md:block px-6">
                <table className="w-full">
                    <thead>
                        <tr className="border-b border-border/60 text-[11px] font-bold uppercase tracking-wider text-foreground-muted">
                            <th className="py-2 text-left">Category</th>
                            <th className="py-2 text-right">Amount</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                        {bucket.categories.map(category => (
                            <tr key={category.guid}>
                                <td className="py-1.5 pr-4 text-sm text-foreground-secondary">
                                    <button
                                        type="button"
                                        onClick={() => onCategoryClick(category)}
                                        className="text-primary hover:underline text-left focus:outline-none focus:underline"
                                    >
                                        {category.name}
                                    </button>
                                </td>
                                <td className="py-1.5 text-right text-sm whitespace-nowrap">
                                    <Amount value={category.amount} currency={currency} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t border-border/60 text-sm">
                            <td className="py-2 font-semibold text-foreground">Total</td>
                            <td className="py-2 text-right font-mono text-foreground whitespace-nowrap">
                                {formatCurrency(bucket.total, currency)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden">
                {bucket.categories.map(category => (
                    <MobileCard
                        key={category.guid}
                        fields={[
                            {
                                label: 'Category',
                                value: (
                                    <button
                                        type="button"
                                        onClick={() => onCategoryClick(category)}
                                        className="text-primary hover:underline text-left focus:outline-none focus:underline"
                                    >
                                        {category.name}
                                    </button>
                                ),
                            },
                            {
                                label: 'Amount',
                                value: <Amount value={category.amount} currency={currency} />,
                            },
                        ]}
                    />
                ))}
            </div>
        </section>
    );
}

/** How-to box: giving a kid (or any member) their own spending space. */
function AllowanceGuide() {
    return (
        <aside className="mx-4 sm:mx-6 border border-border rounded-lg bg-surface/30 p-4 no-print">
            <h3 className="text-sm font-semibold text-foreground">
                Tracking a kid&apos;s allowance?
            </h3>
            <p className="mt-1 text-xs text-foreground-secondary leading-relaxed">
                Two ways that work well:
            </p>
            <ul className="mt-2 space-y-1.5 text-xs text-foreground-secondary leading-relaxed list-disc pl-4">
                <li>
                    <span className="font-medium text-foreground">Their own sub-book.</span>{' '}
                    Create a separate book for the kid and invite them with the{' '}
                    <span className="font-mono">edit</span> role scoped to that book — they record
                    their own spending without touching the household books. Manage invitations
                    under{' '}
                    <Link href="/settings/users" className="text-primary hover:underline">
                        Settings → Users
                    </Link>
                    .
                </li>
                <li>
                    <span className="font-medium text-foreground">An envelope account.</span>{' '}
                    Add an asset account like{' '}
                    <span className="font-mono">Assets:Allowances:Alex</span>, fund it with the
                    weekly allowance transfer, and pay their expenses from it. Set the
                    account&apos;s Owner preference (Edit Account → Owner) so this report keeps
                    their spending in its own bucket.
                </li>
            </ul>
        </aside>
    );
}

export default function MemberSpendingPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<MemberSpendingData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/member-spending?${params}`);
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

    const handleCategoryClick = useCallback(
        (category: MemberSpendingCategory) => {
            const defaults = getDefaultFilters();
            const startDate = filters.startDate ?? reportData?.startDate ?? defaults.startDate!;
            const endDate = filters.endDate ?? reportData?.endDate ?? defaults.endDate!;
            setDrilldown({
                accountGuid: category.guid,
                accountName: category.name,
                periodLabel: `${startDate} – ${endDate}`,
                startDate,
                endDate,
            });
        },
        [filters.startDate, filters.endDate, reportData?.startDate, reportData?.endDate],
    );

    return (
        <ReportViewer
            title="Spending by Member"
            description="Who spent what: period expenses attributed to the household member whose account funded them"
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
                        Expenses from {reportData.startDate} to {reportData.endDate}, attributed by the
                        owner of the funding account (the bank or card side of each transaction).
                        Mixed-owner and explicitly joint accounts land in Joint; funding accounts with
                        no Owner preference land in Unassigned. Refunds reduce the member&apos;s total.
                    </p>

                    {reportData.buckets.length === 0 ? (
                        <div className="px-4 sm:px-6 py-8 text-center text-foreground-secondary">
                            No expense transactions found in this period. Set an Owner on your bank
                            and credit-card accounts (Edit Account → Owner) to split spending by
                            member instead of everything landing in Unassigned.
                        </div>
                    ) : (
                        <>
                            {/* Summary cards */}
                            <div className="px-4 sm:px-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                {reportData.buckets.map(bucket => (
                                    <MemberSummaryCard
                                        key={bucket.owner}
                                        bucket={bucket}
                                        currency={currency}
                                        householdTotal={reportData.totals.total}
                                    />
                                ))}
                            </div>

                            {/* Household total */}
                            <div className="px-4 sm:px-6 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm border-y border-border/60 py-3">
                                <span className="font-semibold text-foreground">Household total</span>
                                <span className="text-foreground-muted">
                                    Spending{' '}
                                    <span className="font-mono text-foreground">
                                        {formatCurrency(reportData.totals.total, currency)}
                                    </span>
                                </span>
                            </div>

                            {/* Per-member category detail */}
                            <div className="space-y-8">
                                {reportData.buckets.map(bucket => (
                                    <MemberSection
                                        key={bucket.owner}
                                        bucket={bucket}
                                        currency={currency}
                                        onCategoryClick={handleCategoryClick}
                                    />
                                ))}
                            </div>
                        </>
                    )}

                    <AllowanceGuide />
                </div>
            )}
            <TransactionDrilldownModal target={drilldown} onClose={() => setDrilldown(null)} />
        </ReportViewer>
    );
}
