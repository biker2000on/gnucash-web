'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, TreasurerReportData, SavedReport, SavedReportInput, ReportType } from '@/lib/reports/types';
import { TreasurerReport } from '@/components/reports/TreasurerReport';
import { downloadCSV, escapeCSVField } from '@/lib/reports/csv-export';
import { AccountPicker } from '@/components/reports/AccountPicker';
import SaveReportDialog from '@/components/reports/SaveReportDialog';

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

function TreasurerReportContent() {
    const searchParams = useSearchParams();
    const savedIdParam = searchParams.get('savedId');

    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<TreasurerReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [config, setConfig] = useState<TreasurerConfig>({ organization: '', roleName: 'Treasurer', personName: '' });
    const [configOpen, setConfigOpen] = useState(false);

    // New state for saved report integration
    const [selectedAccountGuids, setSelectedAccountGuids] = useState<string[]>([]);
    const [savedReportId, setSavedReportId] = useState<number | null>(savedIdParam ? parseInt(savedIdParam, 10) : null);
    const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
    const [currentSavedReport, setCurrentSavedReport] = useState<SavedReport | null>(null);
    const [migrationBanner, setMigrationBanner] = useState(false);

    // Load saved config from DB when savedId is present
    useEffect(() => {
        if (!savedIdParam) return;
        const id = parseInt(savedIdParam, 10);
        if (isNaN(id)) return;

        fetch(`/api/reports/saved/${id}`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to load saved report');
                return res.json();
            })
            .then((saved: SavedReport) => {
                const cfg = saved.config as Record<string, unknown>;
                setConfig({
                    organization: (cfg.organization as string) || '',
                    roleName: (cfg.roleName as string) || 'Treasurer',
                    personName: (cfg.personName as string) || '',
                });
                if (Array.isArray(cfg.accountGuids)) {
                    setSelectedAccountGuids(cfg.accountGuids as string[]);
                }
                if (saved.filters) {
                    setFilters(saved.filters);
                }
                setCurrentSavedReport(saved);
                setSavedReportId(saved.id);
            })
            .catch(() => {
                // silently fall back to defaults
            });
    }, [savedIdParam]);

    // localStorage migration - runs once on mount
    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (savedIdParam) return; // don't migrate if loading a saved report

        const stored = localStorage.getItem('treasurer-report-config');
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                setConfig({
                    organization: parsed.organization || '',
                    roleName: parsed.roleName || 'Treasurer',
                    personName: parsed.personName || '',
                });
                setMigrationBanner(true);
                localStorage.removeItem('treasurer-report-config');
            } catch {
                // ignore bad JSON
            }
        }
    }, [savedIdParam]);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);
            if (selectedAccountGuids.length > 0) {
                params.set('accountGuids', selectedAccountGuids.join(','));
            }

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
    }, [filters, selectedAccountGuids]);

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

    const handleSaveReport = async (input: SavedReportInput) => {
        const url = currentSavedReport
            ? `/api/reports/saved/${currentSavedReport.id}`
            : '/api/reports/saved';
        const method = currentSavedReport ? 'PUT' : 'POST';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error('Failed to save');
        const saved = await res.json();
        setCurrentSavedReport(saved);
        setSavedReportId(saved.id);
    };

    return (
        <div className="space-y-6">
            {/* Migration Banner */}
            {migrationBanner && (
                <div className="flex items-center justify-between px-4 py-3 bg-cyan-500/10 border border-cyan-500/30 rounded-lg text-sm text-cyan-400">
                    <span>Previous configuration loaded. Click &quot;Save Configuration&quot; to keep it permanently.</span>
                    <button onClick={() => setMigrationBanner(false)} className="ml-2 text-cyan-400/60 hover:text-cyan-400">&times;</button>
                </div>
            )}

            {/* Config Section */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                <div className="flex items-center">
                    <button
                        onClick={() => setConfigOpen(!configOpen)}
                        className="flex-1 flex items-center justify-between p-4 text-left hover:bg-surface-hover/30 transition-colors"
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
                    <button
                        onClick={() => setIsSaveDialogOpen(true)}
                        className="mr-4 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                        </svg>
                        Save Configuration
                    </button>
                </div>
                {configOpen && (
                    <div className="px-4 pb-4 space-y-4">
                        <div className="grid gap-4 sm:grid-cols-3">
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

                        {/* Account Selection */}
                        <div>
                            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-1">
                                Account Selection
                            </label>
                            <p className="text-xs text-foreground-tertiary mb-2">
                                By default, all Asset, Bank, and Cash accounts are included. Select specific accounts below to customize.
                            </p>
                            <AccountPicker
                                selectedGuids={selectedAccountGuids}
                                onChange={setSelectedAccountGuids}
                                allowedAccountTypes={['ASSET', 'BANK', 'CASH', 'CHECKING', 'SAVINGS']}
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

            <SaveReportDialog
                isOpen={isSaveDialogOpen}
                onClose={() => setIsSaveDialogOpen(false)}
                onSave={handleSaveReport}
                baseReportType={'treasurer' as ReportType}
                existingReport={currentSavedReport}
                currentConfig={{
                    organization: config.organization,
                    roleName: config.roleName,
                    personName: config.personName,
                    accountGuids: selectedAccountGuids,
                }}
                currentFilters={filters}
            />
        </div>
    );
}

export default function TreasurerReportPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-foreground-secondary">Loading...</div>}>
            <TreasurerReportContent />
        </Suspense>
    );
}
