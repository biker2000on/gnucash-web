'use client';

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatCurrency } from '@/lib/format';
import type { DividendSummary } from '@/lib/dividends';
import { DividendMonthlyChart } from './DividendMonthlyChart';
import { PerSecurityTable } from './PerSecurityTable';
import { DividendCalendar } from './DividendCalendar';

export default function DividendsPage() {
    const [data, setData] = useState<DividendSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [year, setYear] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const url = year != null
            ? `/api/investments/dividends?year=${year}`
            : '/api/investments/dividends';
        fetch(url)
            .then(async (res) => {
                if (!res.ok) throw new Error((await res.json()).error || 'Failed to load dividends');
                return res.json();
            })
            .then((json: DividendSummary) => {
                if (!cancelled) { setData(json); setError(null); }
            })
            .catch((err) => { if (!cancelled) setError(err.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [year]);

    const years = useMemo(() => (data?.perYear ?? []).map(y => y.year).sort((a, b) => b - a), [data]);

    if (loading && !data) {
        return (
            <div className="space-y-6">
                <div className="h-8 bg-background-tertiary rounded animate-pulse w-48" />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-28 bg-background-tertiary rounded-lg animate-pulse" />
                    ))}
                </div>
                <div className="h-72 bg-background-tertiary rounded-lg animate-pulse" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="space-y-6">
                <PageHeader title="Dividend Income" subtitle="Dividend tracking and forward calendar" />
                <div className="bg-surface border border-border rounded-lg p-8 text-center">
                    <p className="text-negative">{error}</p>
                </div>
            </div>
        );
    }

    if (!data || data.paymentCount === 0) {
        return (
            <div className="space-y-6">
                <PageHeader title="Dividend Income" subtitle="Dividend tracking and forward calendar" />
                <div className="bg-surface border border-border rounded-lg p-8 text-center">
                    <p className="text-foreground-secondary text-lg mb-2">No dividend income found</p>
                    <p className="text-foreground-muted">
                        Dividends appear here once income transactions posted to a
                        &ldquo;Dividend&rdquo; income account exist in this book.
                    </p>
                </div>
            </div>
        );
    }

    const mono = { fontFeatureSettings: "'tnum'" } as const;

    const cards = [
        {
            label: 'TTM Dividend Income',
            value: formatCurrency(data.ttmTotal),
            sub: 'Trailing 12 months',
            color: 'text-foreground',
        },
        {
            label: 'Projected Next 12mo',
            value: formatCurrency(data.projectedNext12mo),
            sub: `${data.forwardCalendar.calendar.length} expected payments`,
            color: 'text-primary',
        },
        {
            label: 'Portfolio Yield',
            value: data.portfolioYield != null ? `${data.portfolioYield.toFixed(2)}%` : '—',
            sub: data.portfolioValue > 0 ? `on ${formatCurrency(data.portfolioValue)}` : 'value unavailable',
            color: 'text-positive',
        },
    ];

    return (
        <div className="space-y-6">
            <PageHeader
                title="Dividend Income"
                subtitle="Dividend tracking and forward calendar"
                actions={
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setYear(null)}
                            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                                year == null
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                            }`}
                        >
                            TTM
                        </button>
                        {years.slice(0, 6).map(y => (
                            <button
                                key={y}
                                onClick={() => setYear(y)}
                                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors font-mono ${
                                    year === y
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {y}
                            </button>
                        ))}
                    </div>
                }
            />

            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {cards.map(card => (
                    <div key={card.label} className="bg-background-secondary rounded-lg p-4 border border-border">
                        <p className="text-foreground-muted text-sm">{card.label}</p>
                        <p className={`text-2xl font-bold font-mono ${card.color}`} style={mono}>{card.value}</p>
                        <p className="text-xs text-foreground-muted mt-1">{card.sub}</p>
                    </div>
                ))}
            </div>

            {year != null && data.yearTotal != null && (
                <div className="bg-primary-light border border-border rounded-lg px-4 py-2.5 flex items-center justify-between">
                    <span className="text-sm text-foreground-secondary">
                        Total dividends in <span className="font-medium text-foreground">{year}</span>
                    </span>
                    <span className="text-sm font-bold font-mono text-foreground" style={mono}>
                        {formatCurrency(data.yearTotal)}
                    </span>
                </div>
            )}

            {/* Monthly income chart */}
            <div className="bg-surface border border-border rounded-lg p-4 sm:p-6">
                <h2 className="text-sm font-semibold text-foreground mb-4">Monthly Dividend Income</h2>
                <DividendMonthlyChart data={data.monthly} />
            </div>

            {/* Per-security table */}
            <div>
                <h2 className="text-sm font-semibold text-foreground mb-3">By Security</h2>
                <PerSecurityTable rows={data.perSecurity} year={year} />
            </div>

            {/* Forward calendar */}
            <div>
                <h2 className="text-sm font-semibold text-foreground mb-3">Upcoming Dividends (next 12 months)</h2>
                <DividendCalendar calendar={data.forwardCalendar} />
            </div>
        </div>
    );
}
