'use client';

import { formatCurrency } from '@/lib/format';

interface ReconcileSummaryProps {
    reconciledBalance: number;
    selectedTotal: number;
    /** null while the ending-balance input is empty/invalid. */
    endingBalance: number | null;
    /** Difference in integer cents; null while ending balance is invalid. */
    differenceCents: number | null;
    currency: string;
    lastReconcileDate: string | null;
}

/**
 * The always-visible running summary of the reconcile window:
 * Reconciled balance, Selected total, Ending balance, Difference.
 * Difference renders in --positive only when it is exactly 0.00.
 */
export function ReconcileSummary({
    reconciledBalance,
    selectedTotal,
    endingBalance,
    differenceCents,
    currency,
    lastReconcileDate,
}: ReconcileSummaryProps) {
    const items: Array<{ label: string; value: string; className: string; hint?: string }> = [
        {
            label: 'Reconciled Balance',
            value: formatCurrency(reconciledBalance, currency),
            className: 'text-foreground',
            hint: lastReconcileDate
                ? `Last reconciled ${lastReconcileDate.slice(0, 10)}`
                : 'Never reconciled',
        },
        {
            label: 'Selected Total',
            value: formatCurrency(selectedTotal, currency),
            className: 'text-foreground',
        },
        {
            label: 'Ending Balance',
            value: endingBalance === null ? '—' : formatCurrency(endingBalance, currency),
            className: 'text-foreground',
        },
        {
            label: 'Difference',
            value: differenceCents === null ? '—' : formatCurrency(differenceCents / 100, currency),
            className:
                differenceCents === 0 ? 'text-positive' : 'text-negative',
        },
    ];

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 border border-border rounded-lg bg-surface divide-x divide-y lg:divide-y-0 divide-border overflow-hidden">
            {items.map((item) => (
                <div key={item.label} className="p-4">
                    <p className="text-xs text-foreground-muted uppercase tracking-widest font-semibold mb-1">
                        {item.label}
                    </p>
                    <p
                        className={`text-xl font-mono font-semibold ${item.className}`}
                        style={{ fontFeatureSettings: "'tnum'" }}
                    >
                        {item.value}
                    </p>
                    {item.hint && (
                        <p className="text-xs text-foreground-muted mt-1">{item.hint}</p>
                    )}
                </div>
            ))}
        </div>
    );
}
