'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, ReportType, SavedReport, SavedReportInput } from '@/lib/reports/types';
import type { BudgetReportData, BudgetReportRow } from '@/lib/reports/budget-report';
import SaveReportDialog from '@/components/reports/SaveReportDialog';
import { TransactionDrilldownModal, DrilldownTarget } from '@/components/reports/TransactionDrilldownModal';
import { escapeCSVField, downloadCSV } from '@/lib/reports/csv-export';
import { formatCurrency } from '@/lib/format';

interface BudgetListItem {
    guid: string;
    name: string;
    num_periods: number;
}

function getDefaultFilters(): ReportFilters {
    return {
        startDate: null,
        endDate: null,
        compareToPrevious: false,
    };
}

function formatPct(pctUsed: number | null): string {
    return pctUsed === null ? '—' : `${pctUsed.toFixed(1)}%`;
}

function generateBudgetReportCSV(data: BudgetReportData): string {
    const rows: string[] = ['Group,Account,Budgeted,Actual,Difference,% Used'];
    const line = (group: string, row: BudgetReportRow) => [
        escapeCSVField(group),
        escapeCSVField(row.name),
        row.budgeted.toFixed(2),
        row.actual.toFixed(2),
        row.difference.toFixed(2),
        row.pctUsed === null ? '' : row.pctUsed.toFixed(1),
    ].join(',');

    for (const group of data.groups) {
        for (const row of group.rows) {
            rows.push(line(group.title, row));
        }
        rows.push(line(group.title, group.subtotal));
        rows.push('');
    }
    rows.push(line('', data.net));
    return rows.join('\n');
}

function AmountCell({ value, currency, muted }: { value: number; currency: string; muted?: boolean }) {
    return (
        <td className={`py-2 px-4 text-sm text-right font-mono ${muted ? 'text-foreground-secondary' : value < 0 ? 'text-rose-400' : 'text-foreground'}`}>
            {formatCurrency(value, currency)}
        </td>
    );
}

