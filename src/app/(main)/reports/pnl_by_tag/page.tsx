'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters, ReportData } from '@/lib/reports/types';
import type { PnlByTagData } from '@/lib/reports/pnl-by-tag';
import { formatCurrency } from '@/lib/format';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: `${now.getFullYear()}-01-01`,
        endDate: now.toISOString().split('T')[0],
    };
}

function Amount({ value, signed = false }: { value: number; signed?: boolean }) {
    const cls = !signed
        ? 'text-foreground'
        : value > 0
            ? 'text-positive'
            : value < 0
                ? 'text-negative'
                : 'text-foreground-secondary';
    return (
        <span className={`font-mono ${cls}`} style={TNUM}>
            {formatCurrency(value, 'USD')}
        </span>
    );
}

export default function PnlByTagPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<PnlByTagData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/pnl-by-tag?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            setReportData(await res.json());
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
            title="P&L by Tag"
            description="Income and expenses per transaction tag — classes, locations, or projects side by side"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
            reportData={(reportData as unknown as ReportData) ?? undefined}
        >
            {reportData && (
                <>
                    {reportData.rows.length === 0 ? (
                        <div className="p-8 text-center text-sm text-foreground-secondary">
                            No income or expense activity in this period.
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border text-xs uppercase tracking-wide text-foreground-muted">
                                    <th className="px-4 py-2 text-left font-medium">Tag</th>
                                    <th className="px-4 py-2 text-right font-medium">Income</th>
                                    <th className="px-4 py-2 text-right font-medium">Expenses</th>
                                    <th className="px-4 py-2 text-right font-medium">Net</th>
                                </tr>
                            </thead>
                            <tbody>
                                {reportData.rows.map((row) => (
                                    <tr
                                        key={row.tagId ?? 'untagged'}
                                        className="border-b border-border/50 hover:bg-surface-hover"
                                    >
                                        <td className="px-4 py-2">
                                            <span className="inline-flex items-center gap-2">
                                                <span
                                                    aria-hidden
                                                    className="inline-block h-2.5 w-2.5 rounded-full border border-border"
                                                    style={row.color ? { backgroundColor: row.color } : undefined}
                                                />
                                                <span className={row.tagId === null ? 'text-foreground-muted italic' : 'text-foreground'}>
                                                    {row.tag}
                                                </span>
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-right"><Amount value={row.income} /></td>
                                        <td className="px-4 py-2 text-right"><Amount value={row.expenses} /></td>
                                        <td className="px-4 py-2 text-right"><Amount value={row.net} signed /></td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t-2 border-border-hover">
                                    <td className="px-4 py-2 font-semibold text-foreground">Period total</td>
                                    <td className="px-4 py-2 text-right font-semibold">
                                        <Amount value={reportData.totals.income} />
                                    </td>
                                    <td className="px-4 py-2 text-right font-semibold">
                                        <Amount value={reportData.totals.expenses} />
                                    </td>
                                    <td className="px-4 py-2 text-right font-semibold">
                                        <Amount value={reportData.totals.net} signed />
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    )}

                    {/* Counting-rule footnote (included in print output) */}
                    <div className="px-4 py-3 border-t border-border/50">
                        <p className="text-xs text-foreground-muted">
                            A transaction with several tags counts fully under each tag, so the
                            per-tag rows can add up to more than the period total. The Period
                            total row counts every transaction exactly once and matches the
                            Income Statement. Untagged collects transactions with no tag.
                        </p>
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
