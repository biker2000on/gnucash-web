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

export default function CashFlowPage() {
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

            const res = await fetch(`/api/reports/cash-flow?${params}`);
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

    // Calculate net change in cash
    const netCashChange = reportData?.sections.reduce((sum, section) => sum + section.total, 0) || 0;

    return (
        <ReportViewer
            title="Cash Flow Statement"
            description="Cash inflows and outflows by activity"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={true}
        >
            {reportData && (
                <>
                    <ReportTable
                        sections={reportData.sections}
                        showComparison={filters.compareToPrevious}
                    />

                    {/* Net Cash Change Summary */}
                    <div className="border-t-2 border-neutral-600 bg-gradient-to-r from-neutral-800 to-neutral-800/50 p-4">
                        <div className="flex items-center justify-between">
                            <span className="text-lg font-bold text-neutral-100">Net Change in Cash</span>
                            <span className={`text-xl font-mono font-bold ${
                                netCashChange >= 0 ? 'text-emerald-400' : 'text-rose-400'
                            }`}>
                                {formatCurrency(netCashChange, 'USD')}
                            </span>
                        </div>
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
