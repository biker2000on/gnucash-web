'use client';

/**
 * Retirement Drawdown & Roth Conversion Planner.
 *
 * Models the spend-down phase year by year: bucket growth, withdrawal
 * sequencing, SECURE 2.0 RMDs, IRMAA warnings, and bracket-filling Roth
 * conversions — with a conversions on/off comparison. Starting balances
 * and Social Security prefill from the book; scenario parameters persist
 * in localStorage.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { compareConversions } from '@/lib/drawdown/engine';
import {
    BUCKETS,
    BUCKET_LABELS,
    type Bucket,
    type BucketAmounts,
    type DrawdownInputs,
} from '@/lib/drawdown/types';
import { FILING_STATUSES, FILING_STATUS_LABELS, type FilingStatus } from '@/lib/tax/types';
import { STATE_OPTIONS } from '@/lib/tax/state';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import DrawdownChart, { BUCKET_COLORS } from './DrawdownChart';
import DrawdownTable from './DrawdownTable';

/* ------------------------------------------------------------------ */
/* Scenario parameters (persisted to localStorage)                     */
/* ------------------------------------------------------------------ */

type SequencingKey = 'taxableFirst' | 'traditionalFirst' | 'rothEarly' | 'hsaFirst';

const SEQUENCING_PRESETS: Record<SequencingKey, { label: string; order: Bucket[] }> = {
    taxableFirst: {
        label: 'Taxable → Traditional → Roth → HSA (default)',
        order: ['taxable', 'traditional', 'roth', 'hsa'],
    },
    traditionalFirst: {
        label: 'Traditional → Taxable → Roth → HSA',
        order: ['traditional', 'taxable', 'roth', 'hsa'],
    },
    rothEarly: {
        label: 'Taxable → Roth → Traditional → HSA',
        order: ['taxable', 'roth', 'traditional', 'hsa'],
    },
    hsaFirst: {
        label: 'HSA → Taxable → Traditional → Roth',
        order: ['hsa', 'taxable', 'traditional', 'roth'],
    },
};

const CONVERSION_BRACKETS = [10, 12, 22, 24, 32] as const;

interface DrawdownParams {
    currentAge: number;
    hasSpouse: boolean;
    spouseAge: number;
    retirementAge: number;
    endAge: number;
    filingStatus: FilingStatus;
    state: string;
    stateFlatRatePct: number;
    spending: number;
    inflationPct: number;
    returnsPct: BucketAmounts;
    gainsPct: number;
    ssEnabled: boolean;
    ssStartAge: number;
    ssAnnualOverride: number | null;
    sequencingKey: SequencingKey;
    conversionsEnabled: boolean;
    conversionBracketPct: number;
    balanceOverrides: Record<Bucket, number | null>;
}

const DEFAULT_PARAMS: DrawdownParams = {
    currentAge: 55,
    hasSpouse: false,
    spouseAge: 55,
    retirementAge: 62,
    endAge: 95,
    filingStatus: 'mfj',
    state: 'TX',
    stateFlatRatePct: 0,
    spending: 80_000,
    inflationPct: 2.5,
    returnsPct: { taxable: 5, traditional: 5, roth: 6, hsa: 5 },
    gainsPct: 50,
    ssEnabled: true,
    ssStartAge: 67,
    ssAnnualOverride: null,
    sequencingKey: 'taxableFirst',
    conversionsEnabled: true,
    conversionBracketPct: 22,
    balanceOverrides: { taxable: null, traditional: null, roth: null, hsa: null },
};

const STORAGE_KEY = 'drawdown.params.v1';

