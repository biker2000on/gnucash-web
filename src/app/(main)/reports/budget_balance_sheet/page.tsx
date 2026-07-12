'use client';

import { useState, useEffect, useCallback } from 'react';
import type {
    BudgetBalanceSheetData,
    BudgetBalanceSheetSection,
    BudgetBalanceSheetRow,
    BalanceSheetPair,
} from '@/lib/reports/budget-statements';
import { escapeCSVField, downloadCSV } from '@/lib/reports/csv-export';
import { formatCurrency } from '@/lib/format';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface BudgetListItem {
    guid: string;
    name: string;
    num_periods: number;
}

function generateBalanceSheetCSV(data: BudgetBalanceSheetData): string {
    const rows: string[] = ['Section,Account,Budgeted,Actual,Difference'];
    const line = (section: string, name: string, pair: BalanceSheetPair, depth = 0) => [
        escapeCSVField(section),
        escapeCSVField('  '.repeat(depth) + name),
        pair.budgeted.toFixed(2),
        pair.actual.toFixed(2),
        pair.difference.toFixed(2),
    ].join(',');

    for (const section of [data.assets, data.liabilities, data.equity]) {
        for (const row of section.rows) {
            rows.push(line(section.title, row.name, row, row.depth));
        }
        rows.push(line(section.title, `Total ${section.title}`, section.total));
        rows.push('');
    }
    rows.push(line('', 'Liabilities + Equity', data.totals.liabilitiesAndEquity));
    rows.push(line('', 'Check (Assets − L−E)', data.totals.check));
    return rows.join('\n');
}

