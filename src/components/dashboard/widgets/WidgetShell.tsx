'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

/** Simple lazy fetch for self-contained dashboard widgets. */
export function useWidgetFetch<T>(url: string | null): {
    data: T | null;
    loading: boolean;
    error: boolean;
} {
    const [state, setState] = useState<{
        url: string | null;
        data: T | null;
        loading: boolean;
        error: boolean;
    }>({ url, data: null, loading: !!url, error: false });

    // Derive the reset synchronously during render when the url changes
    // (avoids a sync setState inside the effect body).
    if (state.url !== url) {
        setState({ url, data: null, loading: !!url, error: false });
    }

    useEffect(() => {
        if (!url) return;
        let cancelled = false;
        fetch(url)
            .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then(json => {
                if (!cancelled) setState({ url, data: json, loading: false, error: false });
            })
            .catch(() => {
                if (!cancelled) setState({ url, data: null, loading: false, error: true });
            });
        return () => {
            cancelled = true;
        };
    }, [url]);

    return { data: state.data, loading: state.loading, error: state.error };
}

/** Loading shimmer rows matching StatCard density. */
export function WidgetShimmer({ rows = 3 }: { rows?: number }) {
    return (
        <div className="space-y-2.5 animate-pulse" aria-hidden>
            {Array.from({ length: rows }).map((_, i) => (
                <div
                    key={i}
                    className="h-4 rounded bg-surface-hover"
                    style={{ width: `${85 - i * 18}%` }}
                />
            ))}
        </div>
    );
}

export interface WidgetShellProps {
    title: string;
    /** Feature page this widget summarizes; renders a small "open" link. */
    href?: string;
    hrefLabel?: string;
    loading?: boolean;
    error?: boolean;
    /** When true, `emptyState` (or a default message) replaces children. */
    empty?: boolean;
    emptyText?: string;
    /** Extra element on the header row (e.g. a grade chip). */
    headerExtra?: ReactNode;
    children?: ReactNode;
}

/**
 * Card chrome for compact self-fetching dashboard widgets: title row with an
 * "open feature" link, loading shimmer, and a friendly empty state.
 */
export function WidgetShell({
    title,
    href,
    hrefLabel = 'Open',
    loading = false,
    error = false,
    empty = false,
    emptyText = 'Nothing to show yet.',
    headerExtra,
    children,
}: WidgetShellProps) {
    return (
        <div className="bg-surface border border-border rounded-xl p-4 h-full flex flex-col min-h-[132px]">
            <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-sm font-semibold text-foreground truncate">{title}</h3>
                    {headerExtra}
                </div>
                {href && (
                    <Link
                        href={href}
                        className="flex items-center gap-1 text-xs text-foreground-secondary hover:text-primary transition-colors shrink-0"
                    >
                        {hrefLabel}
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                        </svg>
                    </Link>
                )}
            </div>
            <div className="flex-1 min-h-0">
                {loading ? (
                    <WidgetShimmer />
                ) : error ? (
                    <p className="text-xs text-foreground-muted">Could not load this widget.</p>
                ) : empty ? (
                    <p className="text-xs text-foreground-muted">{emptyText}</p>
                ) : (
                    children
                )}
            </div>
        </div>
    );
}

/** Compact label/value pair in widget bodies (mono, tabular-nums). */
export function WidgetStat({
    label,
    value,
    sub,
    toneClass = 'text-foreground',
}: {
    label: string;
    value: ReactNode;
    sub?: ReactNode;
    toneClass?: string;
}) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-foreground-muted leading-tight">
                {label}
            </div>
            <div className={`mt-0.5 font-mono font-semibold tabular-nums text-lg ${toneClass}`} style={TNUM}>
                {value}
            </div>
            {sub != null && sub !== '' && (
                <div className="mt-0.5 text-[11px] text-foreground-muted truncate">{sub}</div>
            )}
        </div>
    );
}

export { TNUM };
