'use client';

import { useState, useEffect, useMemo } from 'react';
import type { RecurringSeries, RecurringTotals, SeriesStatus } from '@/lib/recurring-detection';
import { formatCurrency } from '@/lib/format';
import SubscriptionsTable from './SubscriptionsTable';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface SubscriptionsResponse {
    series: RecurringSeries[];
    totals: RecurringTotals;
    params: { months: number; minOccurrences: number };
}

type StatusFilter = 'all' | SeriesStatus;
type SortKey = 'monthly' | 'amount' | 'lastSeen' | 'merchant';

/* ------------------------------------------------------------------ */
/* Summary stat card                                                    */
/* ------------------------------------------------------------------ */

function StatCard({
    label,
    value,
    sublabel,
    valueClass = 'text-foreground',
}: {
    label: string;
    value: string;
    sublabel?: string;
    valueClass?: string;
}) {
    return (
        <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-5">
            <p className="text-xs uppercase tracking-wide text-foreground-muted">{label}</p>
            <p className={`mt-1 text-2xl font-mono font-semibold ${valueClass}`} style={TNUM}>
                {value}
            </p>
            {sublabel && <p className="mt-1 text-xs text-foreground-muted">{sublabel}</p>}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function SubscriptionsPage() {
    const [data, setData] = useState<SubscriptionsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Query params
    const [months, setMonths] = useState(24);

    // Filters
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [search, setSearch] = useState('');
    const [sortKey, setSortKey] = useState<SortKey>('monthly');

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`/api/tools/subscriptions?months=${months}&minOccurrences=3`);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: SubscriptionsResponse = await res.json();
                if (!cancelled) setData(json);
            } catch {
                if (!cancelled) setError('Failed to load recurring charges.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => { cancelled = true; };
    }, [months]);

    const filtered = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        const rows = data.series.filter(s => {
            if (statusFilter !== 'all' && s.status !== statusFilter) return false;
            if (q && !s.merchantLabel.toLowerCase().includes(q) &&
                !s.merchantKey.includes(q) &&
                !s.accountName.toLowerCase().includes(q)) return false;
            return true;
        });
        const sorted = [...rows];
        switch (sortKey) {
            case 'monthly':
                sorted.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
                break;
            case 'amount':
                sorted.sort((a, b) => b.currentAmount - a.currentAmount);
                break;
            case 'lastSeen':
                sorted.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
                break;
            case 'merchant':
                sorted.sort((a, b) => a.merchantLabel.localeCompare(b.merchantLabel));
                break;
        }
        return sorted;
    }, [data, statusFilter, search, sortKey]);

    const totals = data?.totals;
    const stoppedCount = totals ? totals.totalSeries - totals.activeCount : 0;

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Subscriptions</h1>
                    <p className="text-foreground-muted mt-1">
                        Recurring charges detected from your spending — weekly, monthly, quarterly, and
                        annual series with price-change tracking.
                    </p>
                </div>
                <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                    Lookback
                    <select
                        value={months}
                        onChange={e => setMonths(parseInt(e.target.value, 10))}
                        className="bg-input-bg border border-border rounded-lg py-1.5 px-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                    >
                        <option value={12}>12 months</option>
                        <option value={24}>24 months</option>
                        <option value={36}>36 months</option>
                    </select>
                </label>
            </header>

            {/* Loading */}
            {loading && (
                <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="bg-surface/30 border border-border rounded-xl p-5 animate-pulse">
                            <div className="h-3 bg-foreground-muted/20 rounded w-24 mb-3" />
                            <div className="h-7 bg-foreground-muted/20 rounded w-28" />
                        </div>
                    ))}
                </section>
            )}

            {/* Error */}
            {!loading && error && (
                <section className="bg-surface/30 border border-error/30 rounded-xl p-6">
                    <p className="text-sm text-error">{error}</p>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="mt-3 px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors"
                    >
                        Retry
                    </button>
                </section>
            )}

            {/* Summary stats */}
            {!loading && !error && totals && (
                <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard
                        label="Active Subscriptions"
                        value={String(totals.activeCount)}
                        sublabel={stoppedCount > 0 ? `${stoppedCount} stopped in window` : 'includes new series'}
                    />
                    <StatCard
                        label="Monthly Total"
                        value={formatCurrency(totals.activeMonthlyTotal)}
                        sublabel="All cadences normalized to per-month"
                        valueClass="text-primary"
                    />
                    <StatCard
                        label="Annualized Total"
                        value={formatCurrency(totals.activeAnnualTotal)}
                        sublabel="Monthly total × 12"
                    />
                    <StatCard
                        label="Price Increases"
                        value={String(totals.priceIncreaseCount)}
                        sublabel="Latest charge > 5% above typical"
                        valueClass={totals.priceIncreaseCount > 0 ? 'text-warning' : 'text-foreground'}
                    />
                </section>
            )}

            {/* Filters + table */}
            {!loading && !error && data && (
                <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
                    <div className="flex flex-wrap items-center gap-3 mb-4">
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search merchant or account..."
                            className="flex-1 min-w-[200px] bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                        />
                        <div className="flex items-center gap-1 text-xs">
                            {(['all', 'active', 'new', 'stopped'] as StatusFilter[]).map(f => (
                                <button
                                    key={f}
                                    type="button"
                                    onClick={() => setStatusFilter(f)}
                                    className={`px-3 py-1.5 rounded-lg border transition-colors duration-150 capitalize ${
                                        statusFilter === f
                                            ? 'bg-primary-light border-primary/40 text-primary'
                                            : 'border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                                    }`}
                                >
                                    {f}
                                </button>
                            ))}
                        </div>
                        <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                            Sort
                            <select
                                value={sortKey}
                                onChange={e => setSortKey(e.target.value as SortKey)}
                                className="bg-input-bg border border-border rounded-lg py-1.5 px-2 text-xs text-foreground focus:outline-none focus:border-primary/50"
                            >
                                <option value="monthly">Monthly cost</option>
                                <option value="amount">Charge amount</option>
                                <option value="lastSeen">Last charged</option>
                                <option value="merchant">Merchant A–Z</option>
                            </select>
                        </label>
                    </div>

                    {data.series.length === 0 ? (
                        <p className="text-sm text-foreground-muted py-8 text-center">
                            No recurring charges detected in the last {months} months. A series needs at
                            least 3 charges at a steady weekly, monthly, quarterly, or annual interval.
                        </p>
                    ) : (
                        <SubscriptionsTable series={filtered} />
                    )}

                    {data.series.length > 0 && (
                        <p className="text-xs text-foreground-muted mt-4">
                            Detection groups charges by normalized description (digits, store numbers, and
                            reference codes stripped) and requires at least 3 occurrences at a consistent
                            interval. Amounts are the expense-account value; refunds are excluded.
                        </p>
                    )}
                </section>
            )}
        </div>
    );
}