function loadParams(): { params: DrawdownParams; fromStorage: boolean } {
    if (typeof window === 'undefined') return { params: DEFAULT_PARAMS, fromStorage: false };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { params: DEFAULT_PARAMS, fromStorage: false };
        const parsed = JSON.parse(raw) as Partial<DrawdownParams>;
        return {
            params: {
                ...DEFAULT_PARAMS,
                ...parsed,
                returnsPct: { ...DEFAULT_PARAMS.returnsPct, ...(parsed.returnsPct ?? {}) },
                balanceOverrides: { ...DEFAULT_PARAMS.balanceOverrides, ...(parsed.balanceOverrides ?? {}) },
            },
            fromStorage: true,
        };
    } catch {
        return { params: DEFAULT_PARAMS, fromStorage: false };
    }
}

/* ------------------------------------------------------------------ */
/* Prefill API response                                                */
/* ------------------------------------------------------------------ */

interface PrefillData {
    balances: BucketAmounts;
    accounts: Array<{ guid: string; name: string; path: string; bucket: Bucket; balance: number }>;
    birthday: string | null;
    currentAge: number | null;
    socialSecurity:
        | { available: true; birthYear: number; annualBenefitByClaimAge: Record<number, number> }
        | { available: false; reason: string };
}

/* ------------------------------------------------------------------ */
/* Small form controls                                                 */
/* ------------------------------------------------------------------ */

const INPUT_CLASS =
    'w-full bg-background-tertiary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
    return (
        <label className="block">
            <span className="block text-xs font-medium text-foreground-secondary mb-1">{label}</span>
            {children}
            {hint && <span className="block mt-1 text-[11px] text-foreground-muted">{hint}</span>}
        </label>
    );
}

