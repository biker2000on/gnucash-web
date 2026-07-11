'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import type { StockValuationData, StockValuationRow } from '@/lib/reports/stock-valuation';
import { escapeCSVField, downloadCSV } from '@/lib/reports/csv-export';
import { formatCurrency } from '@/lib/format';
import { formatQty } from '@/components/business/inventory-ui';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

function getDefaultFilters(): ReportFilters {
    return { startDate: null, endDate: null, compareToPrevious: false };
}

function methodLabel(method: StockValuationRow['method']): string {
    return method === 'fifo' ? 'FIFO' : 'Average';
}

function generateStockValuationCSV(data: StockValuationData, showLocations: boolean): string {
    const rows: string[] = ['SKU,Item,Method,Location,Qty On Hand,Unit Cost,Value'];
    for (const item of data.items) {
        rows.push([
            escapeCSVField(item.sku),
            escapeCSVField(item.name),
            methodLabel(item.method),
            '',
            String(item.onHand),
            item.unitCost.toFixed(4),
            item.value.toFixed(2),
        ].join(','));
        if (showLocations) {
            for (const loc of item.locations) {
                rows.push([
                    escapeCSVField(item.sku),
                    escapeCSVField(item.name),
                    methodLabel(item.method),
                    escapeCSVField(loc.locationName),
                    String(loc.onHand),
                    item.unitCost.toFixed(4),
                    loc.value.toFixed(2),
                ].join(','));
            }
        }
    }
    rows.push('');
    rows.push(`,TOTAL,,,,,${data.totals.value.toFixed(2)}`);
    return rows.join('\n');
}

export default function StockValuationPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [reportData, setReportData] = useState<StockValuationData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showLocations, setShowLocations] = useState(false);
    const [showZeroStock, setShowZeroStock] = useState(false);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/reports/stock-valuation');
            if (!res.ok) throw new Error('Failed to fetch report');
            const data: StockValuationData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => { fetchReport(); }, [fetchReport]);

    const handleExportCSV = () => {
        if (reportData) {
            downloadCSV(generateStockValuationCSV(reportData, showLocations), 'Stock_Valuation.csv');
        }
    };

    const visibleItems = (reportData?.items ?? []).filter(
        (item) => showZeroStock || Math.abs(item.onHand) > 1e-9 || Math.abs(item.value) > 0.005,
    );

    return (
        <ReportViewer
            title="Stock Valuation"
            description="Inventory on hand per item with valuation method, unit cost, and extended value"
            filters={filters}
            onFilterChange={setFilters}
            isLoading={isLoading}
            error={error}
            showCompare={false}
            reportData={reportData ?? undefined}
        >
            {reportData && (
                <>
                    {/* Report meta + view toggles */}
                    <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-border text-sm text-foreground-secondary">
                        <span className="text-xs">
                            Current stock as of {new Date(reportData.generatedAt).toLocaleString()} — date filters do not apply.
                        </span>
                        <span className="flex items-center gap-4 no-print">
                            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={showLocations}
                                    onChange={(e) => setShowLocations(e.target.checked)}
                                    className="accent-primary"
                                />
                                Per-location breakdown
                            </label>
                            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={showZeroStock}
                                    onChange={(e) => setShowZeroStock(e.target.checked)}
                                    className="accent-primary"
                                />
                                Show zero-stock items
                            </label>
                        </span>
                    </div>

                    {visibleItems.length === 0 ? (
                        <div className="py-8 px-4 text-center text-foreground-secondary">
                            {reportData.items.length === 0
                                ? 'No inventory items in this book yet.'
                                : 'No items with stock on hand. Enable "Show zero-stock items" to list every active item.'}
                        </div>
                    ) : (
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-border-hover text-foreground-secondary text-sm uppercase tracking-wider">
                                    <th className="py-2 px-4 text-left font-medium">SKU</th>
                                    <th className="py-2 px-4 text-left font-medium">Item</th>
                                    <th className="py-2 px-4 text-left font-medium">Method</th>
                                    <th className="py-2 px-4 text-right font-medium">Qty on hand</th>
                                    <th className="py-2 px-4 text-right font-medium">Unit cost</th>
                                    <th className="py-2 px-4 text-right font-medium">Value</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/50">
                                {visibleItems.map((item) => (
                                    <Fragment key={item.itemId}>
                                        <tr className="hover:bg-surface-hover/20 transition-colors">
                                            <td className="py-2 px-4 text-sm font-mono tabular-nums text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                                {item.sku}
                                            </td>
                                            <td className="py-2 px-4 text-sm text-foreground-secondary">{item.name}</td>
                                            <td className="py-2 px-4 text-sm text-foreground-secondary">
                                                {methodLabel(item.method)}
                                                {item.method === 'fifo' && (
                                                    <span className="ml-1.5 text-xs text-foreground-muted font-mono tabular-nums" style={TNUM}>
                                                        avg {formatCurrency(item.avgCost)} (info)
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-2 px-4 text-sm text-right font-mono tabular-nums text-foreground" style={TNUM}>
                                                {formatQty(item.onHand)} {item.unit}
                                            </td>
                                            <td className="py-2 px-4 text-sm text-right font-mono tabular-nums text-foreground-secondary" style={TNUM}>
                                                {formatCurrency(item.unitCost)}
                                            </td>
                                            <td className="py-2 px-4 text-sm text-right font-mono tabular-nums text-foreground" style={TNUM}>
                                                {formatCurrency(item.value)}
                                            </td>
                                        </tr>
                                        {showLocations && item.locations.map((loc) => (
                                            <tr key={`${item.itemId}-${loc.locationId}`} className="bg-background-secondary/20">
                                                <td className="py-1 px-4" />
                                                <td className="py-1 px-4 pl-8 text-xs text-foreground-muted" colSpan={2}>
                                                    {loc.locationName}
                                                </td>
                                                <td className="py-1 px-4 text-xs text-right font-mono tabular-nums text-foreground-muted" style={TNUM}>
                                                    {formatQty(loc.onHand)} {item.unit}
                                                </td>
                                                <td className="py-1 px-4" />
                                                <td className="py-1 px-4 text-xs text-right font-mono tabular-nums text-foreground-muted" style={TNUM}>
                                                    {formatCurrency(loc.value)}
                                                </td>
                                            </tr>
                                        ))}
                                    </Fragment>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t-2 border-border-hover bg-background-tertiary/50">
                                    <td className="py-3 px-4 font-semibold text-foreground" colSpan={5}>
                                        Total ({visibleItems.length} item{visibleItems.length === 1 ? '' : 's'})
                                    </td>
                                    <td className="py-3 px-4 text-right font-mono font-semibold text-foreground" style={TNUM}>
                                        {formatCurrency(reportData.totals.value)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
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
                            Export Stock Valuation CSV
                        </button>
                    </div>
                </>
            )}
        </ReportViewer>
    );
}
