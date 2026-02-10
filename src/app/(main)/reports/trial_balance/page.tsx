'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { TrialBalanceTable } from '@/components/reports/TrialBalanceTable';
import { ReportFilters, TrialBalanceData } from '@/lib/reports/types';
import { generateTrialBalanceCSV } from '@/lib/reports/csv-export';
import { downloadCSV } from '@/lib/reports/csv-export';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

export default function TrialBalancePage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<TrialBalanceData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (filters.showZeroBalances) params.set('showZeroBalances', 'true');

            const res = await fetch(`/api/reports/trial-balance?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data: TrialBalanceData = await res.json();
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

    const handleExportCSV = () => {
        if (reportData) {
            const csv = generateTrialBalanceCSV(reportData);
            downloadCSV(csv, 'Trial_Balance.csv');
        }
    };

    return (
        <ReportViewer
            title="Trial Balance"
            description="Debit and credit balances for all accounts at a point in time"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
        >
            {reportData && (
                <>
                    <TrialBalanceTable data={reportData} />

                    {/* Custom CSV export button */}
                    <div className="border-t border-border p-4 flex justify-end no-print">
                        <button
                            onClick={handleExportCSV}
                            className="flex items-center gap-2 px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Export Trial Balance CSV
                        </button>
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
