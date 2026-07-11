'use client';

import { useState, useEffect, useMemo } from 'react';
import { formatCurrency } from '@/lib/format';
import type { ForecastWarning } from '@/lib/forecast';
import { COMBINED_GUID } from '@/lib/forecast';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import ForecastChart from './ForecastChart';

const HORIZON_OPTIONS = [30, 60, 90, 180] as const;

interface ForecastData {
    startDate: string;
    horizonDays: number;
    threshold: number;
    accounts: Array<{
        guid: string;
        name: string;
        startingBalance: number;
        endingBalance: number;
        dailyRunRate: number;
    }>;
    series: Array<{ date: string; combined: number; balances: Record<string, number> }>;
    events: Array<{
        date: string;
        accountGuid: string;
        accountName: string;
        amount: number;
        description: string;
    }>;
    warnings: ForecastWarning[];
    availableAccounts: Array<{ guid: string; name: string; accountType: string }>;
    runRateNote: string;
    lookbackDays: number;
}

function useDebounced<T>(value: T, ms: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return debounced;
}

function formatDisplayDate(dateKey: string): string {
    const [y, m, d] = dateKey.split('-').map(s => parseInt(s, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

function formatShortDate(dateKey: string): string {
    const [y, m, d] = dateKey.split('-').map(s => parseInt(s, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function CashFlowForecastPage() {
    const [days, setDays] = useState<number>(90);
    const [thresholdInput, setThresholdInput] = useState('0');
    // null = all cash accounts (server default)
    const [selected, setSelected] = useState<string[] | null>(null);
    const [showPerAccount, setShowPerAccount] = useState(false);

    const [data, setData] = useState<ForecastData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const debouncedThreshold = useDebounced(thresholdInput, 400);

    useEffect(() => {
        let cancelled = false;
        async function fetchForecast() {
            setLoading(true);
            setError(null);
            try {
                const params = new URLSearchParams();
                params.set('days', String(days));
                const threshold = parseFloat(debouncedThreshold);
                if (Number.isFinite(threshold) && threshold !== 0) {
                    params.set('threshold', String(threshold));
                }
                if (selected !== null && selected.length > 0) {
                    params.set('accounts', selected.join(','));
                }
                const res = await fetch(`/api/tools/cash-flow-forecast?${params.toString()}`);
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    throw new Error(body?.error || `Request failed (${res.status})`);
                }
                const json: ForecastData = await res.json();
                if (!cancelled) setData(json);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load forecast');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        fetchForecast();
        return () => { cancelled = true; };
    }, [days, debouncedThreshold, selected]);

    const toggleAccount = (guid: string) => {
        if (!data) return;
        const allGuids = data.availableAccounts.map(a => a.guid);
        const current = selected === null ? allGuids : selected;
        const next = current.includes(guid)
            ? current.filter(g => g !== guid)
            : [...current, guid];
        if (next.length === 0) return; // keep at least one account selected
        // Back to server default when everything is selected again
        setSelected(next.length === allGuids.length ? null : next);
    };

    const selectedSet = useMemo(() => {
        if (!data) return new Set<string>();
        return new Set(selected === null ? data.availableAccounts.map(a => a.guid) : selected);
    }, [data, selected]);

    // First crossing per account (skip combined duplicates when only one account)
    const displayWarnings = useMemo(() => {
        if (!data) return [] as Array<ForecastWarning & { extraCount: number }>;
        const byAccount = new Map<string, ForecastWarning[]>();
        for (const warning of data.warnings) {
            if (warning.accountGuid === COMBINED_GUID && data.accounts.length <= 1) continue;
            const list = byAccount.get(warning.accountGuid) || [];
            list.push(warning);
            byAccount.set(warning.accountGuid, list);
        }
        const result: Array<ForecastWarning & { extraCount: number }> = [];
        for (const list of byAccount.values()) {
            result.push({ ...list[0], extraCount: list.length - 1 });
        }
        result.sort((a, b) => a.date.localeCompare(b.date));
        return result;
    }, [data]);

    const startBalance = data?.series[0]?.combined ?? 0;
    const endBalance = data?.series[data.series.length - 1]?.combined ?? 0;
    const netChange = endBalance - startBalance;

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Cash Flow Forecast</h1>
                <p className="text-foreground-muted mt-1">
                    Projects cash account balances forward using upcoming scheduled transactions
                    and your historical daily spending rate.
                </p>
            </header>

            {/* Controls */}
            <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    {/* Horizon */}
                    <div className="flex items-center gap-3">
                        <span className="text-xs uppercase tracking-wide text-foreground-muted">Horizon</span>
                        <div className="flex items-center rounded-lg border border-border bg-surface/50 p-0.5">
                            {HORIZON_OPTIONS.map(option => (
                                <button
                                    key={option}
                                    onClick={() => setDays(option)}
                                    className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                                        days === option
                                            ? 'bg-primary/20 text-primary font-medium'
                                            : 'text-foreground-secondary hover:bg-surface-hover'
                                    }`}
                                >
                                    {option}d
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Threshold */}
                    <div className="flex items-center gap-3">
                        <label htmlFor="forecast-threshold" className="text-xs uppercase tracking-wide text-foreground-muted">
                            Warn below
                        </label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-foreground-muted">$</span>
                            <input
                                id="forecast-threshold"
                                type="number"
                                step="50"
                                value={thresholdInput}
                                onChange={e => setThresholdInput(e.target.value)}
                                className="w-32 bg-background-tertiary border border-border rounded-lg py-1.5 pl-7 pr-3 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50"
                                style={{ fontFeatureSettings: "'tnum'" }}
                            />
                        </div>
                    </div>

                    {/* Per-account toggle */}
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={showPerAccount}
                            onChange={e => setShowPerAccount(e.target.checked)}
                            className="accent-[var(--color-primary)]"
                        />
                        <span className="text-sm text-foreground-secondary">Per-account lines</span>
                    </label>
                </div>

                {/* Account multi-select */}
                {data && data.availableAccounts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-border">
                        <span className="text-xs uppercase tracking-wide text-foreground-muted mr-1">Accounts</span>
                        {data.availableAccounts.map(account => {
                            const active = selectedSet.has(account.guid);
                            return (
                                <button
                                    key={account.guid}
                                    onClick={() => toggleAccount(account.guid)}
                                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                                        active
                                            ? 'bg-primary/15 border-primary/40 text-primary'
                                            : 'bg-surface/50 border-border text-foreground-muted hover:border-border-hover hover:text-foreground-secondary'
                                    }`}
                                    title={account.accountType}
                                >
                                    {account.name}
                                </button>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Error */}
            {error && (
                <section className="bg-surface/30 border border-error/30 rounded-xl p-4">
                    <p className="text-sm text-error">Failed to load forecast: {error}</p>
                </section>
            )}

            {/* Loading skeleton */}
            {loading && !data && (
                <section className="bg-surface/30 border border-border rounded-xl p-8">
                    <div className="flex items-center gap-4">
                        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
                        <p className="text-foreground font-medium">Building your forecast…</p>
                    </div>
                </section>
            )}

            {data && (
                <>
                    {/* Summary */}
                    <StatGrid
                        cols={4}
                        className={`transition-opacity duration-150 ease-out ${loading ? 'opacity-60' : 'opacity-100'}`}
                    >
                        <StatCard label="Current Balance" value={formatCurrency(startBalance)} />
                        <StatCard
                            label={`Projected in ${data.horizonDays} Days`}
                            value={formatCurrency(endBalance)}
                            tone={endBalance < data.threshold ? 'negative' : undefined}
                        />
                        <StatCard
                            label="Net Change"
                            value={`${netChange >= 0 ? '+' : ''}${formatCurrency(netChange)}`}
                            tone={netChange >= 0 ? 'positive' : 'negative'}
                        />
                        <StatCard label="Scheduled Events" value={String(data.events.length)} />
                    </StatGrid>

                    {/* Warnings */}
                    {displayWarnings.length > 0 && (
                        <section className="border border-negative/40 bg-negative/5 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <svg className="w-5 h-5 text-negative shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                                <h2 className="text-sm font-semibold text-negative">
                                    Low balance {displayWarnings.length === 1 ? 'warning' : 'warnings'}
                                </h2>
                            </div>
                            <ul className="space-y-1.5">
                                {displayWarnings.map(warning => (
                                    <li key={`${warning.accountGuid}-${warning.date}`} className="text-sm text-foreground">
                                        <span className="font-medium">{warning.accountName}</span>{' '}
                                        {warning.alreadyBelow ? 'is already below' : 'projected to go below'}{' '}
                                        <span className="font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                                            {formatCurrency(warning.threshold)}
                                        </span>{' '}
                                        on <span className="font-medium">{formatShortDate(warning.date)}</span>{' '}
                                        <span className="font-mono text-negative" style={{ fontFeatureSettings: "'tnum'" }}>
                                            ({formatCurrency(warning.projectedBalance)})
                                        </span>
                                        {warning.extraCount > 0 && (
                                            <span className="text-foreground-muted"> · {warning.extraCount} more {warning.extraCount === 1 ? 'dip' : 'dips'}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {/* Chart */}
                    <section className={`bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 transition-opacity duration-150 ease-out ${loading ? 'opacity-60' : 'opacity-100'}`}>
                        <div className="mb-4">
                            <h2 className="text-lg font-semibold text-foreground">Projected Balance</h2>
                            <p className="text-xs text-foreground-muted mt-0.5">
                                {formatDisplayDate(data.startDate)} → {data.series.length > 0 ? formatDisplayDate(data.series[data.series.length - 1].date) : ''}
                                {' · '}scheduled transactions + {data.lookbackDays}-day run rate
                            </p>
                        </div>
                        {data.accounts.length === 0 ? (
                            <p className="text-sm text-foreground-muted py-12 text-center">
                                No cash accounts (BANK, CASH, CREDIT) found in this book.
                            </p>
                        ) : (
                            <ForecastChart
                                series={data.series}
                                accounts={data.accounts}
                                threshold={data.threshold}
                                showPerAccount={showPerAccount}
                            />
                        )}
                    </section>

                    {/* Upcoming events table */}
                    <section className={`bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 transition-opacity duration-150 ease-out ${loading ? 'opacity-60' : 'opacity-100'}`}>
                        <h2 className="text-lg font-semibold text-foreground mb-1">Upcoming Scheduled Transactions</h2>
                        <p className="text-xs text-foreground-muted mb-4">
                            Occurrences within the forecast window affecting the selected accounts.
                        </p>
                        {data.events.length === 0 ? (
                            <p className="text-sm text-foreground-muted">
                                No scheduled transactions fall within this window.
                            </p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs uppercase tracking-wide text-foreground-muted border-b border-border">
                                            <th className="py-2 pr-4 font-medium">Date</th>
                                            <th className="py-2 pr-4 font-medium">Description</th>
                                            <th className="py-2 pr-4 font-medium">Account</th>
                                            <th className="py-2 text-right font-medium">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.events.map((event, i) => (
                                            <tr
                                                key={`${event.date}-${event.accountGuid}-${i}`}
                                                className="border-b border-border/50 last:border-b-0"
                                            >
                                                <td
                                                    className="py-2 pr-4 font-mono text-foreground-secondary whitespace-nowrap"
                                                    style={{ fontFeatureSettings: "'tnum'" }}
                                                >
                                                    {formatShortDate(event.date)}
                                                </td>
                                                <td className="py-2 pr-4 text-foreground">{event.description}</td>
                                                <td className="py-2 pr-4 text-foreground-secondary">{event.accountName}</td>
                                                <td
                                                    className={`py-2 text-right font-mono whitespace-nowrap ${
                                                        event.amount < 0 ? 'text-negative' : 'text-positive'
                                                    }`}
                                                    style={{ fontFeatureSettings: "'tnum'" }}
                                                >
                                                    {formatCurrency(event.amount)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    {/* Methodology note */}
                    <p className="text-xs text-foreground-muted">{data.runRateNote}</p>
                </>
            )}
        </div>
    );
}
