'use client';

import { formatCurrency } from '@/lib/format';
import type { Goal, GoalProgress } from '@/lib/goals';
import { ProgressRing } from './ProgressRing';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';

export interface GoalWithProgress extends Goal {
    progress: GoalProgress;
}

const TYPE_LABELS: Record<Goal['goalType'], string> = {
    emergency_fund: 'Emergency Fund',
    savings_target: 'Savings Target',
    debt_payoff: 'Debt Payoff',
};

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

interface GoalCardProps {
    goal: GoalWithProgress;
    onEdit: (goal: GoalWithProgress) => void;
    onDelete: (goal: GoalWithProgress) => void;
}

export function GoalCard({ goal, onEdit, onDelete }: GoalCardProps) {
    const { isReadonly } = useCurrentUser();
    const p = goal.progress;
    const isDebt = goal.goalType === 'debt_payoff';

    // Ring/badge tone: met → positive, behind a set date → warning, else primary.
    const tone: 'primary' | 'positive' | 'warning' =
        p.alreadyMet ? 'positive' : p.onTrack === false ? 'warning' : 'primary';

    const currentLabel = isDebt ? 'Owed' : 'Saved';
    const targetLabel = isDebt ? 'Paid off' : 'Target';

    return (
        <div className="bg-surface border border-border rounded-lg p-5 flex flex-col gap-4 hover:border-border-hover transition-colors">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-widest text-foreground-muted font-semibold">
                        {TYPE_LABELS[goal.goalType]}
                    </div>
                    <h3 className="text-base font-semibold text-foreground truncate">{goal.name}</h3>
                </div>
                {p.alreadyMet ? (
                    <span className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md bg-positive/10 text-positive">
                        {isDebt ? 'Paid off' : 'Goal met'}
                    </span>
                ) : p.onTrack === null ? null : p.onTrack ? (
                    <span className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md bg-positive/10 text-positive">
                        On track
                    </span>
                ) : (
                    <span className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md bg-warning/10 text-warning">
                        Behind
                    </span>
                )}
            </div>

            {/* Ring + amounts */}
            <div className="flex items-center gap-4">
                <ProgressRing pct={p.progressPct} tone={tone} />
                <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-foreground-muted">{currentLabel}</span>
                        <span className="font-mono text-sm text-foreground tabular-nums">
                            {formatCurrency(p.currentAmount)}
                        </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-foreground-muted">{targetLabel}</span>
                        <span className="font-mono text-sm text-foreground-secondary tabular-nums">
                            {isDebt ? formatCurrency(0) : formatCurrency(p.targetAmount)}
                        </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-foreground-muted">{isDebt ? 'Remaining' : 'To go'}</span>
                        <span className="font-mono text-sm text-foreground-secondary tabular-nums">
                            {formatCurrency(p.remainingAmount)}
                        </span>
                    </div>
                </div>
            </div>

            {/* Projection details */}
            <div className="border-t border-border pt-3 space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground-muted">Monthly {isDebt ? 'payment' : 'contribution'}</span>
                    <span className="font-mono text-foreground-secondary tabular-nums">
                        {p.monthlyContribution > 0 ? formatCurrency(p.monthlyContribution) : '—'}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground-muted">Projected completion</span>
                    <span className="font-mono text-foreground-secondary tabular-nums">
                        {p.alreadyMet ? 'Complete' : p.projectedCompletionDate ? formatDate(p.projectedCompletionDate) : 'Never'}
                    </span>
                </div>
                {goal.targetDate && (
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-foreground-muted">Target date</span>
                        <span className="font-mono text-foreground-secondary tabular-nums">
                            {formatDate(goal.targetDate)}
                        </span>
                    </div>
                )}
                {!p.alreadyMet && p.monthlyNeededToHitDate != null && (
                    <div className={`flex items-center justify-between gap-2 ${p.onTrack === false ? 'text-warning' : 'text-foreground-secondary'}`}>
                        <span>To hit your date</span>
                        <span className="font-mono tabular-nums">
                            {formatCurrency(p.monthlyNeededToHitDate)}/mo
                        </span>
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
                <button
                    type="button"
                    onClick={() => onEdit(goal)}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="px-3 py-1.5 text-xs rounded-md border border-border text-foreground-secondary hover:text-foreground hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    Edit
                </button>
                <button
                    type="button"
                    onClick={() => onDelete(goal)}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="px-3 py-1.5 text-xs rounded-md border border-rose-500/30 text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    Delete
                </button>
            </div>
        </div>
    );
}
