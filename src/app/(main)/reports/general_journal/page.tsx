'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, GeneralJournalData } from '@/lib/reports/types';
import { JournalTable } from '@/components/reports/JournalTable';
import { downloadCSV, escapeCSVField } from '@/lib/reports/csv-export';

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
        startDate: startOfMonth.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function generateJournalCSV(data: GeneralJournalData): string {
    const rows: string[] = ['Date,Description,Num,Account,Debit,Credit,Memo'];
    for (const entry of data.entries) {
        for (const split of entry.splits) {
            rows.push([
                escapeCSVField(entry.date),
                escapeCSVField(entry.description),
                escapeCSVField(entry.num),
                escapeCSVField(split.accountPath),
                split.debit ? split.debit.toFixed(2) : '',
                split.credit ? split.credit.toFixed(2) : '',
                escapeCSVField(split.memo),
            ].join(','));
        }
    }
    rows.push('');
    rows.push(`,,,"TOTALS",${data.totalDebits.toFixed(2)},${data.totalCredits.toFixed(2)},`);
    return rows.join('\n');
}

export default function GeneralJournalPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<GeneralJournalData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (filters.accountTypes?.length) params.set('accountTypes', filters.accountTypes.join(','));

            const res = await fetch(`/api/reports/general-journal?${params}`);
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

    const handleExportCSV = () => {
        if (reportData) {
            const csv = generateJournalCSV(reportData);
            downloadCSV(csv, 'General_Journal.csv');
        }
    };

    return (
        <ReportViewer
            title="General Journal"
            description="All transactions with debit/credit detail"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
        >
            {reportData && (
                <>
                    <JournalTable data={reportData} />

                    {/* Custom CSV export button */}
                    <div className="border-t border-border p-4 flex justify-end no-print">
                        <button
                            onClick={handleExportCSV}
                            className="flex items-center gap-2 px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Export Journal CSV
                        </button>
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
