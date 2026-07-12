'use client';

import { useCallback, useEffect, useState } from 'react';
import { WidgetShell } from './WidgetShell';
import type { StoredInsight } from '@/lib/insights';

const SEVERITY_DOT: Record<string, string> = {
    info: 'bg-primary',
    warning: 'bg-warning',
    critical: 'bg-error',
};

const MAX_VISIBLE = 5;

/**
 * Proactive insights: undismissed detector results with severity dots and a
 * dismiss button per row. Data: GET /api/insights; dismiss: PATCH /api/insights.
 */
export default function InsightsWidget() {
    const [insights, setInsights] = useState<StoredInsight[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [dismissing, setDismissing] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/insights')
            .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((json: { insights: StoredInsight[] }) => {
                if (!cancelled) {
                    setInsights(Array.isArray(json.insights) ? json.insights : []);
                    setLoading(false);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setError(true);
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const dismiss = useCallback(async (id: number) => {
        setDismissing(id);
        try {
            const res = await fetch('/api/insights', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            });
            if (res.ok) {
                setInsights(prev => (prev ? prev.filter(i => i.id !== id) : prev));
            }
        } catch {
            // Leave the row in place; the user can retry.
        } finally {
            setDismissing(null);
        }
    }, []);

    const visible = insights?.slice(0, MAX_VISIBLE) ?? [];

    return (
        <WidgetShell
            title="Insights"
            loading={loading}
            error={error}
            empty={!!insights && insights.length === 0}
            emptyText="No insights — all quiet."
        >
            {insights && insights.length > 0 && (
                <ul className="space-y-2">
                    {visible.map(insight => (
                        <li key={insight.id} className="flex items-start gap-2 text-sm">
                            <span
                                className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                                    SEVERITY_DOT[insight.severity] ?? SEVERITY_DOT.info
                                }`}
                                title={insight.severity}
                                aria-label={`Severity: ${insight.severity}`}
                            />
                            <div className="min-w-0 flex-1">
                                {insight.href ? (
                                    <a
                                        href={insight.href}
                                        className="block text-foreground hover:text-primary transition-colors truncate"
                                        title={insight.detail}
                                    >
                                        {insight.title}
                                    </a>
                                ) : (
                                    <span className="block text-foreground truncate" title={insight.detail}>
                                        {insight.title}
                                    </span>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => void dismiss(insight.id)}
                                disabled={dismissing === insight.id}
                                aria-label={`Dismiss "${insight.title}"`}
                                className="shrink-0 text-foreground-muted hover:text-foreground disabled:opacity-40 transition-colors leading-none px-1"
                                title="Dismiss"
                            >
                                ×
                            </button>
                        </li>
                    ))}
                    {insights.length > MAX_VISIBLE && (
                        <li className="text-xs text-foreground-muted">
                            +{insights.length - MAX_VISIBLE} more
                        </li>
                    )}
                </ul>
            )}
        </WidgetShell>
    );
}
