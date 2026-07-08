'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import type { HealthCheck, HealthCheckItem, Severity } from '@/lib/data-health';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

/** Per-severity presentation tokens (all from the design system). */
const SEVERITY_STYLES: Record<Severity, { text: string; border: string; dot: string; badge: string }> = {
    ok: {
        text: 'text-positive',
        border: 'border-border',
        dot: 'bg-positive',
        badge: 'bg-positive/10 text-positive',
    },
    info: {
        text: 'text-secondary',
        border: 'border-secondary/30',
        dot: 'bg-secondary',
        badge: 'bg-secondary/10 text-secondary',
    },
    warning: {
        text: 'text-warning',
        border: 'border-warning/30',
        dot: 'bg-warning',
        badge: 'bg-warning/10 text-warning',
    },
    error: {
        text: 'text-negative',
        border: 'border-negative/30',
        dot: 'bg-negative',
        badge: 'bg-negative/10 text-negative',
    },
};

function CheckRow({ item }: { item: HealthCheckItem }) {
    const body = (
        <>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{item.name}</p>
                {item.detail && (
                    <p className="mt-0.5 truncate text-xs text-foreground-muted" style={TNUM}>
                        {item.detail}
                    </p>
                )}
            </div>
            {typeof item.amount === 'number' && (
                <span
                    className="shrink-0 font-mono text-sm text-foreground-secondary"
                    style={TNUM}
                >
                    {formatCurrency(item.amount, item.currency || 'USD')}
                </span>
            )}
        </>
    );

    if (item.href) {
        return (
            <Link
                href={item.href}
                className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 transition-colors duration-150 hover:border-border-hover hover:bg-surface-hover"
            >
                {body}
            </Link>
        );
    }
    return <div className="flex items-center gap-3 px-3 py-2">{body}</div>;
}

export default function HealthCheckCard({ check }: { check: HealthCheck }) {
    const [expanded, setExpanded] = useState(false);
    const styles = SEVERITY_STYLES[check.severity];
    const clean = check.count === 0;

    return (
        <div className={`rounded-xl border bg-surface/30 backdrop-blur-xl ${styles.border}`}>
            <button
                type="button"
                onClick={() => !clean && setExpanded((v) => !v)}
                disabled={clean}
                className={`flex w-full items-center gap-3 p-5 text-left ${clean ? 'cursor-default' : 'cursor-pointer'}`}
            >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${styles.dot}`} aria-hidden />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{check.label}</h3>
                        {clean ? (
                            <span className="inline-flex items-center gap-1 text-xs text-positive">
                                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                Clean
                            </span>
                        ) : (
                            <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${styles.badge}`} style={TNUM}>
                                {check.count}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-xs text-foreground-muted">{check.description}</p>
                </div>
                {!clean && (
                    <svg
                        className={`h-4 w-4 shrink-0 text-foreground-muted transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                )}
            </button>

            {expanded && !clean && (
                <div className="border-t border-border px-2 pb-2 pt-1">
                    <div className="max-h-96 space-y-0.5 overflow-y-auto">
                        {check.items.map((item) => (
                            <CheckRow key={item.guid} item={item} />
                        ))}
                    </div>
                    {check.truncated && (
                        <p className="px-3 py-2 text-xs text-foreground-muted">
                            Showing first {check.items.length} of {check.count}.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
