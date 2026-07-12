'use client';

/**
 * Scenario Sandbox — one what-if definition threaded through the existing
 * engines, side by side with baseline:
 *  - Cash flow (5 yr): trailing run-rate baseline vs scenario deltas, with
 *    negative-liquid-balance warnings.
 *  - Net worth (30 yr): deterministic projection with assets + loan balances.
 *  - Tax (current + next year): federal + state with income/deduction deltas,
 *    itemize-vs-standard computed both ways.
 *  - FIRE: deterministic FI-date shift with adjusted spending/saving.
 *
 * The scenario runs server-side (POST /api/tools/scenario); named scenarios
 * persist per user via the user-preferences PUT pattern, with the working
 * scenario mirrored to localStorage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { FILING_STATUS_LABELS } from '@/lib/tax/types';
import {
    DEFAULT_SCENARIO_ASSUMPTIONS,
    SCENARIO_PREF_KEY,
    mergeScenarioAssumptions,
    type SavedScenario,
    type Scenario,
    type ScenarioAssumptions,
    type ScenarioBaseline,
    type ScenarioRunResult,
    type TaxYearComparison,
} from '@/lib/scenario/types';
import ScenarioBuilder from './ScenarioBuilder';
import { CashFlowChart, ChartLegend, NetWorthChart } from './ScenarioCharts';

const WORKING_KEY = 'scenario-sandbox.working.v1';

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const TNUM = { fontFeatureSettings: "'tnum'" } as const;

const EMPTY_SCENARIO: Scenario = { name: 'My scenario', deltas: [] };

interface WorkingState {
    scenario: Scenario;
    assumptions: ScenarioAssumptions;
}

function loadWorking(): WorkingState {
    if (typeof window === 'undefined') {
        return { scenario: EMPTY_SCENARIO, assumptions: DEFAULT_SCENARIO_ASSUMPTIONS };
    }
    try {
        const raw = localStorage.getItem(WORKING_KEY);
        if (!raw) return { scenario: EMPTY_SCENARIO, assumptions: DEFAULT_SCENARIO_ASSUMPTIONS };
        const parsed = JSON.parse(raw) as Partial<WorkingState>;
        return {
            scenario: parsed.scenario && Array.isArray(parsed.scenario.deltas)
                ? parsed.scenario
                : EMPTY_SCENARIO,
            assumptions: mergeScenarioAssumptions(parsed.assumptions),
        };
    } catch {
        return { scenario: EMPTY_SCENARIO, assumptions: DEFAULT_SCENARIO_ASSUMPTIONS };
    }
}

function signedFmt(v: number): string {
    return `${v > 0 ? '+' : ''}${fmt.format(v)}`;
}

function fmtShift(years: number | null): string {
    if (years === null) return '—';
    if (years === 0) return 'No change';
    const abs = Math.abs(years);
    return `${years > 0 ? '+' : '−'}${abs} yr${abs === 1 ? '' : 's'} ${years > 0 ? 'later' : 'earlier'}`;
}

const INPUT_CLASS =
    'w-full bg-background-tertiary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground font-mono focus:outline-none focus:border-primary/50';

/* ------------------------------------------------------------------ */
/* Tax comparison card                                                 */
/* ------------------------------------------------------------------ */

