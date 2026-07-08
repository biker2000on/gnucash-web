'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { DataHealthReport } from '@/lib/data-health';
import HealthCheckCard from './HealthCheckCard';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

/** Score band → accent color token. */
function scoreColor(score: number): string {
    if (score >= 85) return 'text-positive';
    if (score >= 70) return 'text-warning';
    return 'text-negative';
}

function ScoreHero({ report }: { report: DataHealthReport }) {
    const totalIssues = report.checks.reduce((sum, c) => sum + c.count, 0);
    const failing = report.checks.filter((c) => c.count > 0).length;

    return (
        <section className="flex flex-wrap items-center gap-8 rounded-xl border border-border bg-surface/30 p-6 backdrop-blur-xl">
            <div className="flex items-baseline gap-2">
                <span className={`font-mono text-6xl font-bold ${scoreColor(report.score)}`} style={TNUM}>
                    {report.score}
                </span>
                <span className="font-mono text-2xl text-foreground-muted" style={TNUM}>
                    /100
                </span>
            </div>
            <div className="flex-1">
                <p className="text-lg font-semibold text-foreground">{report.grade}</p>
                <p className="mt-1 text-sm text-foreground-muted">
                    {totalIssues === 0
                        ? 'No issues found — your book looks clean.'
                        : `${totalIssues.toLocaleString()} issue${totalIssues === 1 ? '' : 's'} across ${failing} categor${failing === 1 ? 'y' : 'ies'}.`}
                </p>
                <p className="mt-1 text-xs text-foreground-muted" style={TNUM}>
                    Generated {new Date(report.generatedAt).toLocaleString()}
                </p>
            </div>
        </section>
    );
}

export default function DataHealthPage() {
    const [report, setReport] = useState<DataHealthReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [staleDays, setStaleDays] = useState(7);
    const [unreconciledDays, setUnreconciledDays] = useState(90);

    // Bumping this re-runs the fetch effect (used by the Retry button).
    const [reloadKey, setReloadKey] = useState(0);
    const requestRef = useRef(0);

    const load = useCallback(() => setReloadKey((k) => k + 1), []);

    useEffect(() => {
        const requestId = ++requestRef.current;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(
                    `/api/tools/data-health?staleDays=${staleDays}&unreconciledDays=${unreconciledDays}`,
                );
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: DataHealthReport = await res.json();
                if (requestId === requestRef.current) setReport(json);
            } catch {
                if (requestId === requestRef.current) setError('Failed to run data health checks.');
            } finally {
                if (requestId === requestRef.current) setLoading(false);
            }
        })();
    }, [staleDays, unreconciledDays, reloadKey]);

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Data Health</h1>
                    <p className="mt-1 text-foreground-muted">
                        Is my book clean? Read-only integrity checks over your ledger — balancing,
                        structure, pricing, and reconciliation hygiene.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        Stale after
                        <select
                            value={staleDays}
                            onChange={(e) => setStaleDays(parseInt(e.target.value, 10))}
                            className="rounded-lg border border-border bg-input-bg px-2 py-1.5 text-sm text-foreground focus:border-primary/50 focus:outline-none"
                        >
                            <option value={3}>3 days</option>
                            <option value={7}>7 days</option>
                            <option value={14}>14 days</option>
                            <option value={30}>30 days</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        Unreconciled after
                        <select
                            value={unreconciledDays}
                            onChange={(e) => setUnreconciledDays(parseInt(e.target.value, 10))}
                            className="rounded-lg border border-border bg-input-bg px-2 py-1.5 text-sm text-foreground focus:border-primary/50 focus:outline-none"
                        >
                            <option value={30}>30 days</option>
                            <option value={60}>60 days</option>
                            <option value={90}>90 days</option>
                            <option value={180}>180 days</option>
                            <option value={365}>365 days</option>
                        </select>
                    </label>
                </div>
            </header>

            {/* Loading */}
            {loading && (
                <>
                    <div className="h-32 animate-pulse rounded-xl border border-border bg-surface/30" />
                    <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        {[1, 2, 3, 4, 5, 6].map((i) => (
                            <div
                                key={i}
                                className="h-24 animate-pulse rounded-xl border border-border bg-surface/30"
                            />
                        ))}
                    </section>
                </>
            )}

            {/* Error */}
            {!loading && error && (
                <section className="rounded-xl border border-error/30 bg-surface/30 p-6">
                    <p className="text-sm text-error">{error}</p>
                    <button
                        type="button"
                        onClick={() => load()}
                        className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
                    >
                        Retry
                    </button>
                </section>
            )}

            {/* Report */}
            {!loading && !error && report && (
                <>
                    <ScoreHero report={report} />
                    <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        {report.checks.map((check) => (
                            <HealthCheckCard key={check.id} check={check} />
                        ))}
                    </section>
                    <p className="text-xs text-foreground-muted">
                        All checks are read-only and scoped to the active book. Click a category with
                        issues to see the offending accounts and transactions.
                    </p>
                </>
            )}
        </div>
    );
}
