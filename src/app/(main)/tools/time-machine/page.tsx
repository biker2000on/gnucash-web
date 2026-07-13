'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AsOfAccount, AsOfComparison, BookAsOf } from '@/lib/time-machine';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const AMOUNT_FMT = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function fmtAmount(n: number): string {
    const rounded = Math.round(n * 100) / 100;
    return AMOUNT_FMT.format(rounded === 0 ? 0 : rounded);
}

function fmtDelta(n: number): string {
    const rounded = Math.round(n * 100) / 100;
    if (rounded === 0) return '—';
    return `${rounded > 0 ? '+' : ''}${AMOUNT_FMT.format(rounded)}`;
}

function deltaColor(n: number): string {
    const rounded = Math.round(n * 100) / 100;
    if (rounded > 0) return 'text-positive';
    if (rounded < 0) return 'text-negative';
    return 'text-foreground-muted';
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

function yearsAgo(n: number): string {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - n);
    return isoDate(d);
}

interface TimeMachineResponse {
    current: BookAsOf;
    compare: BookAsOf | null;
    diff: AsOfComparison | null;
    earliestDate: string;
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function StatCard({ label, value, delta }: { label: string; value: number; delta?: number }) {
    return (
        <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted">{label}</p>
            <p className="mt-1 font-mono text-xl font-semibold text-foreground sm:text-2xl" style={TNUM}>
                {fmtAmount(value)}
            </p>
            {delta !== undefined && (
                <p className={`mt-0.5 font-mono text-xs ${deltaColor(delta)}`} style={TNUM}>
                    {fmtDelta(delta)}
                </p>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Account tree
// ---------------------------------------------------------------------------

function TreeRow({
    node,
    depth,
    expanded,
    toggle,
    diff,
}: {
    node: AsOfAccount;
    depth: number;
    expanded: Set<string>;
    toggle: (guid: string) => void;
    diff: AsOfComparison | null;
}) {
    const hasChildren = node.children.length > 0;
    const isOpen = expanded.has(node.guid);
    const delta = diff?.byGuid[node.guid]?.delta;

    return (
        <>
            <tr className="border-b border-border/60 last:border-0 hover:bg-surface-hover/50">
                <td className="py-1 pr-3">
                    <button
                        type="button"
                        onClick={() => hasChildren && toggle(node.guid)}
                        className={`flex items-center gap-1 text-left text-foreground ${hasChildren ? 'cursor-pointer' : 'cursor-default'}`}
                        style={{ paddingLeft: `${depth * 16}px` }}
                    >
                        <span className="inline-block w-3 shrink-0 text-xs text-foreground-muted">
                            {hasChildren ? (isOpen ? '▾' : '▸') : ''}
                        </span>
                        <span className={hasChildren ? 'font-medium' : 'text-foreground-secondary'}>{node.name}</span>
                    </button>
                </td>
                <td className="py-1 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>
                    {fmtAmount(node.balance)}
                </td>
                <td className="py-1 text-right font-mono font-medium text-foreground" style={TNUM}>
                    {fmtAmount(node.total)}
                </td>
                {diff && (
                    <td className={`py-1 pl-3 text-right font-mono ${deltaColor(delta ?? 0)}`} style={TNUM}>
                        {fmtDelta(delta ?? 0)}
                    </td>
                )}
            </tr>
            {isOpen && node.children.map(child => (
                <TreeRow
                    key={child.guid}
                    node={child}
                    depth={depth + 1}
                    expanded={expanded}
                    toggle={toggle}
                    diff={diff}
                />
            ))}
        </>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TimeMachinePage() {
    const today = useMemo(() => isoDate(new Date()), []);
    const [date, setDate] = useState(today);
    const [compareEnabled, setCompareEnabled] = useState(false);
    const [compareTo, setCompareTo] = useState(yearsAgo(1));

    const [data, setData] = useState<TimeMachineResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const requestRef = useRef(0);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        const requestId = ++requestRef.current;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const params = new URLSearchParams({ date });
                if (compareEnabled) params.set('compareTo', compareTo);
                const res = await fetch(`/api/tools/time-machine?${params.toString()}`);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: TimeMachineResponse = await res.json();
                if (requestId !== requestRef.current) return;
                setData(json);
                // Default: expand the top level only (on first load / book change).
                setExpanded(prev => (prev.size > 0 ? prev : new Set(json.current.tree.map(n => n.guid))));
            } catch {
                if (requestId === requestRef.current) setError('Failed to compute as-of balances.');
            } finally {
                if (requestId === requestRef.current) setLoading(false);
            }
        })();
    }, [date, compareEnabled, compareTo, reloadKey]);

    const toggle = useCallback((guid: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(guid)) next.delete(guid);
            else next.add(guid);
            return next;
        });
    }, []);

    const presets: Array<{ label: string; value: string }> = [
        { label: 'Today', value: today },
        { label: '1y ago', value: yearsAgo(1) },
        { label: '5y ago', value: yearsAgo(5) },
        ...(data ? [{ label: 'Oldest', value: data.earliestDate }] : []),
    ];

    const diff = compareEnabled ? data?.diff ?? null : null;
    const summary = data?.current.summary;

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Time Machine</h1>
                    <p className="mt-1 text-foreground-muted">
                        Your book as of any date — balances, holdings valued at the prices of the
                        day, and what changed since.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        As of
                        <input
                            type="date"
                            value={date}
                            max={today}
                            onChange={e => e.target.value && setDate(e.target.value)}
                            className="rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-sm text-foreground focus:border-primary/50 focus:outline-none"
                            style={TNUM}
                        />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        <input
                            type="checkbox"
                            checked={compareEnabled}
                            onChange={e => setCompareEnabled(e.target.checked)}
                            className="accent-[var(--primary)]"
                        />
                        Compare to
                        <input
                            type="date"
                            value={compareTo}
                            max={today}
                            disabled={!compareEnabled}
                            onChange={e => e.target.value && setCompareTo(e.target.value)}
                            className="rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-sm text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-50"
                            style={TNUM}
                        />
                    </label>
                </div>
            </header>

            {/* Preset chips */}
            <div className="flex flex-wrap gap-2">
                {presets.map(p => (
                    <button
                        key={p.label}
                        type="button"
                        onClick={() => setDate(p.value)}
                        className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
                            date === p.value
                                ? 'border-primary/50 bg-primary-light text-primary'
                                : 'border-border text-foreground-secondary hover:bg-surface-hover'
                        }`}
                        style={TNUM}
                    >
                        {p.label}
                    </button>
                ))}
            </div>

            {/* Loading */}
            {loading && (
                <>
                    <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="h-24 animate-pulse rounded-xl border border-border bg-surface/30" />
                        ))}
                    </section>
                    <div className="h-96 animate-pulse rounded-xl border border-border bg-surface/30" />
                </>
            )}

            {/* Error */}
            {!loading && error && (
                <section className="rounded-xl border border-error/30 bg-surface/30 p-6">
                    <p className="text-sm text-error">{error}</p>
                    <button
                        type="button"
                        onClick={() => setReloadKey(k => k + 1)}
                        className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
                    >
                        Retry
                    </button>
                </section>
            )}

            {!loading && !error && data && summary && (
                <>
                    {/* Summary cards */}
                    <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <StatCard label={`Net worth · ${data.current.asOf}`} value={summary.netWorth} delta={diff?.summary.netWorth} />
                        <StatCard label="Assets" value={summary.assets} delta={diff?.summary.assets} />
                        <StatCard label="Liabilities" value={summary.liabilities} delta={diff?.summary.liabilities} />
                    </section>

                    {/* Account tree */}
                    <section className="overflow-x-auto rounded-xl border border-border bg-surface p-4">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-foreground-muted">
                                    <th className="py-2 pr-3 font-medium">Account</th>
                                    <th className="py-2 pr-3 text-right font-medium">Balance</th>
                                    <th className="py-2 text-right font-medium">With children</th>
                                    {diff && (
                                        <th className="py-2 pl-3 text-right font-medium">
                                            Δ since {diff.fromDate}
                                        </th>
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {data.current.tree.map(node => (
                                    <TreeRow
                                        key={node.guid}
                                        node={node}
                                        depth={0}
                                        expanded={expanded}
                                        toggle={toggle}
                                        diff={diff}
                                    />
                                ))}
                            </tbody>
                        </table>
                        {data.current.tree.length === 0 && (
                            <p className="py-6 text-center text-sm text-foreground-muted">
                                No accounts in the active book.
                            </p>
                        )}
                    </section>

                    <p className="text-xs text-foreground-muted">
                        Balances are split sums through end of day. Stocks and funds are valued at
                        the latest recorded price on or before the chosen date. Read-only and scoped
                        to the active book.
                    </p>
                </>
            )}
        </div>
    );
}
