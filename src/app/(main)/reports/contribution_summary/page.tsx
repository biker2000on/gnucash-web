'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, ContributionSummaryData } from '@/lib/reports/types';
import { ContributionTable } from '@/components/reports/ContributionTable';
import { formatCurrency } from '@/lib/format';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function ContributionSummaryContent() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<ContributionSummaryData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [groupBy, setGroupBy] = useState<'calendar_year' | 'tax_year'>('calendar_year');

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            params.set('groupBy', groupBy);

            // Fetch birthday for catch-up limit calculation
            try {
                const prefRes = await fetch('/api/user/preferences?key=birthday');
                if (prefRes.ok) {
                    const prefData = await prefRes.json();
                    if (prefData.preferences?.birthday) {
                        params.set('birthday', prefData.preferences.birthday);
                    }
                }
            } catch {
                // Birthday is optional; proceed without it
            }

            const res = await fetch(`/api/reports/contribution-summary?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch contribution summary');
            }
            const data: ContributionSummaryData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters, groupBy]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const handleTaxYearChange = async (splitGuid: string, newYear: number) => {
        try {
            const res = await fetch(`/api/contributions/${splitGuid}/tax-year`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taxYear: newYear }),
            });
            if (!res.ok) {
                throw new Error('Failed to update tax year');
            }
            // Refetch report to reflect changes
            await fetchReport();
        } catch (err) {
            console.error('Failed to update tax year:', err);
        }
    };

    return (
        <div className="space-y-6">
            {/* Group-by toggle */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4 flex items-center gap-4">
                <span className="text-sm text-foreground-secondary">Group by:</span>
                <div className="inline-flex rounded-lg border border-border overflow-hidden">
                    <button
                        onClick={() => setGroupBy('calendar_year')}
                        className={`px-4 py-1.5 text-sm transition-colors ${
                            groupBy === 'calendar_year'
                                ? 'bg-cyan-600 text-white'
                                : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
                        }`}
                    >
                        Calendar Year
                    </button>
                    <button
                        onClick={() => setGroupBy('tax_year')}
                        className={`px-4 py-1.5 text-sm transition-colors ${
                            groupBy === 'tax_year'
                                ? 'bg-cyan-600 text-white'
                                : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
                        }`}
                    >
                        Tax Year
                    </button>
                </div>
            </div>

            <ReportViewer
                title="Contribution Summary"
                description="Retirement and brokerage account contributions with IRS limit tracking"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {reportData && (
                    <>
                        {reportData.periods.length === 0 ? (
                            /* Empty state */
                            <div className="p-12 text-center">
                                <div className="text-foreground-tertiary text-lg mb-2">
                                    No retirement accounts configured
                                </div>
                                <p className="text-foreground-tertiary text-sm max-w-md mx-auto">
                                    To track contributions, flag your retirement accounts with the appropriate
                                    account type (e.g., 401k, IRA) in your account settings.
                                </p>
                            </div>
                        ) : (
                            <div className="p-6 space-y-8">
                                {/* Summary cards */}
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                    <div className="bg-background-tertiary/50 rounded-xl p-4 border border-border/50">
                                        <div className="text-xs text-foreground-tertiary mb-1">Total Contributions</div>
                                        <div className="text-2xl font-bold text-green-400">
                                            {formatCurrency(reportData.grandTotalContributions)}
                                        </div>
                                    </div>
                                    <div className="bg-background-tertiary/50 rounded-xl p-4 border border-border/50">
                                        <div className="text-xs text-foreground-tertiary mb-1">Employer Match</div>
                                        <div className="text-2xl font-bold text-cyan-400">
                                            {formatCurrency(reportData.grandTotalEmployerMatch)}
                                        </div>
                                    </div>
                                    <div className="bg-background-tertiary/50 rounded-xl p-4 border border-border/50">
                                        <div className="text-xs text-foreground-tertiary mb-1">Net Contributions</div>
                                        <div className="text-2xl font-bold text-foreground">
                                            {formatCurrency(reportData.grandTotalNetContributions)}
                                        </div>
                                    </div>
                                </div>

                                {/* Per-year sections */}
                                {reportData.periods.map((period) => (
                                    <div key={period.year} className="space-y-4">
                                        <div className="flex items-center justify-between border-b border-border pb-2">
                                            <h2 className="text-lg font-semibold text-foreground">
                                                {period.year}
                                            </h2>
                                            <div className="flex items-center gap-4 text-xs text-foreground-secondary">
                                                <span>
                                                    Contributions: <span className="text-green-400">{formatCurrency(period.totalContributions)}</span>
                                                </span>
                                                {period.totalEmployerMatch !== 0 && (
                                                    <span>
                                                        Employer: <span className="text-cyan-400">{formatCurrency(period.totalEmployerMatch)}</span>
                                                    </span>
                                                )}
                                                <span>
                                                    Net: <span className="text-foreground font-medium">{formatCurrency(period.totalNetContributions)}</span>
                                                </span>
                                            </div>
                                        </div>
                                        <ContributionTable
                                            accounts={period.accounts}
                                            year={period.year}
                                            onTaxYearChange={handleTaxYearChange}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </ReportViewer>
        </div>
    );
}

export default function ContributionSummaryPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-foreground-secondary">Loading...</div>}>
            <ContributionSummaryContent />
        </Suspense>
    );
}
