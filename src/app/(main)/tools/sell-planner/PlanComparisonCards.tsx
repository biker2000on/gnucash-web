'use client';

import { formatCurrency } from '@/lib/format';
import type { SellPlan, SellStrategy } from '@/lib/sell-planner';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

function Row({ label, value, tone }: {
    label: string;
    value: string;
    tone?: 'positive' | 'negative' | 'neutral';
}) {
    const valueClass =
        tone === 'positive' ? 'text-positive'
        : tone === 'negative' ? 'text-negative'
        : 'text-foreground';
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-foreground-muted">{label}</span>
            <span className={`font-mono text-sm ${valueClass}`} style={MONO}>{value}</span>
        </div>
    );
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

function PlanCard({ plan, highlight, savingsVsThis, selected, onSelect }: {
    plan: SellPlan;
    highlight: boolean;
    /** Recommended tax minus this plan's tax (negative = recommended saves). */
    savingsVsThis: number | null;
    selected: boolean;
    onSelect: () => void;
}) {
    const gainTone = (v: number) => (v > 0.005 ? 'negative' : v < -0.005 ? 'positive' : 'neutral');
    return (
        <button
            type="button"
            onClick={onSelect}
            className={`text-left bg-surface border rounded-lg p-4 space-y-2 transition-colors duration-150 ${
                selected ? 'border-primary' : 'border-border hover:border-border-hover'
            }`}
        >
            <div className="flex items-center justify-between gap-2">
                <h3 className={`text-sm font-semibold ${highlight ? 'text-primary' : 'text-foreground'}`}>
                    {plan.label}
                </h3>
                {highlight && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-light text-primary">
                        Recommended
                    </span>
                )}
            </div>

            <p className="font-mono text-2xl font-semibold text-foreground" style={MONO}>
                {formatCurrency(plan.tax.total)}
                <span className="ml-1 text-xs font-normal text-foreground-muted">tax</span>
            </p>
            <p className="text-[11px] text-foreground-muted -mt-1">
                {pct(plan.tax.effectiveRateOnRaise)} of the amount raised
            </p>

            <div className="pt-2 border-t border-border space-y-1.5">
                <Row label="Proceeds" value={formatCurrency(plan.totalProceeds)} />
                <Row label="Short-term gain" value={formatCurrency(plan.shortTermGain)} tone={gainTone(plan.shortTermGain)} />
                <Row label="Long-term gain" value={formatCurrency(plan.longTermGain)} tone={gainTone(plan.longTermGain)} />
                <Row label="Federal tax" value={formatCurrency(plan.tax.federal)} />
                <Row label="State tax" value={formatCurrency(plan.tax.state)} />
            </div>

            {!plan.targetMet && (
                <p className="text-[11px] text-warning">
                    {formatCurrency(plan.shortfall)} short of the target.
                </p>
            )}
            {savingsVsThis !== null && savingsVsThis > 0.005 && (
                <p className="text-[11px] text-positive">
                    Recommended plan saves {formatCurrency(savingsVsThis)} vs this.
                </p>
            )}
            <p className="text-[10px] text-foreground-muted">
                {plan.sales.length} lot{plan.sales.length === 1 ? '' : 's'} · click to view details
            </p>
        </button>
    );
}

export default function PlanComparisonCards({ plans, selected, onSelect }: {
    plans: { recommended: SellPlan; fifo: SellPlan; longTermOnly: SellPlan };
    selected: SellStrategy;
    onSelect: (s: SellStrategy) => void;
}) {
    const recTax = plans.recommended.tax.total;
    return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <PlanCard
                plan={plans.recommended}
                highlight
                savingsVsThis={null}
                selected={selected === 'recommended'}
                onSelect={() => onSelect('recommended')}
            />
            <PlanCard
                plan={plans.fifo}
                highlight={false}
                savingsVsThis={plans.fifo.targetMet ? plans.fifo.tax.total - recTax : null}
                selected={selected === 'fifo'}
                onSelect={() => onSelect('fifo')}
            />
            <PlanCard
                plan={plans.longTermOnly}
                highlight={false}
                savingsVsThis={plans.longTermOnly.targetMet ? plans.longTermOnly.tax.total - recTax : null}
                selected={selected === 'long_term_only'}
                onSelect={() => onSelect('long_term_only')}
            />
        </div>
    );
}
