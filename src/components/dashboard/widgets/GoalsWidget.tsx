'use client';

import { useMemo } from 'react';
import { formatCurrency } from '@/lib/format';
import { WidgetShell, useWidgetFetch, TNUM } from './WidgetShell';

interface GoalProgressApi {
    progressPct: number;
    currentAmount: number;
    targetAmount: number;
    alreadyMet: boolean;
    onTrack: boolean | null;
}

interface GoalApi {
    id: number;
    name: string;
    progress: GoalProgressApi;
}

/** Top goals with progress bars. Data: GET /api/goals. */
export default function GoalsWidget() {
    const { data, loading, error } = useWidgetFetch<GoalApi[]>('/api/goals');

    const top = useMemo(() => {
        if (!Array.isArray(data)) return [];
        // Active goals first (closest to done at the top), completed last.
        return [...data]
            .sort((a, b) => {
                if (a.progress.alreadyMet !== b.progress.alreadyMet) {
                    return a.progress.alreadyMet ? 1 : -1;
                }
                return b.progress.progressPct - a.progress.progressPct;
            })
            .slice(0, 3);
    }, [data]);

    return (
        <WidgetShell
            title="Goals"
            href="/goals"
            loading={loading}
            error={error}
            empty={top.length === 0}
            emptyText="No goals yet. Create one to track savings or debt payoff."
        >
            <div className="space-y-3">
                {top.map(goal => {
                    const pct = Math.max(0, Math.min(100, goal.progress.progressPct));
                    const met = goal.progress.alreadyMet;
                    const behind = goal.progress.onTrack === false;
                    return (
                        <div key={goal.id}>
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs text-foreground truncate">{goal.name}</span>
                                <span
                                    className={`font-mono tabular-nums text-xs shrink-0 ${
                                        met ? 'text-positive' : behind ? 'text-warning' : 'text-foreground-secondary'
                                    }`}
                                    style={TNUM}
                                >
                                    {Math.round(pct)}%
                                </span>
                            </div>
                            <div className="mt-1 h-1.5 rounded-full bg-surface-hover overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${met ? 'bg-positive' : 'bg-primary'}`}
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                            <div
                                className="mt-0.5 text-[11px] text-foreground-muted font-mono tabular-nums"
                                style={TNUM}
                            >
                                {formatCurrency(goal.progress.currentAmount)} of{' '}
                                {formatCurrency(goal.progress.targetAmount)}
                            </div>
                        </div>
                    );
                })}
            </div>
        </WidgetShell>
    );
}
