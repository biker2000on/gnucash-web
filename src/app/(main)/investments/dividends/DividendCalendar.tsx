'use client';

import { formatCurrency } from '@/lib/format';
import type { ForwardCalendar, ProjectedPayment } from '@/lib/dividends';

function monthLabel(iso: string): string {
    const [y, m] = iso.split('-');
    const date = new Date(parseInt(y), parseInt(m) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function dayLabel(iso: string): string {
    const [y, m, d] = iso.split('-');
    const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

interface DividendCalendarProps {
    calendar: ForwardCalendar;
}

export function DividendCalendar({ calendar }: DividendCalendarProps) {
    const mono = { fontFeatureSettings: "'tnum'" } as const;
    const { calendar: payments, projections } = calendar;
    const notProjected = projections.filter(p => !p.projected);

    // Group expected payments by month.
    const byMonth = new Map<string, ProjectedPayment[]>();
    for (const p of payments) {
        const key = p.date.slice(0, 7);
        const arr = byMonth.get(key);
        if (arr) arr.push(p);
        else byMonth.set(key, [p]);
    }
    const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    if (payments.length === 0) {
        return (
            <div className="bg-surface border border-border rounded-lg p-8 text-center">
                <p className="text-foreground-secondary">
                    No upcoming dividends could be projected.
                </p>
                <p className="text-foreground-muted text-sm mt-1">
                    A security needs at least three payments on a regular cadence to be projected.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {months.map(([month, items]) => {
                    const monthTotal = items.reduce((s, i) => s + i.estimatedAmount, 0);
                    return (
                        <div key={month} className="bg-surface border border-border rounded-lg overflow-hidden">
                            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-background-secondary">
                                <span className="text-sm font-semibold text-foreground">{monthLabel(month)}</span>
                                <span className="text-sm font-mono text-primary" style={mono}>
                                    {formatCurrency(monthTotal)}
                                </span>
                            </div>
                            <ul className="divide-y divide-border/40">
                                {items.map((item, i) => (
                                    <li
                                        key={`${item.ticker}-${item.date}-${i}`}
                                        className="flex items-center justify-between gap-3 px-4 py-2"
                                    >
                                        <div className="min-w-0">
                                            <span className="text-sm font-medium text-foreground">{item.ticker}</span>
                                            <span className="ml-2 text-xs text-foreground-muted capitalize">{item.cadence}</span>
                                        </div>
                                        <div className="flex items-center gap-3 shrink-0">
                                            <span className="text-xs text-foreground-muted font-mono" style={mono}>
                                                {dayLabel(item.date)}
                                            </span>
                                            <span
                                                className="text-sm font-mono text-foreground w-20 text-right"
                                                style={mono}
                                            >
                                                {formatCurrency(item.estimatedAmount)}
                                            </span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    );
                })}
            </div>

            {notProjected.length > 0 && (
                <p className="text-xs text-foreground-muted">
                    Not projected (irregular or one-off):{' '}
                    <span className="text-foreground-secondary">
                        {notProjected.map(p => p.ticker).join(', ')}
                    </span>
                </p>
            )}
        </div>
    );
}