function NumField({ label, value, onChange, step = 1, hint }: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    step?: number;
    hint?: React.ReactNode;
}) {
    return (
        <Field label={label} hint={hint}>
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button
            type="button"
            onClick={() => onChange(!checked)}
            className="flex items-center gap-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
            aria-pressed={checked}
        >
            <span
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150 ${
                    checked ? 'bg-primary' : 'bg-background-tertiary border border-border'
                }`}
            >
                <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface-elevated shadow transition-transform duration-150 ${
                        checked ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                />
            </span>
            {label}
        </button>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function DrawdownPlannerPage() {
    const initial = useRef(loadParams());
    const [params, setParams] = useState<DrawdownParams>(initial.current.params);
    const [prefill, setPrefill] = useState<PrefillData | null>(null);
    const [prefillState, setPrefillState] = useState<'loading' | 'loaded' | 'error'>('loading');

    const patch = (p: Partial<DrawdownParams>) => setParams(prev => ({ ...prev, ...p }));

    /* --- Persist scenario to localStorage --- */
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
        } catch {
            // localStorage unavailable; non-fatal
        }
    }, [params]);

    /* --- Prefill from the book --- */
    useEffect(() => {
        let cancelled = false;
        async function fetchPrefill() {
            try {
                const res = await fetch('/api/tools/drawdown/prefill');
                if (!res.ok) throw new Error('prefill failed');
                const data: PrefillData = await res.json();
                if (cancelled) return;
                setPrefill(data);
                setPrefillState('loaded');
                // Only auto-fill the age when the user has no saved scenario.
                if (!initial.current.fromStorage && data.currentAge !== null) {
                    setParams(prev => ({
                        ...prev,
                        currentAge: data.currentAge!,
                        retirementAge: Math.max(prev.retirementAge, data.currentAge!),
                    }));
                }
            } catch {
                if (!cancelled) setPrefillState('error');
            }
        }
        fetchPrefill();
        return () => { cancelled = true; };
    }, []);

    /* --- Effective values (override ?? book) --- */
    const effectiveBalances = useMemo<BucketAmounts>(() => {
        const result = { taxable: 0, traditional: 0, roth: 0, hsa: 0 };
        for (const bucket of BUCKETS) {
            result[bucket] = params.balanceOverrides[bucket] ?? prefill?.balances[bucket] ?? 0;
        }
        return result;
    }, [params.balanceOverrides, prefill]);

    const ssClaimAge = Math.min(70, Math.max(62, Math.round(params.ssStartAge)));
    const ssComputed =
        prefill?.socialSecurity.available === true
            ? prefill.socialSecurity.annualBenefitByClaimAge[ssClaimAge] ?? null
            : null;
    const ssAnnual = params.ssAnnualOverride ?? ssComputed ?? 0;

    /* --- Run the engine --- */
    const inputs = useMemo<DrawdownInputs>(() => {
        const retirementAge = Math.max(params.currentAge, params.retirementAge);
        return {
            currentAge: params.currentAge,
            spouseAge: params.hasSpouse ? params.spouseAge : null,
            retirementAge,
            endAge: Math.max(retirementAge, params.endAge),
            startYear: new Date().getFullYear(),
            filingStatus: params.filingStatus,
            state: params.state,
            stateFlatRateOverride: params.state === 'OTHER' ? params.stateFlatRatePct / 100 : undefined,
            startingBalances: effectiveBalances,
            nominalReturns: {
                taxable: params.returnsPct.taxable / 100,
                traditional: params.returnsPct.traditional / 100,
                roth: params.returnsPct.roth / 100,
                hsa: params.returnsPct.hsa / 100,
            },
            annualSpending: Math.max(0, params.spending),
            inflationRate: params.inflationPct / 100,
            taxableGainsFraction: Math.min(100, Math.max(0, params.gainsPct)) / 100,
            socialSecurity: params.ssEnabled && ssAnnual > 0
                ? { startAge: params.ssStartAge, annualBenefit: ssAnnual }
                : null,
            sequencing: SEQUENCING_PRESETS[params.sequencingKey].order,
            conversions: {
                enabled: params.conversionsEnabled,
                targetBracketRate: params.conversionBracketPct / 100,
            },
        };
    }, [params, effectiveBalances, ssAnnual]);

    const comparison = useMemo(() => compareConversions(inputs), [inputs]);
    const active = params.conversionsEnabled ? comparison.withConversions : comparison.withoutConversions;
    const { summary } = active;

    const assumptionsSummary =
        `Age ${params.currentAge} → retire ${params.retirementAge} → ${params.endAge} · ` +
        `${fmt.format(params.spending)}/yr · ${FILING_STATUS_LABELS[params.filingStatus]} · ${params.state}` +
        (params.conversionsEnabled ? ` · convert to ${params.conversionBracketPct}%` : ' · no conversions');

    const totalStart = effectiveBalances.taxable + effectiveBalances.traditional
        + effectiveBalances.roth + effectiveBalances.hsa;

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Drawdown &amp; Roth Conversion Planner</h1>
                <p className="text-foreground-muted mt-1">
                    Year-by-year retirement spend-down with withdrawal sequencing, SECURE 2.0 RMDs,
                    IRMAA warnings, and bracket-filling Roth conversions. Estimates only — not tax advice.
                </p>
            </header>

            {/* Headline stats */}
            <StatGrid cols={5}>
                <StatCard
                    label="Lifetime Tax"
                    value={fmt.format(summary.lifetimeTax)}
                    sub={`Federal ${fmt.format(summary.lifetimeFederalTax)} · State ${fmt.format(summary.lifetimeStateTax)}`}
                />
                <StatCard
                    label="Conversion Tax Savings"
                    value={fmt.format(comparison.delta.lifetimeTaxSavings)}
                    sub="Lifetime tax: off − on"
                    tone={comparison.delta.lifetimeTaxSavings > 0 ? 'positive'
                        : comparison.delta.lifetimeTaxSavings < 0 ? 'negative' : 'default'}
                />
                <StatCard
                    label="Total Converted"
                    value={fmt.format(comparison.withConversions.summary.totalConversions)}
                    sub={`Filling the ${params.conversionBracketPct}% bracket before age ${summary.rmdStartAge}`}
                    tone="primary"
                />
                <StatCard
                    label="Ending Net Worth"
                    value={fmt.format(summary.endingTotal)}
                    sub={`Roth ${fmt.format(summary.endingBalances.roth)} at age ${params.endAge}`}
                />
                <StatCard
                    label={summary.depletionAge !== null ? 'Money Runs Out' : 'Plan Survives'}
                    value={summary.depletionAge !== null ? `Age ${summary.depletionAge}` : `To ${params.endAge}`}
                    sub={summary.irmaaYearCount > 0
                        ? `${summary.irmaaYearCount} IRMAA year${summary.irmaaYearCount === 1 ? '' : 's'} · RMDs at ${summary.rmdStartAge}`
                        : `No IRMAA years · RMDs at ${summary.rmdStartAge}`}
                    tone={summary.depletionAge !== null ? 'negative' : 'positive'}
                />
            </StatGrid>

            {/* Prefill status */}
            {prefillState === 'loading' && (
                <section className="bg-surface/30 border border-border rounded-xl p-4 flex items-center gap-3">
                    <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
                    <span className="text-sm text-foreground-muted">Loading balances from your book…</span>
                </section>
            )}
            {prefillState === 'error' && (
                <section className="bg-surface/30 border border-warning/30 rounded-xl p-4">
                    <span className="text-sm text-warning">
                        Couldn&apos;t load book data — enter starting balances manually below.
                    </span>
                </section>
            )}

            {/* Balances chart */}
            <section className="bg-surface/30 border border-border rounded-xl p-4 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <div>
                        <h2 className="text-lg font-semibold text-foreground">Balances by Bucket</h2>
                        <p className="text-xs text-foreground-muted mt-0.5">
                            Nominal end-of-year balances · starting total {fmt.format(totalStart)}
                        </p>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-foreground-muted">
                        {BUCKETS.map(bucket => (
                            <span key={bucket} className="flex items-center gap-1.5">
                                <span
                                    className="inline-block w-3 h-3 rounded-sm"
                                    style={{ backgroundColor: BUCKET_COLORS[bucket], opacity: 0.7 }}
                                />
                                {BUCKET_LABELS[bucket]}
                            </span>
                        ))}
                    </div>
                </div>
                <DrawdownChart
                    rows={active.rows}
                    retirementAge={params.retirementAge}
                    ssStartAge={params.ssEnabled && ssAnnual > 0 ? params.ssStartAge : null}
                    rmdStartAge={summary.rmdStartAge}
                    depletionAge={summary.depletionAge}
                />
            </section>

            {/* Conversions on/off comparison */}
            <section className="bg-surface/30 border border-border rounded-xl p-4 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <div>
                        <h2 className="text-lg font-semibold text-foreground">Roth Conversions: On vs Off</h2>
                        <p className="text-xs text-foreground-muted mt-0.5">
                            Same scenario, with and without bracket-filling conversions to the top of the {params.conversionBracketPct}% bracket
                        </p>
                    </div>
                    <Toggle
                        checked={params.conversionsEnabled}
                        onChange={v => patch({ conversionsEnabled: v })}
                        label={params.conversionsEnabled ? 'Conversions on' : 'Conversions off'}
                    />
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full max-w-2xl text-sm" style={{ fontFeatureSettings: "'tnum'" }}>
                        <thead>
                            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-foreground-muted">
                                <th className="text-left px-2 py-1.5 font-semibold">Metric</th>
                                <th className="text-right px-2 py-1.5 font-semibold">Conversions Off</th>
                                <th className="text-right px-2 py-1.5 font-semibold">Conversions On</th>
                                <th className="text-right px-2 py-1.5 font-semibold">Delta</th>
                            </tr>
                        </thead>
                        <tbody className="font-mono text-xs">
                            {([
                                ['Lifetime tax',
                                    comparison.withoutConversions.summary.lifetimeTax,
                                    comparison.withConversions.summary.lifetimeTax,
                                    -comparison.delta.lifetimeTaxSavings],
                                ['Total converted', 0,
                                    comparison.withConversions.summary.totalConversions,
                                    comparison.withConversions.summary.totalConversions],
                                ['Ending traditional',
                                    comparison.withoutConversions.summary.endingBalances.traditional,
                                    comparison.withConversions.summary.endingBalances.traditional,
                                    comparison.delta.endingTraditional],
                                ['Ending Roth',
                                    comparison.withoutConversions.summary.endingBalances.roth,
                                    comparison.withConversions.summary.endingBalances.roth,
                                    comparison.delta.endingRoth],
                                ['Ending net worth',
                                    comparison.withoutConversions.summary.endingTotal,
                                    comparison.withConversions.summary.endingTotal,
                                    comparison.delta.endingTotal],
                            ] as Array<[string, number, number, number]>).map(([label, off, on, delta]) => (
                                <tr key={label} className="border-b border-border/50">
                                    <td className="px-2 py-1.5 text-foreground-secondary font-sans">{label}</td>
                                    <td className="px-2 py-1.5 text-right text-foreground-secondary">{fmt.format(off)}</td>
                                    <td className="px-2 py-1.5 text-right text-foreground">{fmt.format(on)}</td>
                                    <td className={`px-2 py-1.5 text-right ${
                                        delta > 0 ? 'text-positive' : delta < 0 ? 'text-negative' : 'text-foreground-muted'
                                    }`}>
                                        {delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${fmt.format(delta)}`}
                                    </td>
                                </tr>
                            ))}
                            <tr>
                                <td className="px-2 py-1.5 text-foreground-secondary font-sans">IRMAA years</td>
                                <td className="px-2 py-1.5 text-right text-foreground-secondary">
                                    {comparison.withoutConversions.summary.irmaaYearCount}
                                </td>
                                <td className="px-2 py-1.5 text-right text-foreground">
                                    {comparison.withConversions.summary.irmaaYearCount}
                                </td>
                                <td className={`px-2 py-1.5 text-right ${
                                    comparison.delta.irmaaYearCount > 0 ? 'text-warning' : 'text-foreground-muted'
                                }`}>
                                    {comparison.delta.irmaaYearCount === 0 ? '—'
                                        : `${comparison.delta.irmaaYearCount > 0 ? '+' : ''}${comparison.delta.irmaaYearCount}`}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Assumptions */}
            <CollapsibleConfigSection
                title="Assumptions"
                summary={assumptionsSummary}
                configured={prefillState !== 'loading'}
                storageKey="drawdown.assumptionsOpen"
            >
                <div className="space-y-5">
                    {/* Ages + filing */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
                        <NumField
                            label="Current Age"
                            value={params.currentAge}
                            onChange={v => patch({ currentAge: Math.min(100, Math.max(18, Math.round(v))) })}
                            hint={prefill?.birthday ? `From your birthday (${prefill.birthday})` : undefined}
                        />
                        <NumField
                            label="Retirement Age"
                            value={params.retirementAge}
                            onChange={v => patch({ retirementAge: Math.min(100, Math.max(18, Math.round(v))) })}
                        />
                        <NumField
                            label="Plan To Age"
                            value={params.endAge}
                            onChange={v => patch({ endAge: Math.min(110, Math.max(50, Math.round(v))) })}
                        />
                        <div className="space-y-2">
                            <Toggle
                                checked={params.hasSpouse}
                                onChange={v => patch({ hasSpouse: v })}
                                label="Spouse"
                            />
                            {params.hasSpouse && (
                                <NumField
                                    label="Spouse Age"
                                    value={params.spouseAge}
                                    onChange={v => patch({ spouseAge: Math.min(100, Math.max(18, Math.round(v))) })}
                                />
                            )}
                        </div>
                        <Field label="Filing Status">
                            <select
                                className={INPUT_CLASS}
                                value={params.filingStatus}
                                onChange={e => patch({ filingStatus: e.target.value as FilingStatus })}
                            >
                                {FILING_STATUSES.map(fs => (
                                    <option key={fs} value={fs}>{FILING_STATUS_LABELS[fs]}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="State">
                            <select
                                className={INPUT_CLASS}
                                value={params.state}
                                onChange={e => patch({ state: e.target.value })}
                            >
                                {STATE_OPTIONS.map(s => (
                                    <option key={s.code} value={s.code}>{s.name}</option>
                                ))}
                            </select>
                        </Field>
                        {params.state === 'OTHER' && (
                            <NumField
                                label="State Flat Rate %"
                                value={params.stateFlatRatePct}
                                onChange={v => patch({ stateFlatRatePct: Math.max(0, v) })}
                                step={0.1}
                            />
                        )}
                        <NumField
                            label="Annual Spending ($ today)"
                            value={params.spending}
                            onChange={v => patch({ spending: Math.max(0, v) })}
                            step={1000}
                        />
                        <NumField
                            label="Inflation %"
                            value={params.inflationPct}
                            onChange={v => patch({ inflationPct: Math.max(0, v) })}
                            step={0.1}
                        />
                    </div>

                    {/* Starting balances */}
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                            Starting Balances {prefillState === 'loaded' ? '(prefilled from your book)' : ''}
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
                            {BUCKETS.map(bucket => {
                                const computed = prefill?.balances[bucket] ?? null;
                                const override = params.balanceOverrides[bucket];
                                return (
                                    <Field
                                        key={bucket}
                                        label={BUCKET_LABELS[bucket]}
                                        hint={override !== null && computed !== null ? (
                                            <button
                                                type="button"
                                                className="text-primary hover:text-primary-hover"
                                                onClick={() => patch({
                                                    balanceOverrides: { ...params.balanceOverrides, [bucket]: null },
                                                })}
                                            >
                                                Reset to book value ({fmt.format(computed)})
                                            </button>
                                        ) : computed !== null ? 'From book' : undefined}
                                    >
                                        <input
                                            type="number"
                                            className={INPUT_CLASS}
                                            value={Math.round(effectiveBalances[bucket])}
                                            step={1000}
                                            onChange={e => {
                                                const v = parseFloat(e.target.value);
                                                if (Number.isFinite(v)) {
                                                    patch({
                                                        balanceOverrides: {
                                                            ...params.balanceOverrides,
                                                            [bucket]: Math.max(0, v),
                                                        },
                                                    });
                                                }
                                            }}
                                        />
                                    </Field>
                                );
                            })}
                        </div>
                        {prefill && prefill.accounts.length > 0 && (
                            <details className="mt-2">
                                <summary className="text-[11px] text-foreground-muted cursor-pointer hover:text-foreground-secondary">
                                    {prefill.accounts.length} account{prefill.accounts.length === 1 ? '' : 's'} mapped from the book
                                </summary>
                                <ul className="mt-1 space-y-0.5 text-[11px] text-foreground-muted font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                                    {prefill.accounts.map(a => (
                                        <li key={a.guid} className="flex justify-between gap-4">
                                            <span className="truncate">{a.path}</span>
                                            <span className="shrink-0">
                                                {BUCKET_LABELS[a.bucket]} · {fmt.format(a.balance)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        )}
                    </div>

                    {/* Returns */}
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                            Expected Nominal Return % per Bucket
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
                            {BUCKETS.map(bucket => (
                                <NumField
                                    key={bucket}
                                    label={BUCKET_LABELS[bucket]}
                                    value={params.returnsPct[bucket]}
                                    onChange={v => patch({
                                        returnsPct: { ...params.returnsPct, [bucket]: v },
                                    })}
                                    step={0.5}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Social Security + withdrawal strategy */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
                        <div className="space-y-2">
                            <Toggle
                                checked={params.ssEnabled}
                                onChange={v => patch({ ssEnabled: v })}
                                label="Social Security"
                            />
                            {params.ssEnabled && (
                                <NumField
                                    label="Claim Age"
                                    value={params.ssStartAge}
                                    onChange={v => patch({ ssStartAge: Math.min(70, Math.max(62, Math.round(v))) })}
                                />
                            )}
                        </div>
                        {params.ssEnabled && (
                            <Field
                                label="Annual Benefit ($ today)"
                                hint={params.ssAnnualOverride !== null && ssComputed !== null ? (
                                    <button
                                        type="button"
                                        className="text-primary hover:text-primary-hover"
                                        onClick={() => patch({ ssAnnualOverride: null })}
                                    >
                                        Reset to book estimate ({fmt.format(ssComputed)})
                                    </button>
                                ) : ssComputed !== null
                                    ? `Estimated from book earnings at age ${ssClaimAge}`
                                    : 'No book earnings history — enter manually'}
                            >
                                <input
                                    type="number"
                                    className={INPUT_CLASS}
                                    value={Math.round(ssAnnual)}
                                    step={1000}
                                    onChange={e => {
                                        const v = parseFloat(e.target.value);
                                        if (Number.isFinite(v)) patch({ ssAnnualOverride: Math.max(0, v) });
                                    }}
                                />
                            </Field>
                        )}
                        <Field label="Withdrawal Order">
                            <select
                                className={INPUT_CLASS}
                                value={params.sequencingKey}
                                onChange={e => patch({ sequencingKey: e.target.value as SequencingKey })}
                            >
                                {(Object.keys(SEQUENCING_PRESETS) as SequencingKey[]).map(key => (
                                    <option key={key} value={key}>{SEQUENCING_PRESETS[key].label}</option>
                                ))}
                            </select>
                        </Field>
                        <NumField
                            label="Taxable Withdrawal: % LT Gains"
                            value={params.gainsPct}
                            onChange={v => patch({ gainsPct: Math.min(100, Math.max(0, v)) })}
                            step={5}
                            hint="Share of each taxable-account withdrawal that is long-term gain (rest is basis)"
                        />
                    </div>

                    {/* Conversions */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 items-end">
                        <div className="space-y-2">
                            <Toggle
                                checked={params.conversionsEnabled}
                                onChange={v => patch({ conversionsEnabled: v })}
                                label="Roth conversions"
                            />
                        </div>
                        <Field
                            label="Fill To Top Of Bracket"
                            hint={`Convert traditional → Roth in retirement years before age ${summary.rmdStartAge}`}
                        >
                            <select
                                className={INPUT_CLASS}
                                value={params.conversionBracketPct}
                                onChange={e => patch({ conversionBracketPct: parseInt(e.target.value, 10) })}
                                disabled={!params.conversionsEnabled}
                            >
                                {CONVERSION_BRACKETS.map(rate => (
                                    <option key={rate} value={rate}>{rate}% bracket</option>
                                ))}
                            </select>
                        </Field>
                    </div>
                </div>
            </CollapsibleConfigSection>

            {/* Per-year table */}
            <section className="bg-surface/30 border border-border rounded-xl p-4 sm:p-6">
                <h2 className="text-lg font-semibold text-foreground mb-1">Year-by-Year Projection</h2>
                <p className="text-xs text-foreground-muted mb-3">
                    Nominal dollars · {params.conversionsEnabled ? 'with' : 'without'} Roth conversions ·
                    IRMAA flags apply from age 63 (two-year premium lookback)
                </p>
                <DrawdownTable rows={active.rows} />
            </section>

            {/* Methodology footnote */}
            <p className="text-xs text-foreground-muted">
                Methodology: withdrawals at the start of each year, growth on the remainder. Federal and
                state taxes use the built-in tax engine (2026 rules, inflation-indexed beyond 2026). Taxable withdrawals are {params.gainsPct}% long-term gain / {100 - params.gainsPct}% basis;
                Roth and HSA withdrawals are assumed qualified and tax-free. RMDs use the IRS Uniform Lifetime
                Table with SECURE 2.0 start ages (73 for those born 1951–1959, 75 for 1960+). IRMAA tiers are
                2026 thresholds indexed by your inflation assumption; surcharge estimates are per enrollee.
                Estimates only — not tax, legal, or investment advice.
            </p>
        </div>
    );
}
