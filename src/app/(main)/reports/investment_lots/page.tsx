'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import { formatCurrency } from '@/lib/format';
import { downloadCSV } from '@/lib/reports/csv-export';
import Link from 'next/link';

interface LotReportRow {
    accountName: string;
    accountGuid: string;
    commodityMnemonic: string;
    lotTitle: string;
    lotGuid: string;
    isClosed: boolean;
    openDate: string | null;
    closeDate: string | null;
    shares: number;
    costBasis: number;
    marketValue: number | null;
    realizedGain: number;
    unrealizedGain: number | null;
    totalGain: number | null;
    holdingPeriod: 'short_term' | 'long_term' | null;
    daysHeld: number | null;
}

interface InvestmentLotsReportData {
    rows: LotReportRow[];
    summary: {
        totalCostBasis: number;
        totalMarketValue: number | null;
        totalRealizedGain: number;
        totalUnrealizedGain: number | null;
        openLotCount: number;
        closedLotCount: number;
        shortTermCount: number;
        longTermCount: number;
    };
    generatedAt: string;
}

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    return {
        startDate: null,
        endDate: now.toISOString().split('T')[0],
        compareToPrevious: false,
    };
}

function generateLotsCSV(data: InvestmentLotsReportData): string {
    const headers = [
        'Account', 'Symbol', 'Lot', 'Status', 'Open Date', 'Close Date',
        'Shares', 'Cost Basis', 'Market Value', 'Realized Gain',
        'Unrealized Gain', 'Total Gain', 'Holding Period', 'Days Held',
    ];
    const rows = data.rows.map(r => [
        r.accountName,
        r.commodityMnemonic,
        r.lotTitle,
        r.isClosed ? 'Closed' : 'Open',
        r.openDate || '',
        r.closeDate || '',
        r.shares.toFixed(4),
        r.costBasis.toFixed(2),
        r.marketValue !== null ? r.marketValue.toFixed(2) : '',
        r.realizedGain.toFixed(2),
        r.unrealizedGain !== null ? r.unrealizedGain.toFixed(2) : '',
        r.totalGain !== null ? r.totalGain.toFixed(2) : '',
        r.holdingPeriod === 'long_term' ? 'Long Term' : r.holdingPeriod === 'short_term' ? 'Short Term' : '',
        r.daysHeld !== null ? r.daysHeld.toString() : '',
    ]);
    return [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
}

function InvestmentLotsContent() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<InvestmentLotsReportData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showClosed, setShowClosed] = useState(false);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (showClosed) params.set('showClosed', 'true');
            const res = await fetch(`/api/reports/investment-lots?${params}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: InvestmentLotsReportData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [showClosed]);

    useEffect(() => { fetchReport(); }, [fetchReport]);

    const handleExportCSV = () => {
        if (reportData) {
            const csv = generateLotsCSV(reportData);
            downloadCSV(csv, 'Investment_Lots.csv');
        }
    };

    // Group rows by account for display
    const groupedRows = reportData?.rows.reduce((acc, row) => {
        if (!acc[row.accountGuid]) {
            acc[row.accountGuid] = {
                accountName: row.accountName,
                commodityMnemonic: row.commodityMnemonic,
                accountGuid: row.accountGuid,
                rows: [],
            };
        }
        acc[row.accountGuid].rows.push(row);
        return acc;
    }, {} as Record<string, { accountName: string; commodityMnemonic: string; accountGuid: string; rows: LotReportRow[] }>);

    return (
        <div className="space-y-6">
            {/* Controls */}
            <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4 flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={showClosed}
                        onChange={(e) => setShowClosed(e.target.checked)}
                        className="w-4 h-4 rounded border-border bg-input-bg text-cyan-500 focus:ring-cyan-500/30 focus:ring-offset-0"
                    />
                    <span className="text-sm text-foreground">Show closed lots</span>
                </label>
                <button
                    onClick={handleExportCSV}
                    disabled={!reportData}
                    className="ml-auto px-3 py-1.5 text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
                >
                    Export CSV
                </button>
            </div>

            <ReportViewer
                title="Investment Lots"
                description="Lot-level detail with realized/unrealized gains and holding period classification"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {reportData && (
                    <div className="space-y-6">
                        {/* Summary Cards */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="bg-background-secondary/30 rounded-lg p-3">
                                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Open Lots</div>
                                <div className="text-lg font-bold text-foreground">{reportData.summary.openLotCount}</div>
                                <div className="text-[10px] text-foreground-muted">
                                    {reportData.summary.shortTermCount} ST / {reportData.summary.longTermCount} LT
                                </div>
                            </div>
                            <div className="bg-background-secondary/30 rounded-lg p-3">
                                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Total Cost Basis</div>
                                <div className="text-lg font-bold font-mono text-foreground">
                                    {formatCurrency(reportData.summary.totalCostBasis, 'USD')}
                                </div>
                            </div>
                            <div className="bg-background-secondary/30 rounded-lg p-3">
                                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Unrealized Gain</div>
                                <div className={`text-lg font-bold font-mono ${
                                    (reportData.summary.totalUnrealizedGain ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                }`}>
                                    {reportData.summary.totalUnrealizedGain !== null
                                        ? `${reportData.summary.totalUnrealizedGain >= 0 ? '+' : ''}${formatCurrency(reportData.summary.totalUnrealizedGain, 'USD')}`
                                        : 'N/A'}
                                </div>
                            </div>
                            <div className="bg-background-secondary/30 rounded-lg p-3">
                                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Realized Gain</div>
                                <div className={`text-lg font-bold font-mono ${
                                    reportData.summary.totalRealizedGain >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                }`}>
                                    {reportData.summary.totalRealizedGain >= 0 ? '+' : ''}{formatCurrency(reportData.summary.totalRealizedGain, 'USD')}
                                </div>
                            </div>
                        </div>

                        {/* Lots Table grouped by account */}
                        {groupedRows && Object.values(groupedRows).map(group => (
                            <div key={group.accountGuid} className="space-y-2">
                                <h3 className="text-sm font-semibold text-foreground-secondary flex items-center gap-2">
                                    <Link
                                        href={`/accounts/${group.accountGuid}`}
                                        className="hover:text-cyan-400 transition-colors"
                                    >
                                        {group.accountName}
                                    </Link>
                                    <span className="text-xs font-mono text-foreground-muted">{group.commodityMnemonic}</span>
                                </h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="text-[10px] text-foreground-muted uppercase tracking-wider border-b border-border">
                                                <th className="px-3 py-2 text-left">Lot</th>
                                                <th className="px-3 py-2 text-left">Status</th>
                                                <th className="px-3 py-2 text-left">Opened</th>
                                                <th className="px-3 py-2 text-right">Shares</th>
                                                <th className="px-3 py-2 text-right">Cost Basis</th>
                                                <th className="px-3 py-2 text-right">Market Value</th>
                                                <th className="px-3 py-2 text-right">Gain/Loss</th>
                                                <th className="px-3 py-2 text-center">Period</th>
                                                <th className="px-3 py-2 text-right">Days</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {group.rows.map(row => {
                                                const gain = row.isClosed ? row.realizedGain : row.unrealizedGain;
                                                const gainPct = row.costBasis !== 0 && gain !== null
                                                    ? (gain / Math.abs(row.costBasis)) * 100
                                                    : null;

                                                return (
                                                    <tr key={row.lotGuid} className={`border-b border-border/30 hover:bg-background-secondary/20 transition-colors ${row.isClosed ? 'opacity-60' : ''}`}>
                                                        <td className="px-3 py-2 font-medium text-foreground">{row.lotTitle}</td>
                                                        <td className="px-3 py-2">
                                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                                                row.isClosed
                                                                    ? 'bg-foreground-muted/10 text-foreground-muted'
                                                                    : 'bg-emerald-500/10 text-emerald-400'
                                                            }`}>
                                                                {row.isClosed ? 'Closed' : 'Open'}
                                                            </span>
                                                        </td>
                                                        <td className="px-3 py-2 text-foreground-secondary whitespace-nowrap">
                                                            {row.openDate ? new Date(row.openDate).toLocaleDateString() : '\u2014'}
                                                        </td>
                                                        <td className="px-3 py-2 text-right font-mono text-foreground">
                                                            {row.shares.toFixed(4)}
                                                        </td>
                                                        <td className="px-3 py-2 text-right font-mono text-foreground">
                                                            {formatCurrency(row.costBasis, 'USD')}
                                                        </td>
                                                        <td className="px-3 py-2 text-right font-mono text-foreground">
                                                            {row.marketValue !== null ? formatCurrency(row.marketValue, 'USD') : '\u2014'}
                                                        </td>
                                                        <td className="px-3 py-2 text-right font-mono">
                                                            {gain !== null ? (
                                                                <span className={gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                                                    {gain >= 0 ? '+' : ''}{formatCurrency(gain, 'USD')}
                                                                    {gainPct !== null && (
                                                                        <span className="text-foreground-muted ml-1 text-[10px]">
                                                                            ({gainPct >= 0 ? '+' : ''}{gainPct.toFixed(1)}%)
                                                                        </span>
                                                                    )}
                                                                </span>
                                                            ) : '\u2014'}
                                                        </td>
                                                        <td className="px-3 py-2 text-center">
                                                            {row.holdingPeriod && (
                                                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                                                    row.holdingPeriod === 'long_term'
                                                                        ? 'bg-emerald-500/20 text-emerald-400'
                                                                        : 'bg-amber-500/20 text-amber-400'
                                                                }`}>
                                                                    {row.holdingPeriod === 'long_term' ? 'LT' : 'ST'}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-3 py-2 text-right text-foreground-muted font-mono text-xs">
                                                            {row.daysHeld !== null ? row.daysHeld : '\u2014'}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ))}

                        {reportData.rows.length === 0 && (
                            <div className="text-center py-12 text-foreground-muted">
                                <div className="text-4xl mb-3">&#128230;</div>
                                <h3 className="text-lg font-semibold mb-1">No Lots Found</h3>
                                <p className="text-sm">
                                    {showClosed
                                        ? 'No lot-tracked investment transactions found.'
                                        : 'No open lots found. Try enabling "Show closed lots" to see historical data.'}
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </ReportViewer>
        </div>
    );
}

export default function InvestmentLotsPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center py-12">
                <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading report...</span>
                </div>
            </div>
        }>
            <InvestmentLotsContent />
        </Suspense>
    );
}
