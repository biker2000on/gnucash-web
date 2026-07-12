'use client';

/**
 * Scenario builder panel: add/remove typed deltas with per-kind forms,
 * plus a "Buy a house" template that pre-wires down payment + mortgage +
 * property tax + insurance + appreciating home value.
 */

import { computeLoanSchedule } from '@/lib/scenario/engine';
import {
    DELTA_KIND_LABELS,
    type RecurringTaxTreatment,
    type Scenario,
    type ScenarioDelta,
    type ScenarioDeltaKind,
} from '@/lib/scenario/types';

const INPUT_CLASS =
    'w-full bg-background-tertiary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50';

const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
});

function newId(): string {
    return Math.random().toString(36).slice(2, 10);
}

function todayIso(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* Delta factories                                                     */
/* ------------------------------------------------------------------ */

function makeDelta(kind: ScenarioDeltaKind): ScenarioDelta {
    const base = { id: newId(), label: DELTA_KIND_LABELS[kind], startDate: todayIso() };
    switch (kind) {
        case 'one_time':
            return { ...base, kind, amount: -10_000 };
        case 'recurring':
            return { ...base, kind, monthlyAmount: -250, annualGrowthPct: 0, endDate: null, taxTreatment: 'none' };
        case 'loan':
            return { ...base, kind, principal: 30_000, annualRatePct: 6.5, termMonths: 60, interestDeductible: false };
        case 'asset':
            return { ...base, kind, value: 30_000, annualAppreciationPct: 0 };
        case 'income_change':
            return { ...base, kind, annualAmount: 10_000 };
        case 'contribution_change':
            return { ...base, kind, annualAmount: 5_000 };
    }
}

/** "Buy a house" template: down payment + mortgage + property tax + insurance + home value. */
function houseTemplateDeltas(): ScenarioDelta[] {
    const start = todayIso();
    const price = 400_000;
    const down = 80_000;
    return [
        { id: newId(), kind: 'one_time', label: 'Down payment + closing', startDate: start, amount: -down },
        {
            id: newId(), kind: 'loan', label: 'Mortgage', startDate: start,
            principal: price - down, annualRatePct: 6.5, termMonths: 360, interestDeductible: true,
        },
        {
            id: newId(), kind: 'recurring', label: 'Property tax', startDate: start,
            monthlyAmount: -417, annualGrowthPct: 2, endDate: null, taxTreatment: 'property_tax',
        },
        {
            id: newId(), kind: 'recurring', label: 'Home insurance + maintenance', startDate: start,
            monthlyAmount: -300, annualGrowthPct: 3, endDate: null, taxTreatment: 'none',
        },
        {
            id: newId(), kind: 'asset', label: 'Home value', startDate: start,
            value: price, annualAppreciationPct: 3,
        },
    ];
}

/* ------------------------------------------------------------------ */
/* Small controls                                                      */
/* ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block min-w-0">
            <span className="block text-[11px] font-medium text-foreground-secondary mb-1">{label}</span>
            {children}
        </label>
    );
}

function NumField({ label, value, onChange, step = 1 }: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    step?: number;
}) {
    return (
        <Field label={label}>
            <input
                type="number"
                className={INPUT_CLASS}
                value={Number.isFinite(value) ? value : 0}
                step={step}
                onChange={e => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v)) onChange(v);
                }}
            />
        </Field>
    );
}

function DateField({ label, value, onChange, allowEmpty = false }: {
    label: string;
    value: string | null;
    onChange: (v: string | null) => void;
    allowEmpty?: boolean;
}) {
    return (
        <Field label={label}>
            <input
                type="date"
                className={INPUT_CLASS}
                value={value ?? ''}
                onChange={e => {
                    const v = e.target.value;
                    if (v) onChange(v);
                    else if (allowEmpty) onChange(null);
                }}
            />
        </Field>
    );
}

function Checkbox({ label, checked, onChange }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer select-none">
            <input
                type="checkbox"
                className="accent-[var(--color-primary,#2dd4bf)]"
                checked={checked}
                onChange={e => onChange(e.target.checked)}
            />
            {label}
        </label>
    );
}

/* ------------------------------------------------------------------ */
/* Per-kind forms                                                      */
/* ------------------------------------------------------------------ */

function DeltaForm({ delta, onChange }: {
    delta: ScenarioDelta;
    onChange: (d: ScenarioDelta) => void;
}) {
    switch (delta.kind) {
        case 'one_time':
            return (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
                    <NumField
                        label="Amount ($, − = outflow)"
                        value={delta.amount}
                        step={1000}
                        onChange={v => onChange({ ...delta, amount: v })}
                    />
                    <DateField
                        label="Date"
                        value={delta.startDate}
                        onChange={v => v && onChange({ ...delta, startDate: v })}
                    />
                </div>
            );
        case 'recurring':
            return (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-3 gap-y-2">
                    <NumField
                        label="Monthly ($, − = expense)"
                        value={delta.monthlyAmount}
                        step={50}
                        onChange={v => onChange({ ...delta, monthlyAmount: v })}
                    />
                    <NumField
                        label="Annual growth %"
                        value={delta.annualGrowthPct ?? 0}
                        step={0.5}
                        onChange={v => onChange({ ...delta, annualGrowthPct: v })}
                    />
                    <DateField
                        label="Starts"
                        value={delta.startDate}
                        onChange={v => v && onChange({ ...delta, startDate: v })}
                    />
                    <DateField
                        label="Ends (blank = never)"
                        value={delta.endDate ?? null}
                        allowEmpty
                        onChange={v => onChange({ ...delta, endDate: v })}
                    />
                    <Field label="Tax treatment">
                        <select
                            className={INPUT_CLASS}
                            value={delta.taxTreatment ?? 'none'}
                            onChange={e => onChange({
                                ...delta,
                                taxTreatment: e.target.value as RecurringTaxTreatment,
                            })}
                        >
                            <option value="none">None</option>
                            <option value="property_tax">Property tax (SALT deduction)</option>
                            <option value="taxable_income">Taxable income</option>
                        </select>
                    </Field>
                </div>
            );
        case 'loan': {
            const schedule = computeLoanSchedule(delta.principal, delta.annualRatePct, delta.termMonths);
            return (
                <div className="space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
                        <NumField
                            label="Principal ($)"
                            value={delta.principal}
                            step={5000}
                            onChange={v => onChange({ ...delta, principal: Math.max(0, v) })}
                        />
                        <NumField
                            label="Rate % APR"
                            value={delta.annualRatePct}
                            step={0.125}
                            onChange={v => onChange({ ...delta, annualRatePct: Math.max(0, v) })}
                        />
                        <NumField
                            label="Term (months)"
                            value={delta.termMonths}
                            step={12}
                            onChange={v => onChange({ ...delta, termMonths: Math.min(600, Math.max(1, Math.round(v))) })}
                        />
                        <DateField
                            label="Originates"
                            value={delta.startDate}
                            onChange={v => v && onChange({ ...delta, startDate: v })}
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                        <Checkbox
                            label="Interest is tax-deductible (mortgage)"
                            checked={delta.interestDeductible === true}
                            onChange={v => onChange({ ...delta, interestDeductible: v })}
                        />
                        <span className="text-[11px] text-foreground-muted font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                            Payment {fmt.format(schedule.monthlyPayment)}/mo · lifetime interest {fmt.format(schedule.totalInterest)}
                        </span>
                    </div>
                </div>
            );
        }
        case 'asset':
            return (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
                    <NumField
                        label="Value ($)"
                        value={delta.value}
                        step={5000}
                        onChange={v => onChange({ ...delta, value: Math.max(0, v) })}
                    />
                    <NumField
                        label="Appreciation %/yr"
                        value={delta.annualAppreciationPct ?? 0}
                        step={0.5}
                        onChange={v => onChange({ ...delta, annualAppreciationPct: v })}
                    />
                    <DateField
                        label="Purchased"
                        value={delta.startDate}
                        onChange={v => v && onChange({ ...delta, startDate: v })}
                    />
                </div>
            );
        case 'income_change':
            return (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
                    <NumField
                        label="Annual gross change ($)"
                        value={delta.annualAmount}
                        step={1000}
                        onChange={v => onChange({ ...delta, annualAmount: v })}
                    />
                    <DateField
                        label="Starts"
                        value={delta.startDate}
                        onChange={v => v && onChange({ ...delta, startDate: v })}
                    />
                </div>
            );
        case 'contribution_change':
            return (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
                    <NumField
                        label="Annual pre-tax deferral change ($)"
                        value={delta.annualAmount}
                        step={500}
                        onChange={v => onChange({ ...delta, annualAmount: v })}
                    />
                    <DateField
                        label="Starts"
                        value={delta.startDate}
                        onChange={v => v && onChange({ ...delta, startDate: v })}
                    />
                </div>
            );
    }
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

const ADD_ORDER: ScenarioDeltaKind[] = [
    'one_time', 'recurring', 'loan', 'asset', 'income_change', 'contribution_change',
];

export default function ScenarioBuilder({ scenario, onChange }: {
    scenario: Scenario;
    onChange: (s: Scenario) => void;
}) {
    const addDelta = (kind: ScenarioDeltaKind) =>
        onChange({ ...scenario, deltas: [...scenario.deltas, makeDelta(kind)] });

    const addHouseTemplate = () =>
        onChange({ ...scenario, deltas: [...scenario.deltas, ...houseTemplateDeltas()] });

    const updateDelta = (d: ScenarioDelta) =>
        onChange({
            ...scenario,
            deltas: scenario.deltas.map(existing => (existing.id === d.id ? d : existing)),
        });

    const removeDelta = (id: string) =>
        onChange({ ...scenario, deltas: scenario.deltas.filter(d => d.id !== id) });

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={addHouseTemplate}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
                >
                    + Buy a house (template)
                </button>
                {ADD_ORDER.map(kind => (
                    <button
                        key={kind}
                        type="button"
                        onClick={() => addDelta(kind)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-background-tertiary border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                    >
                        + {DELTA_KIND_LABELS[kind]}
                    </button>
                ))}
            </div>

            {scenario.deltas.length === 0 ? (
                <p className="text-sm text-foreground-muted py-4">
                    No changes yet — the scenario currently matches the baseline. Add a delta
                    above or start from the &quot;Buy a house&quot; template.
                </p>
            ) : (
                <ul className="space-y-2">
                    {scenario.deltas.map(delta => (
                        <li key={delta.id} className="bg-background-tertiary/50 border border-border rounded-lg p-3">
                            <div className="flex items-start justify-between gap-3 mb-2">
                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-foreground-muted bg-background-tertiary border border-border rounded px-1.5 py-0.5">
                                        {DELTA_KIND_LABELS[delta.kind]}
                                    </span>
                                    <input
                                        type="text"
                                        className="flex-1 min-w-0 bg-transparent border-b border-transparent hover:border-border focus:border-primary/50 focus:outline-none text-sm text-foreground font-medium"
                                        value={delta.label}
                                        onChange={e => updateDelta({ ...delta, label: e.target.value })}
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => removeDelta(delta.id)}
                                    className="shrink-0 text-foreground-muted hover:text-negative transition-colors"
                                    aria-label={`Remove ${delta.label}`}
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                            <DeltaForm delta={delta} onChange={updateDelta} />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
