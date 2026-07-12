'use client';

import { useState, useEffect, useCallback } from 'react';
import type {
    YearInReviewData,
    YirHoldingPerf,
} from '@/lib/reports/year-in-review';

function formatFullCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

function formatSignedCurrency(value: number): string {
    return `${value >= 0 ? '+' : ''}${formatFullCurrency(value)}`;
}

function formatSignedPercent(value: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function amountClass(value: number): string {
    if (value > 0) return 'text-positive';
    if (value < 0) return 'text-negative';
    return 'text-foreground-secondary';
}

function formatDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
    return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
}

function formatMonth(yyyyMm: string): string {
    const [y, m] = yyyyMm.split('-').map(n => parseInt(n, 10));
    return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
        .format(new Date(Date.UTC(y, m - 1, 1)));
}

/* ------------------------------------------------------------------ */
/* Card scaffolding                                                    */
/* ------------------------------------------------------------------ */

function Card({
    kicker,
    title,
    children,
}: {
    kicker: string;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <section className="rounded-lg border border-border bg-surface p-6 break-inside-avoid print:border-neutral-300">
            <p className="text-[11px] uppercase tracking-widest text-foreground-muted mb-1">{kicker}</p>
            <h2 className="text-lg font-bold text-foreground mb-4">{title}</h2>
            {children}
        </section>
    );
}

function Stat({
    label,
    value,
    valueClass = 'text-foreground',
    sub,
}: {
    label: string;
    value: string;
    valueClass?: string;
    sub?: string;
}) {
    return (
        <div>
            <p className="text-xs text-foreground-muted mb-0.5">{label}</p>
            <p className={`font-mono tabular-nums text-xl font-semibold ${valueClass}`}>{value}</p>
            {sub && <p className="text-xs text-foreground-secondary mt-0.5">{sub}</p>}
        </div>
    );
}