function BudgetReportContent() {
    const searchParams = useSearchParams();
    const savedIdParam = searchParams.get('savedId');

    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [budgets, setBudgets] = useState<BudgetListItem[] | null>(null);
    const [selectedBudgetGuid, setSelectedBudgetGuid] = useState<string | null>(null);
    const [reportData, setReportData] = useState<BudgetReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
    const [currentSavedReport, setCurrentSavedReport] = useState<SavedReport | null>(null);
    const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);

    // Load available budgets; auto-select the first when none chosen yet.
    useEffect(() => {
        fetch('/api/budgets')
            .then(res => {
                if (!res.ok) throw new Error('Failed to load budgets');
                return res.json();
            })
            .then((list: BudgetListItem[]) => {
                setBudgets(list);
                setSelectedBudgetGuid(prev => prev ?? list[0]?.guid ?? null);
                if (list.length === 0) setIsLoading(false);
            })
            .catch(() => {
                setBudgets([]);
                setIsLoading(false);
                setError('Failed to load budgets');
            });
    }, []);

    // Load saved report configuration
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
                if (typeof cfg.budgetGuid === 'string') {
                    setSelectedBudgetGuid(cfg.budgetGuid);
                }
                if (saved.filters) {
                    setFilters(saved.filters);
                }
                setCurrentSavedReport(saved);
            })
            .catch(() => {
                // silently fall back to defaults
            });
    }, [savedIdParam]);

    const fetchReport = useCallback(async () => {
        if (!selectedBudgetGuid) return;
        setIsLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams();
            params.set('budget', selectedBudgetGuid);
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/budget-report?${params}`);
            if (!res.ok) {
                throw new Error('Failed to fetch report');
            }
            const data: BudgetReportData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [filters, selectedBudgetGuid]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

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
    };

    const handleExportCSV = () => {
        if (reportData) {
            const csv = generateBudgetReportCSV(reportData);
            downloadCSV(csv, 'Budget_Report.csv');
        }
    };

    const currency = reportData?.currency ?? 'USD';
    const periods = reportData?.periods ?? [];
    const drillStartDate = periods.length > 0 ? periods[0].start : null;
    const drillEndDate = periods.length > 0 ? periods[periods.length - 1].end : null;
    const periodSummary = reportData && reportData.periods.length > 0
        ? reportData.periods.length === reportData.numPeriods
            ? `All ${reportData.numPeriods} periods (${reportData.periods[0].label} – ${reportData.periods[reportData.periods.length - 1].label})`
            : `${reportData.periods.length} of ${reportData.numPeriods} periods (${reportData.periods[0].label} – ${reportData.periods[reportData.periods.length - 1].label})`
        : null;

    return (
        <div className="space-y-6">
            {/* Budget Selection */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <span className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider">
                        Budget
                    </span>
                    <button
                        onClick={() => setIsSaveDialogOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                        </svg>
                        Save Configuration
                    </button>
                </div>
                <div className="p-4">
                    <p className="text-xs text-foreground-tertiary mb-3">
                        Pick a budget to report on. Use the date range below to limit the report to the
                        budget periods that overlap it — leave the dates empty to include every period.
                    </p>
                    {budgets !== null && budgets.length === 0 ? (
                        <p className="text-sm text-foreground-secondary">
                            No budgets found. Create a budget first to use this report.
                        </p>
                    ) : (
                        <select
                            value={selectedBudgetGuid ?? ''}
                            onChange={e => setSelectedBudgetGuid(e.target.value || null)}
                            className="w-full sm:max-w-sm bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        >
                            {(budgets ?? []).map(budget => (
                                <option key={budget.guid} value={budget.guid}>
                                    {budget.name}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
            </div>

            <ReportViewer
                title="Budget Report"
                description="Budgeted vs actual amounts per account with income and expense subtotals"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
                reportData={reportData ?? undefined}
            >
                {reportData && (
                    <>
                        {/* Report meta */}
                        <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border text-sm text-foreground-secondary">
                            <span className="font-semibold text-foreground">{reportData.budgetName}</span>
                            {periodSummary && <span className="text-xs">{periodSummary}</span>}
                        </div>

                        {reportData.groups.length === 0 ? (
                            <div className="py-8 px-4 text-center text-foreground-secondary">
                                This budget has no budgeted accounts in the selected periods.
                            </div>
                        ) : (
                            reportData.groups.map(group => (
                                <div key={group.key} className="mb-6">
                                    <div className="bg-gradient-to-r from-background-tertiary/50 to-transparent py-3 px-4 border-b border-border-hover">
                                        <h3 className="text-lg font-semibold text-foreground">{group.title}</h3>
                                    </div>
                                    <table className="w-full">
                                        <thead>
                                            <tr className="border-b border-border-hover text-foreground-secondary text-sm uppercase tracking-wider">
                                                <th className="py-2 px-4 text-left font-medium">Account</th>
                                                <th className="py-2 px-4 text-right font-medium">Budgeted</th>
                                                <th className="py-2 px-4 text-right font-medium">Actual</th>
                                                <th className="py-2 px-4 text-right font-medium">Difference</th>
                                                <th className="py-2 px-4 text-right font-medium">% Used</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border/50">
                                            {group.rows.map(row => (
                                                <tr key={row.guid} className="hover:bg-surface-hover/20 transition-colors">
                                                    <td className="py-2 px-4 text-sm text-foreground-secondary">
                                                        {row.guid && drillStartDate && drillEndDate ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => setDrilldown({
                                                                    accountGuid: row.guid,
                                                                    accountName: row.name,
                                                                    periodLabel: `${drillStartDate} → ${drillEndDate}`,
                                                                    startDate: drillStartDate,
                                                                    endDate: drillEndDate,
                                                                })}
                                                                className="text-primary hover:underline text-left focus:outline-none focus:underline"
                                                            >
                                                                {row.name}
                                                            </button>
                                                        ) : (
                                                            row.name
                                                        )}
                                                    </td>
                                                    <AmountCell value={row.budgeted} currency={currency} muted />
                                                    <AmountCell value={row.actual} currency={currency} />
                                                    <AmountCell value={row.difference} currency={currency} />
                                                    <td className="py-2 px-4 text-sm text-right font-mono text-foreground-secondary">
                                                        {formatPct(row.pctUsed)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot>
                                            <tr className="border-t-2 border-border-hover bg-background-tertiary/50">
                                                <td className="py-3 px-4 font-semibold text-foreground">
                                                    Total {group.title}
                                                </td>
                                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                                    {formatCurrency(group.subtotal.budgeted, currency)}
                                                </td>
                                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                                    {formatCurrency(group.subtotal.actual, currency)}
                                                </td>
                                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                                    {formatCurrency(group.subtotal.difference, currency)}
                                                </td>
                                                <td className="py-3 px-4 text-right font-mono font-semibold text-foreground">
                                                    {formatPct(group.subtotal.pctUsed)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            ))
                        )}

                        {/* Net summary */}
                        {reportData.groups.length > 0 && (
                            <div className="border-t-2 border-border-hover bg-gradient-to-r from-background-tertiary to-background-tertiary/50 p-4">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-lg font-bold text-foreground">Net (Income − Expenses)</span>
                                    <span className="text-sm text-foreground-secondary">
                                        Budgeted{' '}
                                        <span className="font-mono font-semibold text-foreground">
                                            {formatCurrency(reportData.net.budgeted, currency)}
                                        </span>
                                        {' '}· Actual{' '}
                                        <span className={`font-mono font-semibold ${reportData.net.actual >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {formatCurrency(reportData.net.actual, currency)}
                                        </span>
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Custom CSV export button */}
                        <div className="border-t border-border p-4 flex justify-end no-print">
                            <button
                                onClick={handleExportCSV}
                                className="flex items-center gap-2 px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Export Budget Report CSV
                            </button>
                        </div>
                    </>
                )}
            </ReportViewer>

            <SaveReportDialog
                isOpen={isSaveDialogOpen}
                onClose={() => setIsSaveDialogOpen(false)}
                onSave={handleSaveReport}
                baseReportType={ReportType.BUDGET_REPORT}
                existingReport={currentSavedReport}
                currentConfig={{
                    budgetGuid: selectedBudgetGuid,
                }}
                currentFilters={filters}
            />

            <TransactionDrilldownModal target={drilldown} onClose={() => setDrilldown(null)} />
        </div>
    );
}

export default function BudgetReportPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-foreground-secondary">Loading...</div>}>
            <BudgetReportContent />
        </Suspense>
    );
}
