'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportTable } from '@/components/reports/ReportTable';
import { ReportFilters, ReportData } from '@/lib/reports/types';
import { formatCurrency } from '@/lib/format';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

export default function IncomeStatementPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<ReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (filters.compareToPrevious) params.set('compareToPrevious', 'true');
            if (filters.showZeroBalances) params.set('showZeroBalances', 'true');
            params.set('basis', filters.basis === 'cash' ? 'cash' : 'accrual');

            const res = await fetch(`/api/reports/income-statement?${params}`);
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

    return (
        <ReportViewer
            title="Income Statement"
            description="Revenue and expenses over a period (Profit & Loss)"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={true}
            showBasis={true}
            reportData={reportData ?? undefined}
        >
            {reportData && (
                <>
                    <ReportTable
                        sections={reportData.sections}
                        showComparison={filters.compareToPrevious}
                    />

                    {/* Net Income Summary */}
                    <div className="border-t-2 border-border-hover bg-gradient-to-r from-background-tertiary to-background-tertiary/50 p-4">
                        <div className="flex items-center justify-between">
                            <span className="text-lg font-bold text-foreground">Net Income</span>
                            <div className="flex items-center gap-4">
                                <span className={`text-xl font-mono font-bold ${
                                    (reportData.grandTotal || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                }`}>
                                    {formatCurrency(reportData.grandTotal || 0, 'USD')}
                                </span>
                                {filters.compareToPrevious && reportData.previousGrandTotal !== undefined && (
                                    <span className="text-sm text-foreground-secondary">
                                        vs {formatCurrency(reportData.previousGrandTotal, 'USD')}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Basis footnote (included in print output) */}
                    <div className="px-4 py-3 border-t border-border/50">
                        <p className="text-xs text-foreground-muted">
                            {filters.basis === 'cash'
                                ? 'Basis: Cash — invoice and bill postings (transactions touching Accounts Receivable/Payable) are excluded; invoice payments are recognized instead, allocated to income and expense accounts pro-rata by the paid invoice’s line totals.'
                                : 'Basis: Accrual — income and expenses are recognized when posted, including invoice and bill postings.'}
                        </p>
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
