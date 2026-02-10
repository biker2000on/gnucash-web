'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, InvestmentPortfolioData } from '@/lib/reports/types';
import { PortfolioTable } from '@/components/reports/PortfolioTable';
import { generatePortfolioCSV } from '@/lib/reports/csv-export';
import { downloadCSV } from '@/lib/reports/csv-export';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: null,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function InvestmentPortfolioContent() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<InvestmentPortfolioData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showZeroShares, setShowZeroShares] = useState(false);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (showZeroShares) params.set('showZeroShares', 'true');

            const res = await fetch(`/api/reports/investment-portfolio?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data: InvestmentPortfolioData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters, showZeroShares]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const handleExportCSV = () => {
        if (reportData) {
            const csv = generatePortfolioCSV(reportData);
            downloadCSV(csv, 'Investment_Portfolio.csv');
        }
    };

    return (
        <div className="space-y-6">
            {/* Zero-share toggle */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={showZeroShares}
                        onChange={(e) => setShowZeroShares(e.target.checked)}
                        className="w-4 h-4 rounded border-border bg-input-bg text-cyan-500 focus:ring-cyan-500/30 focus:ring-offset-0"
                    />
                    <span className="text-sm text-foreground">
                        Show zero-share accounts
                    </span>
                    <span className="text-xs text-foreground-tertiary">
                        (accounts where all shares have been sold)
                    </span>
                </label>
            </div>

            <ReportViewer
                title="Investment Portfolio"
                description="Holdings with market value, cost basis, and gain/loss"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {reportData && (
                    <>
                        <PortfolioTable data={reportData} />

                        {/* Custom CSV export button */}
                        <div className="border-t border-border p-4 flex justify-end no-print">
                            <button
                                onClick={handleExportCSV}
                                className="flex items-center gap-2 px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Export Portfolio CSV
                            </button>
                        </div>
                    </>
                )}
            </ReportViewer>
        </div>
    );
}

export default function InvestmentPortfolioPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-foreground-secondary">Loading...</div>}>
            <InvestmentPortfolioContent />
        </Suspense>
    );
}
