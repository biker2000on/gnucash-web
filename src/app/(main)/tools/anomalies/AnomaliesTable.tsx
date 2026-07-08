'use client';

import type { Anomaly, AnomalyType, AnomalySeverity } from '@/lib/anomaly-detection';
import { formatCurrency } from '@/lib/format';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

/* ------------------------------------------------------------------ */
/* Badges                                                               */
/* ------------------------------------------------------------------ */

export const TYPE_LABELS: Record<AnomalyType, string> = {
    duplicate_charge: 'Duplicate',
    first_time_merchant: 'New merchant',
    amount_outlier: 'Outlier',
    category_spike: 'Category spike',
};

function TypeBadge({ type }: { type: AnomalyType }) {
    return (
        <span className="inline-block text-[11px] uppercase tracking-wide text-foreground-secondary border border-border rounded px-1.5 py-0.5 whitespace-nowrap">
            {TYPE_LABELS[type]}
        </span>
    );
}

const SEVERITY_STYLES: Record<AnomalySeverity, string> = {
    high: 'text-negative border-negative/30 bg-negative/10',
    medium: 'text-warning border-warning/30 bg-warning/10',
    low: 'text-foreground-secondary border-border bg-background-tertiary',
};

const SEVERITY_LABELS: Record<AnomalySeverity, string> = {
    high: 'High',
    medium: 'Medium',
    low: 'Low',
};

function SeverityBadge({ severity }: { severity: AnomalySeverity }) {
    return (
        <span className={`inline-block text-[11px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${SEVERITY_STYLES[severity]}`}>
            {SEVERITY_LABELS[severity]}
        </span>
    );
}

/* ------------------------------------------------------------------ */
/* Table                                                                */
/* ------------------------------------------------------------------ */

export default function AnomaliesTable({ anomalies }: { anomalies: Anomaly[] }) {
    if (anomalies.length === 0) {
        return (
            <p className="text-sm text-foreground-muted py-8 text-center">
                No anomalies match the current filters.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-foreground-muted">
                        <th className="text-left font-medium py-2 pr-3">Merchant / Category</th>
                        <th className="text-right font-medium py-2 pr-3">Amount</th>
                        <th className="text-right font-medium py-2 pr-3">Date</th>
                        <th className="text-left font-medium py-2 pr-3">Type</th>
                        <th className="text-left font-medium py-2 pr-3">Severity</th>
                        <th className="text-left font-medium py-2">What we noticed</th>
                    </tr>
                </thead>
                <tbody>
                    {anomalies.map((a, i) => (
                        <tr
                            key={`${a.dedupeKey}-${i}`}
                            className="border-b border-border/50 hover:bg-surface-hover transition-colors duration-150 align-top"
                        >
                            <td className="py-2 pr-3">
                                <div className="text-foreground font-medium">{a.label}</div>
                                {a.accountName && a.accountName !== a.label && (
                                    <div className="text-xs text-foreground-muted max-w-[220px] truncate" title={a.accountName}>
                                        {a.accountName}
                                    </div>
                                )}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground" style={TNUM}>
                                {formatCurrency(a.amount)}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-foreground-secondary" style={TNUM}>
                                {a.date}
                            </td>
                            <td className="py-2 pr-3">
                                <TypeBadge type={a.type} />
                            </td>
                            <td className="py-2 pr-3">
                                <SeverityBadge severity={a.severity} />
                            </td>
                            <td className={`py-2 max-w-[420px] ${a.severity === 'high' ? 'text-negative' : 'text-warning'}`}>
                                {a.context}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
