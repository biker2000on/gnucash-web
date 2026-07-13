'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import type {
    MonthlyDigest,
    DigestCategory,
    DigestSubscription,
    DigestBill,
    DigestBudgetRow,
} from '@/lib/digest';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { RelatedLinks } from '@/components/RelatedLinks';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function currentMonthKey(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Build a list of the last N month keys (newest first). */
function recentMonths(count: number): { key: string; label: string }[] {
    const out: { key: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < count; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const label = new Intl.DateTimeFormat('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(d);
        out.push({ key, label });
    }
    return out;
}

function pctText(n: number): string {
    return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function deltaClass(n: number, invert = false): string {
    if (n === 0) return 'text-foreground-muted';
    const positive = invert ? n < 0 : n > 0;
    return positive ? 'text-positive' : 'text-negative';
}

/* ------------------------------------------------------------------ */
/* Sections                                                             */
/* ------------------------------------------------------------------ */

/** AI-written 3-5 sentence overview; rendered only when the digest carries one. */
function NarrativeBlock({ narrative }: { narrative: string }) {
    return (
        <section className="bg-primary-light/40 border border-primary/30 rounded-xl p-4 sm:p-6">
            <p className="text-[10px] sm:text-xs uppercase tracking-wide text-primary mb-2 flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                    />
                </svg>
                Month in review
            </p>
            <p className="text-sm sm:text-base leading-relaxed text-foreground">{narrative}</p>
        </section>
    );
}

function NetWorthHero({ digest }: { digest: MonthlyDigest }) {
    const { end, change, changePercent } = digest.netWorth;
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '—';
    return (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4 sm:p-6">
            <p className="text-[10px] sm:text-xs uppercase tracking-wide text-foreground-muted">
                Net worth · end of {digest.monthLabel}
            </p>
            <p
                className="mt-1 sm:mt-2 text-2xl sm:text-4xl font-mono font-bold text-foreground"
                style={TNUM}
            >
                {formatCurrency(end, digest.currency)}
            </p>
            <p className={`mt-1 sm:mt-2 text-sm sm:text-lg font-mono font-semibold ${deltaClass(change)}`} style={TNUM}>
                {arrow} {change >= 0 ? '+' : ''}
                {formatCurrency(change, digest.currency)}
                <span className="ml-2 text-xs sm:text-sm">({pctText(changePercent)} vs prior month)</span>
            </p>
        </section>
    );
}

function StatRow({ digest }: { digest: MonthlyDigest }) {
    const { income, expenses, savingsRate } = digest.cashFlow;
    return (
        <StatGrid cols={3}>
            <StatCard label="Income" value={formatCurrency(income, digest.currency)} tone="positive" />
            <StatCard label="Expenses" value={formatCurrency(expenses, digest.currency)} tone="negative" />
            <StatCard
                label="Savings rate"
                value={`${savingsRate.toFixed(1)}%`}
                sub="Income minus expenses"
                tone={savingsRate >= 0 ? 'primary' : 'negative'}
            />
        </StatGrid>
    );
}

function CategoriesTable({ categories, currency }: { categories: DigestCategory[]; currency: string }) {
    return (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Top categories</h2>
            {categories.length === 0 ? (
                <p className="text-sm text-foreground-muted py-4">No expenses recorded this month.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-xs uppercase tracking-wide text-foreground-muted border-b border-border">
                                <th className="text-left font-medium py-2">Category</th>
                                <th className="text-right font-medium py-2">This month</th>
                                <th className="text-right font-medium py-2">Prior</th>
                                <th className="text-right font-medium py-2">MoM</th>
                            </tr>
                        </thead>
                        <tbody>
                            {categories.map(c => (
                                <tr key={c.name} className="border-b border-border/50 last:border-0">
                                    <td className="py-2 text-foreground">{c.name}</td>
                                    <td className="py-2 text-right font-mono text-foreground" style={TNUM}>
                                        {formatCurrency(c.amount, currency)}
                                    </td>
                                    <td className="py-2 text-right font-mono text-foreground-muted" style={TNUM}>
                                        {formatCurrency(c.priorAmount, currency)}
                                    </td>
                                    <td className={`py-2 text-right font-mono ${deltaClass(c.delta, true)}`} style={TNUM}>
                                        {pctText(c.percent)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function SubscriptionGroup({
    title,
    items,
    currency,
    emptyHint,
}: {
    title: string;
    items: DigestSubscription[];
    currency: string;
    emptyHint: string;
}) {
    return (
        <div>
            <h3 className="text-xs uppercase tracking-wide text-foreground-muted mb-2">
                {title} ({items.length})
            </h3>
            {items.length === 0 ? (
                <p className="text-sm text-foreground-muted">{emptyHint}</p>
            ) : (
                <ul className="space-y-2">
                    {items.map((s, i) => (
                        <li
                            key={`${s.label}-${i}`}
                            className="flex items-center justify-between gap-3 text-sm"
                        >
                            <span className="text-foreground truncate">{s.label}</span>
                            <span className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-foreground" style={TNUM}>
                                    {formatCurrency(s.currentAmount, currency)}
                                </span>
                                {s.direction && (
                                    <span
                                        className={`font-mono text-xs ${
                                            s.direction === 'up' ? 'text-negative' : 'text-positive'
                                        }`}
                                        style={TNUM}
                                    >
                                        {s.direction === 'up' ? '▲' : '▼'} {pctText(s.changePercent)}
                                    </span>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function SubscriptionsSection({ digest }: { digest: MonthlyDigest }) {
    const { subscriptions, currency } = digest;
    return (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 space-y-5">
            <h2 className="text-lg font-semibold text-foreground">Subscription changes</h2>
            <SubscriptionGroup title="New" items={subscriptions.new} currency={currency} emptyHint="No new subscriptions this month." />
            <SubscriptionGroup title="Price changes" items={subscriptions.changed} currency={currency} emptyHint="No price changes this month." />
            <SubscriptionGroup title="Stopped" items={subscriptions.stopped} currency={currency} emptyHint="No stopped subscriptions this month." />
        </section>
    );
}

function BillsSection({ bills, currency }: { bills: DigestBill[]; currency: string }) {
    const total = bills.reduce((sum, b) => sum + b.amount, 0);
    return (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
            <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-lg font-semibold text-foreground">Upcoming bills (30 days)</h2>
                {bills.length > 0 && (
                    <span className="font-mono text-sm text-foreground-secondary" style={TNUM}>
                        {formatCurrency(Math.abs(total), currency)}
                    </span>
                )}
            </div>
            {bills.length === 0 ? (
                <p className="text-sm text-foreground-muted py-2">
                    No scheduled bills in the next 30 days.
                </p>
            ) : (
                <ul className="space-y-2">
                    {bills.map((b, i) => (
                        <li key={`${b.description}-${b.date}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                            <span className="flex items-center gap-3 min-w-0">
                                <span className="font-mono text-foreground-muted shrink-0" style={TNUM}>{b.date}</span>
                                <span className="text-foreground truncate">{b.description}</span>
                            </span>
                            <span className="font-mono text-negative shrink-0" style={TNUM}>
                                {formatCurrency(b.amount, currency)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function BudgetSection({ digest }: { digest: MonthlyDigest }) {
    const budget = digest.budget;
    if (!budget) {
        return (
            <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
                <h2 className="text-lg font-semibold text-foreground mb-2">Budget status</h2>
                <p className="text-sm text-foreground-muted">
                    No budget configured. Create one to see per-category over/under here.
                </p>
            </section>
        );
    }

    const statusLabel: Record<DigestBudgetRow['status'], string> = {
        over: 'Over',
        under: 'Under',
        on_track: 'On track',
    };
    const statusClass: Record<DigestBudgetRow['status'], string> = {
        over: 'text-negative',
        under: 'text-positive',
        on_track: 'text-foreground-muted',
    };

    return (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
            <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-lg font-semibold text-foreground">Budget status · {budget.budgetName}</h2>
                {budget.rows.length > 0 && (
                    <span className="font-mono text-sm text-foreground-secondary" style={TNUM}>
                        {formatCurrency(budget.totalActual, digest.currency)} / {formatCurrency(budget.totalBudgeted, digest.currency)}
                    </span>
                )}
            </div>
            {budget.outOfRange && (
                <p className="text-xs text-warning mb-3">
                    This month falls outside the budget&apos;s configured periods.
                </p>
            )}
            {budget.rows.length === 0 ? (
                <p className="text-sm text-foreground-muted py-2">
                    No expense budget lines for this month.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-xs uppercase tracking-wide text-foreground-muted border-b border-border">
                                <th className="text-left font-medium py-2">Category</th>
                                <th className="text-right font-medium py-2">Actual</th>
                                <th className="text-right font-medium py-2">Budget</th>
                                <th className="text-right font-medium py-2">Variance</th>
                                <th className="text-right font-medium py-2">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {budget.rows.map(r => (
                                <tr key={r.accountGuid} className="border-b border-border/50 last:border-0">
                                    <td className="py-2 text-foreground">{r.accountName}</td>
                                    <td className="py-2 text-right font-mono text-foreground" style={TNUM}>
                                        {formatCurrency(r.actual, digest.currency)}
                                    </td>
                                    <td className="py-2 text-right font-mono text-foreground-muted" style={TNUM}>
                                        {formatCurrency(r.budgeted, digest.currency)}
                                    </td>
                                    <td className={`py-2 text-right font-mono ${deltaClass(r.variance)}`} style={TNUM}>
                                        {formatCurrency(r.variance, digest.currency)}
                                    </td>
                                    <td className={`py-2 text-right ${statusClass[r.status]}`}>
                                        {statusLabel[r.status]}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

type SendState = 'idle' | 'sending' | 'sent' | 'deduped' | 'error';

export default function DigestPage() {
    const months = recentMonths(12);
    const [month, setMonth] = useState(currentMonthKey());
    const [digest, setDigest] = useState<MonthlyDigest | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sendState, setSendState] = useState<SendState>('idle');

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            setSendState('idle');
            try {
                const res = await fetch(`/api/tools/digest?month=${month}`);
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const json: MonthlyDigest = await res.json();
                if (!cancelled) setDigest(json);
            } catch {
                if (!cancelled) setError('Failed to load the monthly digest.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [month]);

    const send = useCallback(async () => {
        setSendState('sending');
        try {
            const res = await fetch('/api/tools/digest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ month }),
            });
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            const json: { delivered: boolean; deduped: boolean } = await res.json();
            setSendState(json.deduped ? 'deduped' : 'sent');
        } catch {
            setSendState('error');
        }
    }, [month]);

    const sendLabel: Record<SendState, string> = {
        idle: 'Send to notifications',
        sending: 'Sending…',
        sent: 'Sent ✓',
        deduped: 'Already sent',
        error: 'Failed — retry',
    };

    return (
        <div className="space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Monthly Digest</h1>
                    <p className="text-foreground-muted mt-1">
                        A month-at-a-glance summary: net-worth change, cash flow, top categories,
                        subscription changes, upcoming bills, and budget status.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        Month
                        <select
                            value={month}
                            onChange={e => setMonth(e.target.value)}
                            className="bg-input-bg border border-border rounded-lg py-1.5 px-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        >
                            {months.map(m => (
                                <option key={m.key} value={m.key}>
                                    {m.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        onClick={send}
                        disabled={loading || !digest || sendState === 'sending'}
                        className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {sendLabel[sendState]}
                    </button>
                </div>
            </header>

            {loading && (
                <div className="space-y-4">
                    <div className="bg-surface/30 border border-border rounded-xl p-6 animate-pulse">
                        <div className="h-3 bg-foreground-muted/20 rounded w-40 mb-3" />
                        <div className="h-9 bg-foreground-muted/20 rounded w-52" />
                    </div>
                    <StatGrid cols={3}>
                        {[1, 2, 3].map(i => (
                            <div key={i} className="bg-surface/30 border border-border rounded-lg px-3 py-2 sm:rounded-xl sm:p-5 animate-pulse">
                                <div className="h-3 bg-foreground-muted/20 rounded w-20 mb-2 sm:mb-3" />
                                <div className="h-5 sm:h-7 bg-foreground-muted/20 rounded w-28" />
                            </div>
                        ))}
                    </StatGrid>
                </div>
            )}

            {!loading && error && (
                <section className="bg-surface/30 border border-error/30 rounded-xl p-6">
                    <p className="text-sm text-error">{error}</p>
                    <button
                        type="button"
                        onClick={() => setMonth(m => m)}
                        className="mt-3 px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors"
                    >
                        Retry
                    </button>
                </section>
            )}

            {!loading && !error && digest && (
                <div className="space-y-6">
                    {digest.narrative && <NarrativeBlock narrative={digest.narrative} />}
                    <NetWorthHero digest={digest} />
                    <StatRow digest={digest} />
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <CategoriesTable categories={digest.topCategories} currency={digest.currency} />
                        <SubscriptionsSection digest={digest} />
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <BillsSection bills={digest.upcomingBills} currency={digest.currency} />
                        <BudgetSection digest={digest} />
                    </div>
                    <p className="text-xs text-foreground-muted">
                        Generated {new Date(digest.generatedAt).toLocaleString()}. Upcoming bills are
                        projected from today; subscription changes and budget status are scoped to the
                        selected month.
                    </p>
                </div>
            )}
            <RelatedLinks ids={['rpt-year-in-review', 'rpt-nw-attribution']} />
        </div>
    );
}