function SheetSection({
    section,
    currency,
}: {
    section: BudgetBalanceSheetSection;
    currency: string;
}) {
    const cellBase = 'py-1.5 px-4 text-sm text-right font-mono';
    const renderRow = (row: BudgetBalanceSheetRow) => (
        <tr key={row.guid} className={`hover:bg-surface-hover/40 transition-colors ${row.isSynthetic ? 'italic' : ''}`}>
            <td
                className={`py-1.5 px-4 text-sm ${row.isSubtotal ? 'font-semibold text-foreground' : 'text-foreground-secondary'}`}
                style={{ paddingLeft: `${16 + row.depth * 20}px` }}
            >
                {row.name}
            </td>
            <td className={`${cellBase} text-foreground-secondary ${row.isSubtotal ? 'font-semibold' : ''}`} style={TNUM}>
                {formatCurrency(row.budgeted, currency)}
            </td>
            <td className={`${cellBase} text-foreground ${row.isSubtotal ? 'font-semibold' : ''}`} style={TNUM}>
                {formatCurrency(row.actual, currency)}
            </td>
            <td className={`${cellBase} ${row.isSubtotal ? 'font-semibold' : ''}`} style={TNUM}>
                <span className={row.difference > 0 ? 'text-positive' : row.difference < 0 ? 'text-negative' : 'text-foreground-secondary'}>
                    {formatCurrency(row.difference, currency)}
                </span>
            </td>
        </tr>
    );

    return (
        <div className="mb-6">
            <div className="bg-background-tertiary py-2.5 px-4 border-b border-border-hover">
                <h3 className="text-base font-semibold text-foreground">{section.title}</h3>
            </div>
            <table className="w-full">
                <thead>
                    <tr className="border-b border-border-hover text-foreground-secondary text-xs uppercase tracking-wider">
                        <th className="py-2 px-4 text-left font-medium">Account</th>
                        <th className="py-2 px-4 text-right font-medium">Budgeted</th>
                        <th className="py-2 px-4 text-right font-medium">Actual Basis</th>
                        <th className="py-2 px-4 text-right font-medium">Difference</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                    {section.rows.length === 0 ? (
                        <tr>
                            <td colSpan={4} className="py-4 px-4 text-center text-sm text-foreground-muted">
                                No {section.title.toLowerCase()} accounts with balances.
                            </td>
                        </tr>
                    ) : (
                        section.rows.map(renderRow)
                    )}
                </tbody>
                <tfoot>
                    <tr className="border-t-2 border-border-hover bg-background-tertiary">
                        <td className="py-2.5 px-4 font-semibold text-foreground">Total {section.title}</td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-foreground" style={TNUM}>
                            {formatCurrency(section.total.budgeted, currency)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-foreground" style={TNUM}>
                            {formatCurrency(section.total.actual, currency)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-foreground" style={TNUM}>
                            {formatCurrency(section.total.difference, currency)}
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

export default function BudgetBalanceSheetPage() {
    const [budgets, setBudgets] = useState<BudgetListItem[] | null>(null);
    const [selectedBudgetGuid, setSelectedBudgetGuid] = useState<string | null>(null);
    /** null = default (budget's last period) until the first response arrives */
    const [periodIndex, setPeriodIndex] = useState<number | null>(null);

    const [reportData, setReportData] = useState<BudgetBalanceSheetData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

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

    const fetchReport = useCallback(async () => {
        if (!selectedBudgetGuid) return;
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set('budget', selectedBudgetGuid);
            if (periodIndex !== null) params.set('period', String(periodIndex));
            const res = await fetch(`/api/reports/budget-balance-sheet?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            setReportData(await res.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [selectedBudgetGuid, periodIndex]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const handleExportCSV = () => {
        if (reportData) {
            downloadCSV(generateBalanceSheetCSV(reportData), 'Budget_Balance_Sheet.csv');
        }
    };

    const currency = reportData?.currency ?? 'USD';
    const selectClass =
        'bg-input-bg border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50';

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Budget Balance Sheet</h1>
                <p className="text-foreground-muted mt-1">
                    Projected balances at the end of a budget period — actual opening balances plus budgeted flows
                </p>
            </header>

            {/* Controls */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4">
                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">Budget</label>
                        {budgets !== null && budgets.length === 0 ? (
                            <p className="text-sm text-foreground-secondary py-2">
                                No budgets found. Create a budget first to use this report.
                            </p>
                        ) : (
                            <select
                                value={selectedBudgetGuid ?? ''}
                                onChange={e => {
                                    setSelectedBudgetGuid(e.target.value || null);
                                    setPeriodIndex(null);
                                }}
                                className={`${selectClass} min-w-52`}
                            >
                                {(budgets ?? []).map(budget => (
                                    <option key={budget.guid} value={budget.guid}>{budget.name}</option>
                                ))}
                            </select>
                        )}
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-foreground-secondary uppercase tracking-wider">Through Period</label>
                        <select
                            value={periodIndex ?? reportData?.periodIndex ?? 0}
                            onChange={e => setPeriodIndex(parseInt(e.target.value, 10))}
                            className={selectClass}
                            disabled={!reportData}
                        >
                            {(reportData?.periods ?? []).map(p => (
                                <option key={p.periodNum} value={p.periodNum}>{p.label}</option>
                            ))}
                        </select>
                    </div>
                </div>
                <p className="text-xs text-foreground-tertiary mt-3">
                    Budgeted column: actual opening balance plus budgeted flows through the selected period for
                    budgeted accounts; unbudgeted accounts carry their actual balance. Actual Basis column: the
                    real balance at the end of the selected period. Equity includes a synthetic period net income
                    row so budgeted P&amp;L flows have a home.
                </p>
            </div>

            {isLoading ? (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Generating report...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-negative/40 rounded-xl p-12 text-center">
                    <div className="text-negative">{error}</div>
                </div>
            ) : reportData && (
                <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border text-sm text-foreground-secondary">
                        <span className="font-semibold text-foreground">{reportData.budgetName}</span>
                        <span className="text-xs font-mono" style={TNUM}>
                            Projected through {reportData.periods[reportData.periodIndex]?.label} (as of {reportData.asOfDate})
                        </span>
                    </div>

                    <SheetSection section={reportData.assets} currency={currency} />
                    <SheetSection section={reportData.liabilities} currency={currency} />
                    <SheetSection section={reportData.equity} currency={currency} />

                    {/* Summary */}
                    <div className="border-t-2 border-border-hover bg-background-tertiary p-4 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-base font-bold text-foreground">Liabilities + Equity</span>
                            <span className="text-sm text-foreground-secondary">
                                Budgeted{' '}
                                <span className="font-mono font-semibold text-foreground" style={TNUM}>
                                    {formatCurrency(reportData.totals.liabilitiesAndEquity.budgeted, currency)}
                                </span>
                                {' '}· Actual{' '}
                                <span className="font-mono font-semibold text-foreground" style={TNUM}>
                                    {formatCurrency(reportData.totals.liabilitiesAndEquity.actual, currency)}
                                </span>
                            </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-foreground-muted">
                                Check: Assets − (Liabilities + Equity). Non-zero when the book carries unclosed
                                pre-budget earnings — same caveat as the regular balance sheet.
                            </span>
                            <span className="text-xs font-mono text-foreground-muted" style={TNUM}>
                                Budgeted {formatCurrency(reportData.totals.check.budgeted, currency)}
                                {' '}· Actual {formatCurrency(reportData.totals.check.actual, currency)}
                            </span>
                        </div>
                    </div>

                    {/* CSV export */}
                    <div className="border-t border-border p-4 flex justify-end no-print">
                        <button
                            onClick={handleExportCSV}
                            className="flex items-center gap-2 px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Export CSV
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
