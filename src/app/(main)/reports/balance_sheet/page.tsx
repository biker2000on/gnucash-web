'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportTable } from '@/components/reports/ReportTable';
import { ReportFilters, ReportData } from '@/lib/reports/types';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

export default function BalanceSheetPage() {
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

            const res = await fetch(`/api/reports/balance-sheet?${params}`);
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
            title="Balance Sheet"
            description="Assets, liabilities, and equity at a point in time"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={true}
            reportData={reportData ?? undefined}
        >
            {reportData && (
                <ReportTable
                    sections={reportData.sections}
                    showComparison={filters.compareToPrevious}
                />
            )}
        </ReportViewer>
    );
}
