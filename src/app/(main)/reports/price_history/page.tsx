'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ReportViewer } from '@/components/reports/ReportViewer';
import { ReportFilters } from '@/lib/reports/types';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';

interface Commodity {
    guid: string;
    namespace: string;
    mnemonic: string;
    fullname: string | null;
}

interface PricePoint {
    date: string;
    value: number;
    source: string | null;
    type: string | null;
    currency: string;
}

interface PriceHistoryData {
    title: string;
    generatedAt: string;
    startDate: string | null;
    endDate: string | null;
    commodity: Commodity;
    points: PricePoint[];
}

function getDefaultFilters(): ReportFilters {
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    return {
        startDate: oneYearAgo.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0],
    };
}

function formatPrice(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    }).format(value);
}

function formatShortDate(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function sourceBadgeClasses(source: string | null): string {
    if (!source) return 'bg-background-tertiary text-foreground-muted';
    if (source === 'Finance::Quote') return 'bg-secondary-light text-secondary';
    if (source.startsWith('user:')) return 'bg-primary-light text-primary';
    return 'bg-background-tertiary text-foreground-secondary';
}

interface PriceTooltipProps {
    active?: boolean;
    payload?: Array<{ payload: PricePoint }>;
}

function PriceTooltip({ active, payload }: PriceTooltipProps) {
    if (!active || !payload || payload.length === 0) return null;
    const point = payload[0].payload;
    return (
        <div className="bg-background border border-border rounded-lg p-3 shadow-xl">
            <p className="text-xs text-foreground-muted mb-1">{point.date}</p>
            <p className="text-sm font-mono tabular-nums text-foreground">{formatPrice(point.value)}</p>
            {point.source && <p className="text-xs text-foreground-secondary mt-1">{point.source}</p>}
        </div>
    );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="bg-surface border border-border rounded-lg p-4">
            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-1">{label}</div>
            <div className="text-xl font-mono tabular-nums text-foreground">{value}</div>
            {sub && <div className="text-xs text-foreground-secondary mt-1">{sub}</div>}
        </div>
    );
}

