'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, TreasurerReportData } from '@/lib/reports/types';
import { TreasurerReport } from '@/components/reports/TreasurerReport';
import { downloadCSV, escapeCSVField } from '@/lib/reports/csv-export';

interface TreasurerConfig {
    organization: string;
    roleName: string;
    personName: string;
}

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function getInitialConfig(): TreasurerConfig {
    if (typeof window === 'undefined') {
        return { organization: '', roleName: 'Treasurer', personName: '' };
    }
    const saved = localStorage.getItem('treasurer-report-config');
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch {
            // ignore bad JSON
        }
    }
    return { organization: '', roleName: 'Treasurer', personName: '' };
}

function treasurerReportToCSV(data: TreasurerReportData): string {
    const rows: string[] = [];

    // Header info
    rows.push('Treasurer\'s Report');
    if (data.header.organization) {
        rows.push(`Organization,${escapeCSVField(data.header.organization)}`);
    }
    if (data.header.personName) {
        rows.push(`Prepared by,${escapeCSVField(data.header.personName)}${data.header.roleName ? ' (' + data.header.roleName + ')' : ''}`);
    }
    rows.push(`Period,${data.header.periodStart} to ${data.header.periodEnd}`);
    rows.push(`Report Date,${data.header.reportDate}`);
    rows.push('');

    // Opening Balance
    rows.push('OPENING BALANCE');
    rows.push('Account Name,Balance');
    for (const acct of data.openingBalance.accounts) {
        rows.push(`${escapeCSVField(acct.name)},${acct.balance.toFixed(2)}`);
    }
    rows.push(`Total Opening Balance,${data.openingBalance.total.toFixed(2)}`);
    rows.push('');

    // Income Summary
    rows.push('INCOME SUMMARY');
    rows.push('Date,Description,Category,Amount');
    for (const tx of data.incomeSummary.transactions) {
        rows.push(`${tx.date},${escapeCSVField(tx.description)},${escapeCSVField(tx.category)},${tx.amount.toFixed(2)}`);
    }
    rows.push(`,,Total Income,${data.incomeSummary.total.toFixed(2)}`);
    rows.push('');

    // Expense Summary
    rows.push('EXPENSE SUMMARY');
    rows.push('Date,Description,Category,Amount');
    for (const tx of data.expenseSummary.transactions) {
        rows.push(`${tx.date},${escapeCSVField(tx.description)},${escapeCSVField(tx.category)},${tx.amount.toFixed(2)}`);
    }
    rows.push(`,,Total Expenses,${data.expenseSummary.total.toFixed(2)}`);
    rows.push('');

    // Closing Balance
    rows.push('CLOSING BALANCE');
    rows.push('Account Name,Balance');
    for (const acct of data.closingBalance.accounts) {
        rows.push(`${escapeCSVField(acct.name)},${acct.balance.toFixed(2)}`);
    }
    rows.push(`Total Closing Balance,${data.closingBalance.total.toFixed(2)}`);
    rows.push('');

    // Verification
    rows.push('BALANCE VERIFICATION');
    rows.push(`Opening Balance,${data.openingBalance.total.toFixed(2)}`);
    rows.push(`+ Total Income,${data.incomeSummary.total.toFixed(2)}`);
    rows.push(`- Total Expenses,${data.expenseSummary.total.toFixed(2)}`);
    const expected = Math.round((data.openingBalance.total + data.incomeSummary.total - data.expenseSummary.total) * 100) / 100;
    rows.push(`= Expected Closing,${expected.toFixed(2)}`);
    rows.push(`Actual Closing,${data.closingBalance.total.toFixed(2)}`);

    return rows.join('\n');
}

export default function TreasurerReportPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<TreasurerReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [config, setConfig] = useState<TreasurerConfig>(getInitialConfig);
    const [configOpen, setConfigOpen] = useState(false);

    // Auto-save config to localStorage
    useEffect(() => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('treasurer-report-config', JSON.stringify(config));
        }
    }, [config]);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/treasurer?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data: TreasurerReportData = await res.json();
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

    // Apply client-side config to reportData (doesn't trigger refetch)
    const displayData = reportData ? {
        ...reportData,
        header: {
            ...reportData.header,
            organization: config.organization,
            roleName: config.roleName,
            personName: config.personName,
        }
    } : null;

    const handleExportCSV = () => {
        if (displayData) {
            const csv = treasurerReportToCSV(displayData);
            downloadCSV(csv, 'Treasurers_Report.csv');
        }
    };

    return (
        <div className="space-y-6">
            {/* Config Section */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                <button
                    onClick={() => setConfigOpen(!configOpen)}
                    className="w-full flex items-center justify-between p-4 text-left hover:bg-surface-hover/30 transition-colors"
                >
                    <span className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider">
                        Report Header Configuration
                    </span>
                    <svg
                        className={`w-4 h-4 text-foreground-secondary transition-transform ${configOpen ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
                {configOpen && (
                    <div className="px-4 pb-4 grid gap-4 sm:grid-cols-3">
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Organization Name
                            </label>
                            <input
                                type="text"
                                value={config.organization}
                                onChange={e => setConfig(prev => ({ ...prev, organization: e.target.value }))}
                                placeholder="e.g., My Organization"
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Person Name
                            </label>
                            <input
                                type="text"
                                value={config.personName}
                                onChange={e => setConfig(prev => ({ ...prev, personName: e.target.value }))}
                                placeholder="e.g., John Smith"
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Role
                            </label>
                            <input
                                type="text"
                                value={config.roleName}
                                onChange={e => setConfig(prev => ({ ...prev, roleName: e.target.value }))}
                                placeholder="e.g., Treasurer"
                                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                            />
                        </div>
                    </div>
                )}
            </div>

            <ReportViewer
                title="Treasurer's Report"
                description="Monthly treasurer report with opening/closing balances, income and expense detail"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {displayData && (
                    <>
                        <TreasurerReport data={displayData} />

                        {/* Custom CSV export button */}
                        <div className="border-t border-border p-4 flex justify-end no-print">
                            <button
                                onClick={handleExportCSV}
                                className="flex items-center gap-2 px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Export Treasurer CSV
                            </button>
                        </div>
                    </>
                )}
            </ReportViewer>
        </div>
    );
}
