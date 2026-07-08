'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Anomaly, AnomalyType, AnomalySeverity } from '@/lib/anomaly-detection';
import AnomaliesTable, { TYPE_LABELS } from './AnomaliesTable';

interface AnomaliesResponse {
    anomalies: Anomaly[];
    counts: Partial<Record<AnomalyType, number>>;
    params: { months: number };
}

type TypeFilter = 'all' | AnomalyType;
type SeverityFilter = 'all' | AnomalySeverity;

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
            <p className={`mt-1 text-2xl font-mono font-semibold ${valueClass}`} style={{ fontFeatureSettings: "'tnum'" }}>
                {value}
            </p>
            {sublabel && <p className="mt-1 text-xs text-foreground-muted">{sublabel}</p>}
        </div>
    );
}

const TYPE_ORDER: AnomalyType[] = [
    'duplicate_charge',
    'amount_outlier',
    'category_spike',
    'first_time_merchant',
];

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function AnomaliesPage() {
    const [data, setData] = useState<AnomaliesResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [months, setMonths] = useState(12);

    const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
    const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
    const [search, setSearch] = useState('');

    const [scanning, setScanning] = useState(false);
    const [scanResult, setScanResult] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/tools/anomalies?months=${months}`);
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            const json: AnomaliesResponse = await res.json();
            setData(json);
        } catch {
            setError('Failed to load spending anomalies.');
        } finally {
            setLoading(false);
        }
    }, [months]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`/api/tools/anomalies?months=${months}`);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: AnomaliesResponse = await res.json();
                if (!cancelled) setData(json);
            } catch {
                if (!cancelled) setError('Failed to load spending anomalies.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [months]);

    const runScan = useCallback(async () => {
        setScanning(true);
        setScanResult(null);
        try {
            const res = await fetch(`/api/tools/anomalies?months=${months}`, { method: 'POST' });
            if (!res.ok) throw new Error(`Scan failed (${res.status})`);
            const json: { detected: number; created: number } = await res.json();
            setScanResult(
                json.created > 0
                    ? `Scan complete — ${json.created} new alert${json.created === 1 ? '' : 's'} created.`
                    : 'Scan complete — no new alerts.',
            );
            await load();
        } catch {
            setScanResult('Scan failed. Please try again.');
        } finally {
            setScanning(false);
        }
    }, [months, load]);

    const filtered = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        return data.anomalies.filter(a => {
            if (typeFilter !== 'all' && a.type !== typeFilter) return false;
            if (severityFilter !== 'all' && a.severity !== severityFilter) return false;
            if (q &&
                !a.label.toLowerCase().includes(q) &&
                !(a.accountName ?? '').toLowerCase().includes(q) &&
                !a.context.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [data, typeFilter, severityFilter, search]);

    const total = data?.anomalies.length ?? 0;
    const highCount = data?.anomalies.filter(a => a.severity === 'high').length ?? 0;
    const counts = data?.counts ?? {};

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Spending Watch</h1>
                    <p className="text-foreground-muted mt-1">
                        Anomaly and fraud signals detected across your spending — duplicate charges,
                        unfamiliar merchants, unusually large charges, and category spikes.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        Lookback
                        <select
                            value={months}
                            onChange={e => setMonths(parseInt(e.target.value, 10))}
                            className="bg-input-bg border border-border rounded-lg py-1.5 px-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        >
                            <option value={6}>6 months</option>
                            <option value={12}>12 months</option>
                            <option value={24}>24 months</option>
                        </select>
                    </label>
                    <button
                        type="button"
                        onClick={runScan}
                        disabled={scanning || loading}
                        className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 text-primary-foreground text-sm font-medium rounded-lg transition-colors"
                    >
                        {scanning ? 'Scanning…' : 'Run scan now'}
                    </button>
                </div>
            </header>

            {scanResult && (
                <p className="text-sm text-foreground-secondary">{scanResult}</p>
            )}

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
                        onClick={load}
                        className="mt-3 px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors"
                    >
                        Retry
                    </button>
                </section>
            )}

            {/* Summary stats */}
            {!loading && !error && data && (
                <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard
                        label="Total Anomalies"
                        value={String(total)}
                        sublabel={`Across the last ${data.params.months} months`}
                    />
                    <StatCard
                        label="High Severity"
                        value={String(highCount)}
                        sublabel="Duplicates and large outliers"
                        valueClass={highCount > 0 ? 'text-negative' : 'text-foreground'}
                    />
                    <StatCard
                        label="Duplicate Charges"
                        value={String(counts.duplicate_charge ?? 0)}
                        sublabel="Same merchant + amount, days apart"
                        valueClass={(counts.duplicate_charge ?? 0) > 0 ? 'text-warning' : 'text-foreground'}
                    />
                    <StatCard
                        label="Amount Outliers"
                        value={String(counts.amount_outlier ?? 0)}
                        sublabel="Far above a merchant's history"
                        valueClass={(counts.amount_outlier ?? 0) > 0 ? 'text-warning' : 'text-foreground'}
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
                            placeholder="Search merchant, category, or context..."
                            className="flex-1 min-w-[200px] bg-input-bg border border-border rounded-lg py-2 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                        />
                        <div className="flex items-center gap-1 text-xs flex-wrap">
                            <button
                                type="button"
                                onClick={() => setTypeFilter('all')}
                                className={`px-3 py-1.5 rounded-lg border transition-colors duration-150 ${
                                    typeFilter === 'all'
                                        ? 'bg-primary-light border-primary/40 text-primary'
                                        : 'border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                                }`}
                            >
                                All types
                            </button>
                            {TYPE_ORDER.map(t => (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => setTypeFilter(t)}
                                    className={`px-3 py-1.5 rounded-lg border transition-colors duration-150 ${
                                        typeFilter === t
                                            ? 'bg-primary-light border-primary/40 text-primary'
                                            : 'border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                                    }`}
                                >
                                    {TYPE_LABELS[t]}
                                </button>
                            ))}
                        </div>
                        <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                            Severity
                            <select
                                value={severityFilter}
                                onChange={e => setSeverityFilter(e.target.value as SeverityFilter)}
                                className="bg-input-bg border border-border rounded-lg py-1.5 px-2 text-xs text-foreground focus:outline-none focus:border-primary/50"
                            >
                                <option value="all">All</option>
                                <option value="high">High</option>
                                <option value="medium">Medium</option>
                                <option value="low">Low</option>
                            </select>
                        </label>
                    </div>

                    {data.anomalies.length === 0 ? (
                        <p className="text-sm text-foreground-muted py-8 text-center">
                            No spending anomalies detected in the last {data.params.months} months. Your
                            recent spending looks consistent with your history.
                        </p>
                    ) : (
                        <AnomaliesTable anomalies={filtered} />
                    )}

                    {data.anomalies.length > 0 && (
                        <p className="text-xs text-foreground-muted mt-4">
                            Merchants are grouped by normalized description (digits, store numbers, and
                            reference codes stripped). Outliers require at least 4 prior charges from a
                            merchant; category spikes compare the current period to a trailing average.
                            &ldquo;Run scan now&rdquo; also creates notifications for new alerts.
                        </p>
                    )}
                </section>
            )}
        </div>
    );
}