export default function PriceHistoryPage() {
    const [filters, setFilters] = useState<ReportFilters>(getDefaultFilters);
    const [commodities, setCommodities] = useState<Commodity[]>([]);
    const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [reportData, setReportData] = useState<PriceHistoryData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const pickerRef = useRef<HTMLDivElement>(null);

    // Load the commodity list once (reuses the existing /api/commodities endpoint)
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/commodities');
                if (!res.ok) throw new Error('Failed to fetch commodities');
                const data: Commodity[] = await res.json();
                if (cancelled) return;
                const nonCurrency = data.filter(
                    c => c.namespace !== 'CURRENCY' && c.namespace.toLowerCase() !== 'template'
                );
                setCommodities(nonCurrency);
                setSelectedGuid(prev => prev ?? nonCurrency[0]?.guid ?? null);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'An error occurred');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Close the picker when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
                setPickerOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchReport = useCallback(async () => {
        if (!selectedGuid) {
            setIsLoading(false);
            setReportData(null);
            return;
        }
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set('commodityGuid', selectedGuid);
            if (filters.startDate) params.set('startDate', filters.startDate);
            if (filters.endDate) params.set('endDate', filters.endDate);

            const res = await fetch(`/api/reports/price-history?${params}`);
            if (!res.ok) throw new Error('Failed to fetch price history');
            const data: PriceHistoryData = await res.json();
            setReportData(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [selectedGuid, filters]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const selected = useMemo(
        () => commodities.find(c => c.guid === selectedGuid) ?? null,
        [commodities, selectedGuid]
    );

    const filteredCommodities = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return commodities;
        return commodities.filter(
            c => c.mnemonic.toLowerCase().includes(q) || (c.fullname ?? '').toLowerCase().includes(q)
        );
    }, [commodities, search]);

    const stats = useMemo(() => {
        const points = reportData?.points ?? [];
        if (points.length === 0) return null;
        let min = points[0];
        let max = points[0];
        for (const p of points) {
            if (p.value < min.value) min = p;
            if (p.value > max.value) max = p;
        }
        return { min, max, latest: points[points.length - 1] };
    }, [reportData]);

    return (
        <div className="space-y-6">
            <ReportViewer
                title="Price History"
                description="Commodity price history from the GnuCash price database"
                filters={filters}
                onFilterChange={setFilters}
                isLoading={isLoading}
                error={error}
                showCompare={false}
            >
                {/* Commodity picker */}
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border bg-background-tertiary/30">
                    <label className="text-xs text-foreground-muted uppercase tracking-wider">Commodity</label>
                    <div className="relative" ref={pickerRef}>
                        <button
                            onClick={() => setPickerOpen(o => !o)}
                            className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-1.5 text-sm text-foreground hover:border-primary/50 transition-colors min-w-[220px]"
                        >
                            {selected ? (
                                <>
                                    <span className="font-mono">{selected.mnemonic}</span>
                                    {selected.fullname && (
                                        <span className="text-foreground-muted truncate max-w-[240px]">{selected.fullname}</span>
                                    )}
                                </>
                            ) : (
                                <span className="text-foreground-muted">Select a commodity…</span>
                            )}
                            <svg className={`w-4 h-4 ml-auto text-foreground-secondary transition-transform ${pickerOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </button>

                        {pickerOpen && (
                            <div className="absolute top-full left-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-surface-elevated border border-border rounded-lg shadow-xl z-50">
                                <div className="p-2 border-b border-border">
                                    <input
                                        type="text"
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        placeholder="Search symbol or name…"
                                        autoFocus
                                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                                    />
                                </div>
                                <div className="max-h-64 overflow-y-auto py-1">
                                    {filteredCommodities.length === 0 && (
                                        <div className="px-3 py-2 text-sm text-foreground-muted">No matches.</div>
                                    )}
                                    {filteredCommodities.map(c => (
                                        <button
                                            key={c.guid}
                                            onClick={() => {
                                                setSelectedGuid(c.guid);
                                                setPickerOpen(false);
                                                setSearch('');
                                            }}
                                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                                                c.guid === selectedGuid
                                                    ? 'bg-primary/15 text-primary'
                                                    : 'text-foreground-secondary hover:bg-surface-hover'
                                            }`}
                                        >
                                            <span className="font-mono w-16 shrink-0">{c.mnemonic}</span>
                                            <span className="truncate">{c.fullname ?? ''}</span>
                                            <span className="ml-auto text-xs text-foreground-muted">{c.namespace}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    {reportData && (
                        <span className="text-xs text-foreground-muted md:ml-auto">
                            {reportData.points.length} price{reportData.points.length === 1 ? '' : 's'}
                        </span>
                    )}
                </div>

                {!selectedGuid && (
                    <div className="p-12 text-center text-foreground-muted text-sm">
                        No non-currency commodities found. Add a stock or fund to see its price history.
                    </div>
                )}

                {reportData && reportData.points.length === 0 && (
                    <div className="p-12 text-center text-foreground-muted text-sm">
                        No prices recorded for {reportData.commodity.mnemonic} in this date range.
                    </div>
                )}

                {reportData && stats && reportData.points.length > 0 && (
                    <div className="p-6 space-y-6">
                        {/* Stat cards */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <StatCard label="Minimum" value={formatPrice(stats.min.value)} sub={stats.min.date} />
                            <StatCard label="Maximum" value={formatPrice(stats.max.value)} sub={stats.max.date} />
                            <StatCard label="Latest" value={formatPrice(stats.latest.value)} sub={stats.latest.date} />
                        </div>

                        {/* Line chart with dots (sparse data stays visible) */}
                        <ResponsiveContainer width="100%" height={360}>
                            <LineChart data={reportData.points} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                <XAxis
                                    dataKey="date"
                                    tickFormatter={formatShortDate}
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                    minTickGap={40}
                                />
                                <YAxis
                                    domain={['auto', 'auto']}
                                    tickFormatter={(v: number) => formatPrice(v)}
                                    stroke="var(--foreground-secondary)"
                                    tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }}
                                    axisLine={{ stroke: 'var(--border)' }}
                                    tickLine={{ stroke: 'var(--border)' }}
                                    width={90}
                                />
                                <Tooltip content={<PriceTooltip />} />
                                <Line
                                    type="monotone"
                                    dataKey="value"
                                    stroke="#2dd4bf"
                                    strokeWidth={2}
                                    dot={{ r: 3, fill: '#2dd4bf', strokeWidth: 0 }}
                                    activeDot={{ r: 5 }}
                                />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {/* Raw price rows */}
                {reportData && reportData.points.length > 0 && (
                    <div className="border-t border-border overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-background-tertiary/50">
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Date</th>
                                    <th className="text-right px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Price</th>
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Currency</th>
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Source</th>
                                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-foreground-muted font-medium hidden md:table-cell">Type</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...reportData.points].reverse().map((p, i) => (
                                    <tr key={`${p.date}-${i}`} className="border-b border-border/50">
                                        <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary">{p.date}</td>
                                        <td className="px-4 py-2 text-right font-mono tabular-nums text-foreground">{formatPrice(p.value)}</td>
                                        <td className="px-4 py-2 text-foreground-secondary">{p.currency}</td>
                                        <td className="px-4 py-2">
                                            <span className={`inline-block px-2 py-0.5 rounded text-xs ${sourceBadgeClasses(p.source)}`}>
                                                {p.source ?? 'unknown'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-foreground-muted text-xs hidden md:table-cell">{p.type ?? ''}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </ReportViewer>
        </div>
    );
}
