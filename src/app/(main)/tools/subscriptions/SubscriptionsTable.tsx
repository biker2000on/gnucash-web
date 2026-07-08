'use client';

import type { RecurringSeries, Cadence, SeriesStatus } from '@/lib/recurring-detection';
import { formatCurrency } from '@/lib/format';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

/* ------------------------------------------------------------------ */
/* Badges                                                               */
/* ------------------------------------------------------------------ */

const CADENCE_LABELS: Record<Cadence, string> = {
    weekly: 'Weekly',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    annual: 'Annual',
};

function CadenceBadge({ cadence }: { cadence: Cadence }) {
    return (
        <span className="inline-block text-[11px] uppercase tracking-wide text-foreground-secondary border border-border rounded px-1.5 py-0.5">
            {CADENCE_LABELS[cadence]}
        </span>
    );
}

const STATUS_STYLES: Record<SeriesStatus, string> = {
    active: 'text-positive border-positive/30 bg-positive/10',
    new: 'text-secondary border-secondary/30 bg-secondary/10',
    stopped: 'text-foreground-muted border-border bg-background-tertiary',
};

const STATUS_LABELS: Record<SeriesStatus, string> = {
    active: 'Active',
    new: 'New',
    stopped: 'Stopped',
};

export function StatusBadge({ status }: { status: SeriesStatus }) {
    return (
        <span className={`inline-block text-[11px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${STATUS_STYLES[status]}`}>
            {STATUS_LABELS[status]}
        </span>
    );
}

/* ------------------------------------------------------------------ */
/* Change vs typical                                                    */
/* ------------------------------------------------------------------ */

function ChangeCell({ pct }: { pct: number }) {
    if (Math.abs(pct) < 0.5) {
        return <span className="text-foreground-muted">&mdash;</span>;
    }
    // Increases are bad for the wallet: >5% warning, >20% negative.
    // Decreases are good: positive.
    const cls = pct > 20
        ? 'text-negative'
        : pct > 5
            ? 'text-warning'
            : pct > 0
                ? 'text-foreground-secondary'
                : 'text-positive';
    return (
        <span className={`font-mono ${cls}`} style={TNUM}>
            {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
        </span>
    );
}

/* ------------------------------------------------------------------ */
/* Table                                                                */
/* ------------------------------------------------------------------ */

export default function SubscriptionsTable({ series }: { series: RecurringSeries[] }) {
    if (series.length === 0) {
        return (
            <p className="text-sm text-foreground-muted py-8 text-center">
                No recurring charges match the current filters.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-foreground-muted">
                        <th className="text-left font-medium py-2 pr-3">Merchant</th>
                        <th className="text-left font-medium py-2 pr-3">Cadence</th>
                        <th className="text-right font-medium py-2 pr-3">Amount</th>
                        <th className="text-right font-medium py-2 pr-3">Change</th>
                        <th className="text-right font-medium py-2 pr-3">Monthly Eq.</th>
                        <th className="text-right font-medium py-2 pr-3">Last Charged</th>
                        <th className="text-right font-medium py-2 pr-3">Next Expected</th>
                        <th className="text-left font-medium py-2 pr-3">Status</th>
                        <th className="text-left font-medium py-2">Expense Account</th>
                    </tr>
                </thead>
                <tbody>
                    {series.map(s => (
                        <tr
                            key={s.merchantKey}
                            className={`border-b border-border/50 hover:bg-surface-hover transition-colors duration-150 ${s.status === 'stopped' ? 'opacity-60' : ''}`}
                        >
                            <td className="py-2 pr-3">
                                <div className="text-foreground font-medium">{s.merchantLabel}</div>
                                <div className="text-xs text-foreground-muted">
                                    {s.occurrences} charges since {s.firstSeen}
                                </div>
                            </td>
                            <td className="py-2 pr-3">
                                <CadenceBadge cadence={s.cadence} />
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground" style={TNUM}>
                                {formatCurrency(s.currentAmount)}
                            </td>
                            <td className="py-2 pr-3 text-right" title={`Typical: ${formatCurrency(s.typicalAmount)}`}>
                                <ChangeCell pct={s.amountChangePct} />
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>
                                {formatCurrency(s.monthlyEquivalent)}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>
                                {s.lastSeen}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>
                                {s.status === 'stopped' ? '—' : s.nextExpected}
                            </td>
                            <td className="py-2 pr-3">
                                <StatusBadge status={s.status} />
                            </td>
                            <td className="py-2 text-xs text-foreground-secondary max-w-[220px] truncate" title={s.accountName}>
                                {s.accountName}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
