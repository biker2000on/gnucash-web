'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { WidgetShell, WidgetShimmer, TNUM } from './WidgetShell';

interface BudgetListItem {
    guid: string;
    name: string;
}

interface PacingInfoApi {
    budgeted: number;
    actual: number;
    pctUsed: number | null;
    elapsedFraction: number;
    projected: number;
    status: 'on-track' | 'warning' | 'over';
}

interface BudgetActualsSummaryApi {
    budgetGuid: string;
    currency: string;
    currentPeriod: number | null;
    periodLabel: string | null;
    elapsedFraction: number | null;
    spend: PacingInfoApi | null;
}

interface ActiveBudgetPacing {
    name: string;
    summary: BudgetActualsSummaryApi;
}

const STATUS_TONE: Record<PacingInfoApi['status'], { text: string; bar: string; label: string }> = {
    'on-track': { text: 'text-positive', bar: 'bg-positive', label: 'On track' },
    warning: { text: 'text-warning', bar: 'bg-warning', label: 'Projected over' },
    over: { text: 'text-negative', bar: 'bg-negative', label: 'Over budget' },
};

/**
 * Current-period spend pacing for the first budget with an active period.
 * Data: GET /api/budgets, then /api/budgets/{guid}/actuals?summary=1.
 */
export default function BudgetPacingWidget() {
    const [state, setState] = useState<{
        loading: boolean;
        error: boolean;
        hasBudgets: boolean;
        active: ActiveBudgetPacing | null;
    }>({ loading: true, error: false, hasBudgets: false, active: null });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/budgets');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const budgets = (await res.json()) as BudgetListItem[];
                if (cancelled) return;
                if (!Array.isArray(budgets) || budgets.length === 0) {
                    setState({ loading: false, error: false, hasBudgets: false, active: null });
                    return;
                }
                const summaries = await Promise.all(
                    budgets.map(async b => {
                        try {
                            const r = await fetch(`/api/budgets/${b.guid}/actuals?summary=1`);
                            if (!r.ok) return null;
                            return {
                                name: b.name,
                                summary: (await r.json()) as BudgetActualsSummaryApi,
                            };
                        } catch {
                            return null;
                        }
                    })
                );
                if (cancelled) return;
                const active =
                    summaries.find(
                        s => s && s.summary.currentPeriod != null && s.summary.spend != null
                    ) ?? null;
                setState({ loading: false, error: false, hasBudgets: true, active });
            } catch {
                if (!cancelled) {
                    setState({ loading: false, error: true, hasBudgets: false, active: null });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const { loading, error, hasBudgets, active } = state;
    const spend = active?.summary.spend ?? null;
    const tone = spend ? STATUS_TONE[spend.status] : null;
    const pct = spend ? Math.max(0, Math.min(100, spend.pctUsed ?? 0)) : 0;
    const elapsedPct = spend ? Math.max(0, Math.min(100, spend.elapsedFraction * 100)) : 0;

    return (
        <WidgetShell
            title="Budget Pacing"
            href="/budgets"
            error={error}
            empty={!loading && (!hasBudgets || !active)}
            emptyText={
                hasBudgets
                    ? 'No budget covers the current period.'
                    : 'No budgets yet. Create one to track spending pace.'
            }
        >
            {loading ? (
                <WidgetShimmer />
            ) : (
                spend &&
                active &&
                tone && (
                    <div>
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-xs text-foreground truncate">{active.name}</span>
                            <span className={`text-[11px] shrink-0 ${tone.text}`}>{tone.label}</span>
                        </div>
                        <div className="mt-2 relative h-2 rounded-full bg-surface-hover overflow-hidden">
                            <div
                                className={`h-full rounded-full ${tone.bar}`}
                                style={{ width: `${pct}%` }}
                            />
                            {/* Elapsed-time marker: spend left of this line is on pace. */}
                            <div
                                className="absolute top-0 bottom-0 w-px bg-foreground-muted"
                                style={{ left: `${elapsedPct}%` }}
                                title={`${Math.round(elapsedPct)}% of period elapsed`}
                            />
                        </div>
                        <div
                            className="mt-1.5 flex items-baseline justify-between font-mono tabular-nums text-xs"
                            style={TNUM}
                        >
                            <span className="text-foreground">
                                {formatCurrency(spend.actual, active.summary.currency)}
                                <span className="text-foreground-muted">
                                    {' '}/ {formatCurrency(spend.budgeted, active.summary.currency)}
                                </span>
                            </span>
                            <span className="text-foreground-muted">
                                {active.summary.periodLabel ?? ''}
                            </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-foreground-muted font-mono tabular-nums" style={TNUM}>
                            Projected {formatCurrency(spend.projected, active.summary.currency)} by period end
                        </div>
                    </div>
                )
            )}
        </WidgetShell>
    );
}