function TaxCard({ title, cmp }: { title: string; cmp: TaxYearComparison }) {
    const decision = cmp.itemizeDecision;
    return (
        <div className="bg-surface/30 border border-border rounded-xl p-4 sm:p-5 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                <span className="text-[11px] text-foreground-muted">{cmp.taxYear} rules</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs font-mono" style={TNUM}>
                <div>
                    <p className="text-[10px] uppercase tracking-wider text-foreground-muted font-sans">Baseline</p>
                    <p className="text-foreground-secondary mt-0.5">{fmt.format(cmp.baseline.total)}</p>
                </div>
                <div>
                    <p className="text-[10px] uppercase tracking-wider text-foreground-muted font-sans">Scenario</p>
                    <p className="text-foreground mt-0.5">{fmt.format(cmp.scenario.total)}</p>
                </div>
                <div>
                    <p className="text-[10px] uppercase tracking-wider text-foreground-muted font-sans">Delta</p>
                    <p className={`mt-0.5 font-semibold ${cmp.delta > 0 ? 'text-negative' : cmp.delta < 0 ? 'text-positive' : 'text-foreground-muted'}`}>
                        {cmp.delta === 0 ? '—' : signedFmt(cmp.delta)}
                    </p>
                </div>
            </div>
            <div className="text-[11px] text-foreground-muted space-y-1 border-t border-border/50 pt-2">
                <p>
                    Marginal bracket:{' '}
                    <span className="text-foreground-secondary font-mono" style={TNUM}>
                        {(cmp.baseline.marginalRate * 100).toFixed(0)}% → {(cmp.scenario.marginalRate * 100).toFixed(0)}%
                    </span>
                    {' · '}Federal {signedFmt(cmp.scenario.federalTax - cmp.baseline.federalTax)}
                    {' · '}State {signedFmt(cmp.scenario.stateTax - cmp.baseline.stateTax)}
                </p>
                <p>
                    Deduction:{' '}
                    <span className={decision.picked === 'itemized' ? 'text-primary font-medium' : 'text-foreground-secondary font-medium'}>
                        {decision.picked === 'itemized' ? 'Itemize' : 'Standard'}
                    </span>
                    {' — '}itemized <span className="font-mono" style={TNUM}>{fmt.format(decision.itemized)}</span>
                    {' vs standard '}<span className="font-mono" style={TNUM}>{fmt.format(decision.standard)}</span>
                    {decision.picked === 'itemized'
                        ? ` (itemizing wins by ${fmt.format(decision.advantage)})`
                        : decision.itemized > 0
                            ? ` (standard wins by ${fmt.format(-decision.advantage)})`
                            : ''}
                </p>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ScenarioSandboxPage() {
    const initial = useRef(loadWorking());
    const [scenario, setScenario] = useState<Scenario>(initial.current.scenario);
    const [assumptions, setAssumptions] = useState<ScenarioAssumptions>(initial.current.assumptions);

    const [baseline, setBaseline] = useState<ScenarioBaseline | null>(null);
    const [baselineState, setBaselineState] = useState<'loading' | 'loaded' | 'error'>('loading');
    const [result, setResult] = useState<ScenarioRunResult | null>(null);
    const [running, setRunning] = useState(false);
    const [runError, setRunError] = useState<string | null>(null);

    const [saved, setSaved] = useState<SavedScenario[]>([]);
    const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    const patchAssumptions = (p: Partial<ScenarioAssumptions>) =>
        setAssumptions(prev => mergeScenarioAssumptions({ ...prev, ...p }));

    /* --- Persist the working scenario locally --- */
    useEffect(() => {
        try {
            localStorage.setItem(WORKING_KEY, JSON.stringify({ scenario, assumptions }));
        } catch {
            // localStorage unavailable; non-fatal
        }
    }, [scenario, assumptions]);

    /* --- Baseline prefill + saved scenarios --- */
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/tools/scenario');
                if (!res.ok) throw new Error('prefill failed');
                const data = await res.json() as {
                    baseline: ScenarioBaseline;
                    savedScenarios: SavedScenario[];
                };
                if (cancelled) return;
                setBaseline(data.baseline);
                setSaved(Array.isArray(data.savedScenarios) ? data.savedScenarios : []);
                setBaselineState('loaded');
            } catch {
                if (!cancelled) setBaselineState('error');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    /* --- Run the scenario (debounced, server-side) --- */
    useEffect(() => {
        if (baselineState !== 'loaded') return;
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            setRunning(true);
            setRunError(null);
            try {
                const res = await fetch('/api/tools/scenario', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scenario, assumptions }),
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error('run failed');
                const data = await res.json() as { result: ScenarioRunResult; baseline: ScenarioBaseline };
                setResult(data.result);
                setBaseline(data.baseline);
                setRunning(false);
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    setRunError('Couldn’t run the scenario — try again.');
                    setRunning(false);
                }
            }
        }, 450);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [scenario, assumptions, baselineState]);

    /* --- Save / load named scenarios via user preferences --- */
    const persistSaved = useCallback(async (list: SavedScenario[]) => {
        setSavingState('saving');
        try {
            const res = await fetch('/api/user/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferences: { [SCENARIO_PREF_KEY]: list } }),
            });
            if (!res.ok) throw new Error('save failed');
            setSaved(list);
            setSavingState('saved');
            setTimeout(() => setSavingState('idle'), 2000);
        } catch {
            setSavingState('error');
            setTimeout(() => setSavingState('idle'), 3000);
        }
    }, []);

    const saveCurrent = () => {
        const name = scenario.name.trim() || 'Untitled scenario';
        const entry: SavedScenario = {
            scenario: { ...scenario, name },
            assumptions,
            savedAt: new Date().toISOString(),
        };
        const list = [...saved.filter(s => s.scenario.name !== name), entry]
            .sort((a, b) => a.scenario.name.localeCompare(b.scenario.name));
        void persistSaved(list);
    };

    const loadSaved = (name: string) => {
        const entry = saved.find(s => s.scenario.name === name);
        if (!entry) return;
        setScenario(entry.scenario);
        setAssumptions(mergeScenarioAssumptions(entry.assumptions));
    };

    const deleteSaved = (name: string) => {
        void persistSaved(saved.filter(s => s.scenario.name !== name));
    };

    /* --- Derived headline numbers --- */
    const cash = result?.cashFlow ?? null;
    const lastCash = cash && cash.months.length > 0 ? cash.months[cash.months.length - 1] : null;
    const cashDelta5yr = lastCash ? lastCash.scenarioBalance - lastCash.baselineBalance : 0;
    const nwDelta = result?.netWorth.endingDelta ?? 0;
    const taxDeltaNow = result?.tax.currentYear.delta ?? 0;
    const fire = result?.fire ?? null;

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Scenario Sandbox</h1>
                <p className="text-foreground-muted mt-1">
                    Model one what-if — a house, a raise, a new loan — and see it side by side
                    with your baseline across cash flow, net worth, taxes, and your FI date.
                    Deterministic estimates only — not financial advice.
                </p>
            </header>

            {/* Headline stats */}
            {result && (
                <StatGrid cols={5}>
                    <StatCard
                        label="First Negative Month"
                        value={cash?.firstNegativeMonth ?? 'None'}
                        sub={cash && cash.negativeMonths.length > 0
                            ? `${cash.negativeMonths.length} negative month${cash.negativeMonths.length === 1 ? '' : 's'} in ${Math.round(result.assumptions.cashFlowMonths / 12)} yrs`
                            : `Liquid stays positive for ${Math.round(result.assumptions.cashFlowMonths / 12)} yrs`}
                        tone={cash && cash.firstNegativeMonth ? 'negative' : 'positive'}
                    />
                    <StatCard
                        label={`Cash After ${Math.round(result.assumptions.cashFlowMonths / 12)} Yrs`}
                        value={signedFmt(cashDelta5yr)}
                        sub="Scenario vs baseline liquid balance"
                        tone={cashDelta5yr > 0 ? 'positive' : cashDelta5yr < 0 ? 'negative' : 'default'}
                    />
                    <StatCard
                        label={`Net Worth In ${result.assumptions.netWorthYears} Yrs`}
                        value={signedFmt(nwDelta)}
                        sub={`Scenario ${fmt.format(result.netWorth.endingScenario)} vs ${fmt.format(result.netWorth.endingBaseline)}`}
                        tone={nwDelta > 0 ? 'positive' : nwDelta < 0 ? 'negative' : 'default'}
                    />
                    <StatCard
                        label={`Tax ${result.tax.currentYear.calendarYear}`}
                        value={taxDeltaNow === 0 ? 'No change' : signedFmt(taxDeltaNow)}
                        sub={result.tax.currentYear.itemizeDecision.picked === 'itemized'
                            ? 'Scenario itemizes deductions'
                            : 'Scenario takes the standard deduction'}
                        tone={taxDeltaNow > 0 ? 'negative' : taxDeltaNow < 0 ? 'positive' : 'default'}
                    />
                    <StatCard
                        label="FI Date"
                        value={fmtShift(fire?.shiftYears ?? null)}
                        sub={fire?.scenarioFiYear
                            ? `Scenario FI ${fire.scenarioFiYear}${fire.scenarioFiAge ? ` (age ${fire.scenarioFiAge})` : ''}`
                            : 'Not reached within 60 years'}
                        tone={fire?.shiftYears == null ? 'default'
                            : fire.shiftYears > 0 ? 'negative'
                                : fire.shiftYears < 0 ? 'positive' : 'default'}
                    />
                </StatGrid>
            )}

            {/* Baseline status */}
            {baselineState === 'loading' && (
                <section className="bg-surface/30 border border-border rounded-xl p-4 flex items-center gap-3">
                    <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
                    <span className="text-sm text-foreground-muted">Loading your baseline from the book…</span>
                </section>
            )}
            {baselineState === 'error' && (
                <section className="bg-surface/30 border border-warning/30 rounded-xl p-4">
                    <span className="text-sm text-warning">
                        Couldn&apos;t load book data — the sandbox needs the baseline to run.
                    </span>
                </section>
            )}

            {/* Builder + save/load */}
            <section className="bg-surface/30 border border-border rounded-xl p-4 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h2 className="text-lg font-semibold text-foreground">Scenario</h2>
                        <p className="text-xs text-foreground-muted mt-0.5">
                            A list of changes starting at a date, applied on top of your baseline
                            {running && <span className="text-primary"> · recomputing…</span>}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            type="text"
                            className={`${INPUT_CLASS} w-48 font-sans`}
                            value={scenario.name}
                            placeholder="Scenario name"
                            onChange={e => setScenario({ ...scenario, name: e.target.value })}
                        />
                        <button
                            type="button"
                            onClick={saveCurrent}
                            disabled={savingState === 'saving'}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50"
                        >
                            {savingState === 'saving' ? 'Saving…'
                                : savingState === 'saved' ? 'Saved ✓'
                                    : savingState === 'error' ? 'Save failed' : 'Save'}
                        </button>
                        {saved.length > 0 && (
                            <select
                                className={`${INPUT_CLASS} w-44 font-sans`}
                                value=""
                                onChange={e => { if (e.target.value) loadSaved(e.target.value); }}
                            >
                                <option value="">Load saved…</option>
                                {saved.map(s => (
                                    <option key={s.scenario.name} value={s.scenario.name}>
                                        {s.scenario.name}
                                    </option>
                                ))}
                            </select>
                        )}
                        {saved.some(s => s.scenario.name === scenario.name.trim()) && (
                            <button
                                type="button"
                                onClick={() => deleteSaved(scenario.name.trim())}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground-muted hover:text-negative hover:border-negative/40 transition-colors"
                            >
                                Delete saved
                            </button>
                        )}
                    </div>
                </div>
                <ScenarioBuilder scenario={scenario} onChange={setScenario} />
            </section>

            {/* Negative-month warnings */}
            {cash && cash.negativeMonths.length > 0 && (
                <section className="bg-surface/30 border border-negative/40 rounded-xl p-4">
                    <p className="text-sm text-negative font-medium">
                        Liquid balance goes negative in {cash.negativeMonths.length} month{cash.negativeMonths.length === 1 ? '' : 's'},
                        starting {cash.firstNegativeMonth}.
                    </p>
                    <p className="text-xs text-foreground-muted mt-1">
                        {cash.baselineGoesNegative
                            ? 'The baseline also dips negative in this window — the scenario makes an existing squeeze worse.'
                            : 'The baseline stays positive — this squeeze is caused by the scenario.'}
                        {' '}Consider a smaller one-time outlay, a longer loan term, or trimming a recurring expense.
                    </p>
                </section>
            )}

            {/* Cash flow chart */}
            {result && (
                <section className="bg-surface/30 border border-border rounded-xl p-4 sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                        <div>
                            <h2 className="text-lg font-semibold text-foreground">Cash Flow — Liquid Balance</h2>
                            <p className="text-xs text-foreground-muted mt-0.5">
                                {Math.round(result.assumptions.cashFlowMonths / 12)}-year monthly projection ·
                                baseline net {fmt.format(baseline?.monthlyNet ?? 0)}/mo from the trailing 12 months
                                {result.cashFlow.monthlyTaxDelta !== 0 &&
                                    ` · includes ${signedFmt(-result.cashFlow.monthlyTaxDelta)}/mo steady-state tax effect`}
                            </p>
                        </div>
                        <ChartLegend />
                    </div>
                    <CashFlowChart
                        months={result.cashFlow.months}
                        firstNegativeMonth={result.cashFlow.firstNegativeMonth}
                    />
                </section>
            )}

            {/* Net worth chart */}
            {result && (
                <section className="bg-surface/30 border border-border rounded-xl p-4 sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                        <div>
                            <h2 className="text-lg font-semibold text-foreground">Net Worth</h2>
                            <p className="text-xs text-foreground-muted mt-0.5">
                                {result.assumptions.netWorthYears}-year deterministic projection ·
                                invested assets at {result.assumptions.investedReturnPct}%/yr ·
                                assets appreciate, loan balances amortize
                            </p>
                        </div>
                        <ChartLegend />
                    </div>
                    <NetWorthChart points={result.netWorth.points} />
                </section>
            )}

            {/* Tax + FIRE cards */}
            {result && (
                <div className="grid gap-4 lg:grid-cols-3">
                    <TaxCard title={`Taxes ${result.tax.currentYear.calendarYear}`} cmp={result.tax.currentYear} />
                    <TaxCard title={`Taxes ${result.tax.nextYear.calendarYear}`} cmp={result.tax.nextYear} />
                    <div className="bg-surface/30 border border-border rounded-xl p-4 sm:p-5 space-y-3">
                        <div className="flex items-baseline justify-between gap-2">
                            <h3 className="text-sm font-semibold text-foreground">FIRE Impact</h3>
                            <span className="text-[11px] text-foreground-muted">deterministic</span>
                        </div>
                        {fire && (
                            <>
                                <p className={`text-xl font-mono font-semibold ${
                                    fire.shiftYears == null ? 'text-foreground'
                                        : fire.shiftYears > 0 ? 'text-negative'
                                            : fire.shiftYears < 0 ? 'text-positive' : 'text-foreground'
                                }`} style={TNUM}>
                                    {fmtShift(fire.shiftYears)}
                                </p>
                                <div className="text-[11px] text-foreground-muted space-y-1 border-t border-border/50 pt-2">
                                    <p>
                                        Baseline FI:{' '}
                                        <span className="text-foreground-secondary font-mono" style={TNUM}>
                                            {fire.baselineFiYear ?? 'not within 60 yrs'}
                                            {fire.baselineFiAge ? ` (age ${fire.baselineFiAge})` : ''}
                                        </span>
                                        {' · '}Scenario FI:{' '}
                                        <span className="text-foreground-secondary font-mono" style={TNUM}>
                                            {fire.scenarioFiYear ?? 'not within 60 yrs'}
                                            {fire.scenarioFiAge ? ` (age ${fire.scenarioFiAge})` : ''}
                                        </span>
                                    </p>
                                    <p>
                                        FI number:{' '}
                                        <span className="font-mono" style={TNUM}>{fmt.format(fire.fiNumberBaseline)}</span>
                                        {' → '}
                                        <span className="font-mono" style={TNUM}>{fmt.format(fire.fiNumberScenario)}</span>
                                        {' at '}{result.assumptions.swrPct}% SWR,{' '}
                                        {result.assumptions.fireRealReturnPct}% real return
                                    </p>
                                    <p>
                                        Retirement spending:{' '}
                                        <span className="font-mono" style={TNUM}>{fmt.format(fire.annualExpensesBaseline)}</span>
                                        {' → '}
                                        <span className="font-mono" style={TNUM}>{fmt.format(fire.annualExpensesScenario)}</span>/yr
                                        {' '}(open-ended recurring changes only)
                                    </p>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Loan summaries */}
            {result && result.loans.length > 0 && (
                <section className="bg-surface/30 border border-border rounded-xl p-4 sm:p-6">
                    <h2 className="text-lg font-semibold text-foreground mb-3">Loans in This Scenario</h2>
                    <div className="overflow-x-auto">
                        <table className="w-full max-w-3xl text-xs font-mono" style={TNUM}>
                            <thead>
                                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-foreground-muted font-sans">
                                    <th className="text-left px-2 py-1.5 font-semibold">Loan</th>
                                    <th className="text-right px-2 py-1.5 font-semibold">Principal</th>
                                    <th className="text-right px-2 py-1.5 font-semibold">Rate</th>
                                    <th className="text-right px-2 py-1.5 font-semibold">Term</th>
                                    <th className="text-right px-2 py-1.5 font-semibold">Payment</th>
                                    <th className="text-right px-2 py-1.5 font-semibold">Yr-1 Interest</th>
                                    <th className="text-right px-2 py-1.5 font-semibold">Lifetime Interest</th>
                                </tr>
                            </thead>
                            <tbody>
                                {result.loans.map(loan => (
                                    <tr key={loan.id} className="border-b border-border/50">
                                        <td className="px-2 py-1.5 text-foreground-secondary font-sans">{loan.label}</td>
                                        <td className="px-2 py-1.5 text-right text-foreground-secondary">{fmt.format(loan.principal)}</td>
                                        <td className="px-2 py-1.5 text-right text-foreground-secondary">{loan.annualRatePct}%</td>
                                        <td className="px-2 py-1.5 text-right text-foreground-secondary">{loan.termMonths} mo</td>
                                        <td className="px-2 py-1.5 text-right text-foreground">{fmt.format(loan.monthlyPayment)}/mo</td>
                                        <td className="px-2 py-1.5 text-right text-foreground-secondary">{fmt.format(loan.firstYearInterest)}</td>
                                        <td className="px-2 py-1.5 text-right text-foreground-secondary">{fmt.format(loan.totalInterest)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {runError && (
                <section className="bg-surface/30 border border-warning/30 rounded-xl p-4">
                    <span className="text-sm text-warning">{runError}</span>
                </section>
            )}

            {/* Baseline + model assumptions */}
            <CollapsibleConfigSection
                title="Baseline & Model Assumptions"
                summary={baseline
                    ? `Net worth ${fmt.format(baseline.netWorth)} · ${fmt.format(baseline.monthlyNet)}/mo net · ` +
                      `${FILING_STATUS_LABELS[baseline.filingStatus]} · ${baseline.state} · ` +
                      `${assumptions.investedReturnPct}% return`
                    : 'Loading…'}
                configured={baselineState === 'loaded'}
                storageKey="scenario-sandbox.assumptionsOpen"
            >
                <div className="space-y-5">
                    {baseline && (
                        <div>
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                                Baseline (prefilled from your book, as of {baseline.asOfDate})
                            </h3>
                            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                                {([
                                    ['Net worth', fmt.format(baseline.netWorth)],
                                    ['Liquid (bank + cash)', fmt.format(baseline.liquidBalance)],
                                    ['Invested assets', fmt.format(baseline.investedAssets)],
                                    ['Savings rate', `${baseline.savingsRatePct.toFixed(1)}%`],
                                    ['Monthly income', fmt.format(baseline.monthlyIncome)],
                                    ['Monthly expenses', fmt.format(baseline.monthlyExpenses)],
                                    ['Monthly net', fmt.format(baseline.monthlyNet)],
                                    ['Filing status / state', `${FILING_STATUS_LABELS[baseline.filingStatus]} · ${baseline.state}`],
                                ] as Array<[string, string]>).map(([label, value]) => (
                                    <div key={label}>
                                        <dt className="text-foreground-muted">{label}</dt>
                                        <dd className="text-foreground-secondary font-mono mt-0.5" style={TNUM}>{value}</dd>
                                    </div>
                                ))}
                            </dl>
                            <p className="text-[11px] text-foreground-muted mt-2">
                                Income and expenses are trailing-12-month averages. Filing status and state
                                come from your Tax Estimator preferences; taxable income is annualized from
                                this year&apos;s mapped book data.
                            </p>
                        </div>
                    )}
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                            Model Parameters
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-x-4 gap-y-3">
                            <label className="block">
                                <span className="block text-xs font-medium text-foreground-secondary mb-1">Cash-flow horizon (months)</span>
                                <input type="number" className={INPUT_CLASS} value={assumptions.cashFlowMonths} step={12}
                                    onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) patchAssumptions({ cashFlowMonths: v }); }} />
                            </label>
                            <label className="block">
                                <span className="block text-xs font-medium text-foreground-secondary mb-1">Net-worth horizon (years)</span>
                                <input type="number" className={INPUT_CLASS} value={assumptions.netWorthYears} step={5}
                                    onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) patchAssumptions({ netWorthYears: v }); }} />
                            </label>
                            <label className="block">
                                <span className="block text-xs font-medium text-foreground-secondary mb-1">Invested return %/yr</span>
                                <input type="number" className={INPUT_CLASS} value={assumptions.investedReturnPct} step={0.5}
                                    onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) patchAssumptions({ investedReturnPct: v }); }} />
                            </label>
                            <label className="block">
                                <span className="block text-xs font-medium text-foreground-secondary mb-1">FIRE real return %/yr</span>
                                <input type="number" className={INPUT_CLASS} value={assumptions.fireRealReturnPct} step={0.5}
                                    onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) patchAssumptions({ fireRealReturnPct: v }); }} />
                            </label>
                            <label className="block">
                                <span className="block text-xs font-medium text-foreground-secondary mb-1">Safe withdrawal rate %</span>
                                <input type="number" className={INPUT_CLASS} value={assumptions.swrPct} step={0.25}
                                    onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) patchAssumptions({ swrPct: v }); }} />
                            </label>
                        </div>
                    </div>
                </div>
            </CollapsibleConfigSection>

            {/* Methodology */}
            {result && (
                <div className="text-xs text-foreground-muted space-y-1">
                    <p className="font-semibold text-foreground-secondary">Methodology</p>
                    {result.notes.map((note, i) => (
                        <p key={i}>{note}</p>
                    ))}
                </div>
            )}
        </div>
    );
}