function HoldingBlock({ label, holding }: { label: string; holding: YirHoldingPerf }) {
    return (
        <div className="rounded-md border border-border bg-background-tertiary/30 px-4 py-3">
            <p className="text-xs text-foreground-muted mb-1">{label}</p>
            <p className="text-sm text-foreground mb-1 truncate" title={holding.name}>{holding.name}</p>
            <p className={`font-mono tabular-nums text-xl font-semibold ${amountClass(holding.returnPct)}`}>
                {formatSignedPercent(holding.returnPct)}
            </p>
            <p className="text-xs text-foreground-secondary font-mono tabular-nums mt-0.5">
                {formatSignedCurrency(holding.gain)} on {formatFullCurrency(holding.startValue + Math.max(0, holding.netInvested))} invested
            </p>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function YearInReviewPage() {
    const currentYear = new Date().getUTCFullYear();
    const [year, setYear] = useState(currentYear);
    const [data, setData] = useState<YearInReviewData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/reports/year-in-review?year=${year}`);
            if (!res.ok) throw new Error('Failed to fetch report');
            const json: YearInReviewData = await res.json();
            setData(json);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [year]);

    useEffect(() => {
        fetchReport();
    }, [fetchReport]);

    const cards = data?.cards;
    const hasAnyCard = cards && Object.values(cards).some(c => c !== null);

    return (
        <div className="max-w-3xl mx-auto space-y-6">
            {/* Header + year picker */}
            <div className="flex flex-wrap items-end justify-between gap-4 print:hidden">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">Year in Review</h1>
                    <p className="text-sm text-foreground-secondary mt-1">
                        Your financial year, card by card
                    </p>
                </div>
                <div className="inline-flex items-center rounded-lg border border-border overflow-hidden">
                    <button
                        onClick={() => setYear(y => y - 1)}
                        className="px-3 py-1.5 text-sm bg-surface text-foreground-secondary hover:bg-surface-hover transition-colors"
                        aria-label="Previous year"
                    >
                        ←
                    </button>
                    <span className="px-4 py-1.5 text-sm font-mono tabular-nums text-foreground bg-background-tertiary/40 border-x border-border">
                        {year}
                    </span>
                    <button
                        onClick={() => setYear(y => Math.min(currentYear, y + 1))}
                        disabled={year >= currentYear}
                        className="px-3 py-1.5 text-sm bg-surface text-foreground-secondary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label="Next year"
                    >
                        →
                    </button>
                </div>
            </div>

            {/* Print-only header */}
            <div className="hidden print:block">
                <h1 className="text-2xl font-bold">{year} — Year in Review</h1>
            </div>

            {error && (
                <div className="rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-sm text-error">
                    {error}
                </div>
            )}

            {isLoading && (
                <div className="rounded-lg border border-border bg-surface p-10 text-center text-sm text-foreground-muted">
                    Assembling your year…
                </div>
            )}

            {!isLoading && !error && data && !hasAnyCard && (
                <div className="rounded-lg border border-border bg-surface p-10 text-center text-sm text-foreground-muted">
                    No activity recorded for {data.year}.
                </div>
            )}

            {!isLoading && !error && cards && (
                <div className="space-y-4">
                    {/* Net worth arc */}
                    {cards.netWorth && (
                        <Card kicker="The big picture" title="Net worth">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
                                <Stat label={`Jan 1, ${data!.year}`} value={formatFullCurrency(cards.netWorth.start)} />
                                <Stat
                                    label="Change"
                                    value={formatSignedCurrency(cards.netWorth.change)}
                                    valueClass={amountClass(cards.netWorth.change)}
                                    sub={cards.netWorth.changePercent !== 0 ? formatSignedPercent(cards.netWorth.changePercent) : undefined}
                                />
                                <Stat label={`Dec 31, ${data!.year}`} value={formatFullCurrency(cards.netWorth.end)} />
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t border-border pt-3">
                                {([
                                    ['Savings', cards.netWorth.savings],
                                    ['Market', cards.netWorth.marketGains],
                                    ['Debt paydown', cards.netWorth.debtPaydown],
                                    ['Other', cards.netWorth.other],
                                ] as Array<[string, number]>).map(([label, value]) => (
                                    <div key={label}>
                                        <p className="text-xs text-foreground-muted">{label}</p>
                                        <p className={`font-mono tabular-nums ${amountClass(value)}`}>
                                            {formatSignedCurrency(value)}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}

                    {/* Cash flow */}
                    {cards.cashFlow && (
                        <Card kicker="Earned & kept" title="Income and savings rate">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <Stat label="Income earned" value={formatFullCurrency(cards.cashFlow.income)} />
                                <Stat label="Spent" value={formatFullCurrency(cards.cashFlow.expenses)} />
                                <Stat
                                    label="Kept"
                                    value={formatSignedCurrency(cards.cashFlow.net)}
                                    valueClass={amountClass(cards.cashFlow.net)}
                                />
                                <Stat
                                    label="Savings rate"
                                    value={`${cards.cashFlow.savingsRate.toFixed(1)}%`}
                                    valueClass={cards.cashFlow.savingsRate >= 0 ? 'text-positive' : 'text-negative'}
                                />
                            </div>
                        </Card>
                    )}

                    {/* Top categories */}
                    {cards.topCategories && (
                        <Card kicker="Where it went" title="Top spending categories">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border">
                                        <th className="text-left py-1.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">Category</th>
                                        <th className="text-right py-1.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">{data!.year}</th>
                                        <th className="text-right py-1.5 text-xs uppercase tracking-wider text-foreground-muted font-medium">vs {data!.year - 1}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {cards.topCategories.map(row => (
                                        <tr key={row.name} className="border-b border-border/50 last:border-0">
                                            <td className="py-1.5 text-foreground">{row.name}</td>
                                            <td className="py-1.5 text-right font-mono tabular-nums text-foreground">
                                                {formatFullCurrency(row.amount)}
                                            </td>
                                            <td className={`py-1.5 text-right font-mono tabular-nums ${amountClass(-row.delta)}`}>
                                                {row.priorAmount !== 0
                                                    ? `${formatSignedCurrency(row.delta)} (${formatSignedPercent(row.percent)})`
                                                    : 'new'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Card>
                    )}

                    {/* Biggest expense */}
                    {cards.biggestExpense && (
                        <Card kicker="The big one" title="Biggest single expense">
                            <div className="flex items-baseline justify-between gap-4 flex-wrap">
                                <div>
                                    <p className="text-sm text-foreground">
                                        {cards.biggestExpense.description || 'Unlabeled transaction'}
                                    </p>
                                    <p className="text-xs text-foreground-secondary mt-0.5">
                                        {cards.biggestExpense.accountName} · {formatDate(cards.biggestExpense.date)}
                                    </p>
                                </div>
                                <p className="font-mono tabular-nums text-2xl font-semibold text-negative">
                                    {formatFullCurrency(cards.biggestExpense.amount)}
                                </p>
                            </div>
                        </Card>
                    )}

                    {/* Dividends */}
                    {cards.dividends && (
                        <Card kicker="Passive income" title="Dividend income">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-3">
                                <Stat
                                    label={`Received in ${data!.year}`}
                                    value={formatFullCurrency(cards.dividends.total)}
                                    valueClass="text-positive"
                                    sub={`${cards.dividends.paymentCount} payment${cards.dividends.paymentCount === 1 ? '' : 's'}`}
                                />
                                <Stat label={`${data!.year - 1}`} value={formatFullCurrency(cards.dividends.priorTotal)} />
                                <Stat
                                    label="Change"
                                    value={formatSignedCurrency(cards.dividends.delta)}
                                    valueClass={amountClass(cards.dividends.delta)}
                                />
                            </div>
                            {cards.dividends.topPayers.length > 0 && (
                                <div className="border-t border-border pt-3 space-y-1">
                                    {cards.dividends.topPayers.map(p => (
                                        <div key={p.ticker} className="flex justify-between text-sm">
                                            <span className="font-mono text-foreground-secondary">{p.ticker}</span>
                                            <span className="font-mono tabular-nums text-foreground">
                                                {formatFullCurrency(p.amount)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </Card>
                    )}

                    {/* Best / worst holding */}
                    {cards.holdings && (
                        <Card kicker="Markets" title="Best & worst holdings">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <HoldingBlock label="Best performer" holding={cards.holdings.best} />
                                {cards.holdings.worst && (
                                    <HoldingBlock label="Worst performer" holding={cards.holdings.worst} />
                                )}
                            </div>
                            <p className="text-[11px] text-foreground-muted mt-3">
                                Simple return: gain ÷ (starting value + purchases). Not time-weighted.
                            </p>
                        </Card>
                    )}

                    {/* Realized gains + taxes */}
                    {cards.realizedGains && (
                        <Card kicker="Settling up" title="Realized gains & taxes paid">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                                <Stat
                                    label="Short-term gains"
                                    value={formatSignedCurrency(cards.realizedGains.shortTerm)}
                                    valueClass={amountClass(cards.realizedGains.shortTerm)}
                                />
                                <Stat
                                    label="Long-term gains"
                                    value={formatSignedCurrency(cards.realizedGains.longTerm)}
                                    valueClass={amountClass(cards.realizedGains.longTerm)}
                                />
                                <Stat
                                    label="Total realized"
                                    value={formatSignedCurrency(cards.realizedGains.total)}
                                    valueClass={amountClass(cards.realizedGains.total)}
                                />
                            </div>
                            {cards.realizedGains.taxes && (
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t border-border mt-4 pt-3">
                                    {([
                                        ['Federal withheld', cards.realizedGains.taxes.federalWithholding],
                                        ['Federal estimated', cards.realizedGains.taxes.federalEstimated],
                                        ['State withheld', cards.realizedGains.taxes.stateWithholding],
                                        ['State estimated', cards.realizedGains.taxes.stateEstimated],
                                    ] as Array<[string, number]>).map(([label, value]) => (
                                        <div key={label}>
                                            <p className="text-xs text-foreground-muted">{label}</p>
                                            <p className="font-mono tabular-nums text-foreground">
                                                {formatFullCurrency(value)}
                                            </p>
                                        </div>
                                    ))}
                                    <div className="col-span-2 sm:col-span-4 flex justify-between border-t border-border/50 pt-2">
                                        <span className="text-xs uppercase tracking-wider text-foreground-muted">Total taxes paid</span>
                                        <span className="font-mono tabular-nums font-semibold text-foreground">
                                            {formatFullCurrency(cards.realizedGains.taxes.totalPaid)}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </Card>
                    )}

                    {/* Subscriptions */}
                    {cards.subscriptions && (
                        <Card kicker="Recurring life" title="Subscriptions added & dropped">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <p className="text-xs uppercase tracking-wider text-foreground-muted mb-2">
                                        Added ({cards.subscriptions.added.length})
                                    </p>
                                    {cards.subscriptions.added.length === 0 ? (
                                        <p className="text-sm text-foreground-muted">None</p>
                                    ) : (
                                        <ul className="space-y-1.5">
                                            {cards.subscriptions.added.map(s => (
                                                <li key={`${s.label}-${s.date}`} className="flex justify-between gap-2 text-sm">
                                                    <span className="text-foreground truncate" title={s.label}>{s.label}</span>
                                                    <span className="font-mono tabular-nums text-negative shrink-0">
                                                        {formatFullCurrency(s.monthlyEquivalent)}/mo
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div>
                                    <p className="text-xs uppercase tracking-wider text-foreground-muted mb-2">
                                        Dropped ({cards.subscriptions.dropped.length})
                                    </p>
                                    {cards.subscriptions.dropped.length === 0 ? (
                                        <p className="text-sm text-foreground-muted">None</p>
                                    ) : (
                                        <ul className="space-y-1.5">
                                            {cards.subscriptions.dropped.map(s => (
                                                <li key={`${s.label}-${s.date}`} className="flex justify-between gap-2 text-sm">
                                                    <span className="text-foreground truncate" title={s.label}>{s.label}</span>
                                                    <span className="font-mono tabular-nums text-positive shrink-0">
                                                        {formatFullCurrency(s.monthlyEquivalent)}/mo
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                        </Card>
                    )}

                    {/* Busiest merchant */}
                    {cards.busiestMerchant && (
                        <Card kicker="Creature of habit" title="Busiest merchant">
                            <div className="flex items-baseline justify-between gap-4 flex-wrap">
                                <div>
                                    <p className="text-sm text-foreground">{cards.busiestMerchant.merchant}</p>
                                    <p className="text-xs text-foreground-secondary mt-0.5">
                                        {cards.busiestMerchant.visits} visits · avg{' '}
                                        {formatFullCurrency(cards.busiestMerchant.averageAmount)}
                                    </p>
                                </div>
                                <p className="font-mono tabular-nums text-2xl font-semibold text-foreground">
                                    {formatFullCurrency(cards.busiestMerchant.total)}
                                </p>
                            </div>
                        </Card>
                    )}

                    {/* Budget streak */}
                    {cards.budgetStreak && (
                        <Card kicker="Discipline" title="Months under budget">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
                                <Stat
                                    label="Under budget"
                                    value={`${cards.budgetStreak.monthsUnderBudget} / ${cards.budgetStreak.monthsEvaluated}`}
                                    valueClass={
                                        cards.budgetStreak.monthsUnderBudget * 2 >= cards.budgetStreak.monthsEvaluated
                                            ? 'text-positive'
                                            : 'text-negative'
                                    }
                                />
                                <Stat label="Longest streak" value={`${cards.budgetStreak.longestStreak} mo`} />
                                <Stat label="Budget" value={cards.budgetStreak.budgetName} valueClass="text-foreground text-base" />
                            </div>
                            <div className="flex gap-1.5 flex-wrap">
                                {cards.budgetStreak.monthly.map(m => (
                                    <div
                                        key={m.month}
                                        title={`${m.month}: spent ${formatFullCurrency(m.actual)} of ${formatFullCurrency(m.budgeted)}`}
                                        className={`px-2 py-1 rounded-sm text-[11px] font-mono ${
                                            m.under
                                                ? 'bg-positive/15 text-positive'
                                                : 'bg-negative/15 text-negative'
                                        }`}
                                    >
                                        {formatMonth(m.month)}
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                </div>
            )}
        </div>
    );
}
