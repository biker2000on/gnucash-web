'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { computePaycheck, PAY_FREQUENCIES, type PaycheckResult } from '@/lib/tax/paycheck';
import { STATE_OPTIONS } from '@/lib/tax/state';
import {
  FILING_STATUS_LABELS,
  FILING_STATUSES,
  SUPPORTED_TAX_YEARS,
  isSupportedTaxYear,
  type FilingStatus,
  type TaxYear,
} from '@/lib/tax/types';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

/* ------------------------------------------------------------------ */
/* Scenario state                                                      */
/* ------------------------------------------------------------------ */

interface ScenarioState {
  payMode: 'annual' | 'hourly';
  annualSalary: number;
  hourlyRate: number;
  hoursPerWeek: number;
  payPeriodsPerYear: number;
  trad401kPercent: number;
  hsaPerPaycheck: number;
  fsaPerPaycheck: number;
  healthPremiumPerPaycheck: number;
}

const DEFAULT_SCENARIO: ScenarioState = {
  payMode: 'annual',
  annualSalary: 85_000,
  hourlyRate: 40,
  hoursPerWeek: 40,
  payPeriodsPerYear: 26,
  trad401kPercent: 6,
  hsaPerPaycheck: 0,
  fsaPerPaycheck: 0,
  healthPremiumPerPaycheck: 0,
};

function resolveAnnualGross(s: ScenarioState): number {
  return s.payMode === 'annual'
    ? s.annualSalary
    : s.hourlyRate * s.hoursPerWeek * 52;
}

/* Payslip prefill --------------------------------------------------- */

interface PayslipRow {
  pay_date: string;
  pay_period_start: string | null;
  pay_period_end: string | null;
  gross_pay: string | number | null;
  line_items: Array<{ category: string; label: string; amount: number }> | null;
}

function guessFrequency(p: PayslipRow): number {
  if (p.pay_period_start && p.pay_period_end) {
    const days =
      (new Date(p.pay_period_end).getTime() - new Date(p.pay_period_start).getTime()) / 86_400_000;
    if (days <= 8) return 52;
    if (days <= 15) return 26; // 14-day period
    if (days <= 17) return 24; // semi-monthly
    return 12;
  }
  return 26;
}

function prefillFromPayslip(p: PayslipRow): Partial<ScenarioState> | null {
  const grossPerCheck = p.gross_pay !== null ? Number(p.gross_pay) : NaN;
  if (!Number.isFinite(grossPerCheck) || grossPerCheck <= 0) return null;
  const periods = guessFrequency(p);

  let d401k = 0;
  let hsa = 0;
  let fsa = 0;
  let premium = 0;
  for (const item of p.line_items ?? []) {
    if (item.category !== 'deduction' || !Number.isFinite(item.amount)) continue;
    const label = item.label.toLowerCase();
    if (/401|403|457|retirement/.test(label) && !/roth/.test(label)) d401k += item.amount;
    else if (/hsa|health sav/.test(label)) hsa += item.amount;
    else if (/fsa|flex/.test(label)) fsa += item.amount;
    else if (/med|dental|vision|health|insur|premium/.test(label)) premium += item.amount;
  }

  return {
    payMode: 'annual',
    annualSalary: Math.round(grossPerCheck * periods),
    payPeriodsPerYear: periods,
    trad401kPercent: grossPerCheck > 0 ? Math.round((d401k / grossPerCheck) * 1000) / 10 : 0,
    hsaPerPaycheck: Math.round(hsa * 100) / 100,
    fsaPerPaycheck: Math.round(fsa * 100) / 100,
    healthPremiumPerPaycheck: Math.round(premium * 100) / 100,
  };
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
  suffix,
  width = 'w-28',
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  suffix?: string;
  width?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
      <span>{label}{suffix ? <span className="text-foreground-muted"> ({suffix})</span> : null}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={e => onChange(Math.max(min, parseFloat(e.target.value) || 0))}
        className={`${width} bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary`}
        style={MONO}
      />
    </label>
  );
}

function ScenarioInputs({
  scenario,
  onChange,
}: {
  scenario: ScenarioState;
  onChange: (s: ScenarioState) => void;
}) {
  const set = <K extends keyof ScenarioState>(key: K, value: ScenarioState[K]) =>
    onChange({ ...scenario, [key]: value });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          Pay basis
          <select
            value={scenario.payMode}
            onChange={e => set('payMode', e.target.value as 'annual' | 'hourly')}
            className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
          >
            <option value="annual">Annual salary</option>
            <option value="hourly">Hourly</option>
          </select>
        </label>
        {scenario.payMode === 'annual' ? (
          <NumberField
            label="Annual salary"
            value={scenario.annualSalary}
            onChange={v => set('annualSalary', v)}
            step={1000}
            width="w-32"
          />
        ) : (
          <>
            <NumberField label="Hourly rate" value={scenario.hourlyRate} onChange={v => set('hourlyRate', v)} step={0.5} />
            <NumberField label="Hours / week" value={scenario.hoursPerWeek} onChange={v => set('hoursPerWeek', v)} step={1} />
          </>
        )}
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          Pay frequency
          <select
            value={scenario.payPeriodsPerYear}
            onChange={e => set('payPeriodsPerYear', parseInt(e.target.value, 10))}
            className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
          >
            {PAY_FREQUENCIES.map(f => (
              <option key={f.periodsPerYear} value={f.periodsPerYear}>
                {f.label} ({f.periodsPerYear})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <NumberField label="401(k)" value={scenario.trad401kPercent} onChange={v => set('trad401kPercent', v)} step={0.5} suffix="% of gross" width="w-24" />
        <NumberField label="HSA" value={scenario.hsaPerPaycheck} onChange={v => set('hsaPerPaycheck', v)} step={5} suffix="$ / check" width="w-24" />
        <NumberField label="FSA" value={scenario.fsaPerPaycheck} onChange={v => set('fsaPerPaycheck', v)} step={5} suffix="$ / check" width="w-24" />
        <NumberField label="Health premium" value={scenario.healthPremiumPerPaycheck} onChange={v => set('healthPremiumPerPaycheck', v)} step={5} suffix="$ / check" width="w-24" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Waterfall table                                                     */
/* ------------------------------------------------------------------ */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

interface WaterfallRowDef {
  label: string;
  get: (r: PaycheckResult) => number;
  /** Deductions render as negatives. */
  negative?: boolean;
  emphasis?: boolean;
}

const ROWS: WaterfallRowDef[] = [
  { label: 'Gross pay', get: r => r.perPaycheck.gross },
  { label: '401(k) deferral', get: r => r.perPaycheck.contrib401k, negative: true },
  { label: 'HSA', get: r => r.perPaycheck.hsa, negative: true },
  { label: 'FSA', get: r => r.perPaycheck.fsa, negative: true },
  { label: 'Health premium', get: r => r.perPaycheck.healthPremium, negative: true },
  { label: 'Federal income tax', get: r => r.perPaycheck.federalTax, negative: true },
  { label: 'Social Security', get: r => r.perPaycheck.socialSecurity, negative: true },
  { label: 'Medicare', get: r => r.perPaycheck.medicare, negative: true },
  { label: 'State income tax', get: r => r.perPaycheck.stateTax, negative: true },
  { label: 'Net pay', get: r => r.perPaycheck.net, emphasis: true },
];

function DeltaCell({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.005) return <span className="text-foreground-muted">—</span>;
  return (
    <span className={delta > 0 ? 'text-positive' : 'text-negative'}>
      {delta > 0 ? '+' : ''}{formatCurrency(delta)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function PaycheckModelerPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [filingStatus, setFilingStatus] = useState<FilingStatus>('single');
  const [stateCode, setStateCode] = useState('OTHER');
  const [stateFlatRate, setStateFlatRate] = useState(0);
  const [compareEnabled, setCompareEnabled] = useState(true);
  const [current, setCurrent] = useState<ScenarioState>(DEFAULT_SCENARIO);
  const [offer, setOffer] = useState<ScenarioState>({ ...DEFAULT_SCENARIO, annualSalary: 100_000 });
  const [prefillNote, setPrefillNote] = useState<string | null>(null);

  // Prefill filing status / state from the book's entity profile
  useEffect(() => {
    fetch('/api/entity')
      .then(res => (res.ok ? res.json() : null))
      .then(profile => {
        if (!profile) return;
        if (
          typeof profile.filingStatus === 'string' &&
          (FILING_STATUSES as readonly string[]).includes(profile.filingStatus)
        ) {
          setFilingStatus(profile.filingStatus as FilingStatus);
        }
        if (typeof profile.taxState === 'string' && profile.taxState) {
          setStateCode(profile.taxState);
        }
        if (typeof profile.stateFlatRate === 'number') {
          setStateFlatRate(profile.stateFlatRate);
        }
      })
      .catch(() => { /* prefill is best-effort */ });
  }, []);

  // Prefill "current" from the most recent payslip
  useEffect(() => {
    fetch('/api/payslips')
      .then(res => (res.ok ? res.json() : null))
      .then((payslips: PayslipRow[] | null) => {
        if (!Array.isArray(payslips) || payslips.length === 0) return;
        const latest = payslips[0]; // API sorts by pay_date desc
        const prefill = prefillFromPayslip(latest);
        if (prefill) {
          setCurrent(prev => ({ ...prev, ...prefill }));
          setOffer(prev => ({ ...prev, ...prefill }));
          setPrefillNote(
            `Current prefilled from your latest payslip (${String(latest.pay_date).slice(0, 10)}).`,
          );
        }
      })
      .catch(() => { /* prefill is best-effort */ });
  }, []);

  const currentResult = useMemo(
    () =>
      computePaycheck({
        year,
        filingStatus,
        stateCode,
        stateFlatRate,
        payPeriodsPerYear: current.payPeriodsPerYear,
        annualGross: resolveAnnualGross(current),
        trad401kPercent: current.trad401kPercent,
        hsaPerPaycheck: current.hsaPerPaycheck,
        fsaPerPaycheck: current.fsaPerPaycheck,
        healthPremiumPerPaycheck: current.healthPremiumPerPaycheck,
      }),
    [year, filingStatus, stateCode, stateFlatRate, current],
  );

  const offerResult = useMemo(
    () =>
      compareEnabled
        ? computePaycheck({
            year,
            filingStatus,
            stateCode,
            stateFlatRate,
            payPeriodsPerYear: offer.payPeriodsPerYear,
            annualGross: resolveAnnualGross(offer),
            trad401kPercent: offer.trad401kPercent,
            hsaPerPaycheck: offer.hsaPerPaycheck,
            fsaPerPaycheck: offer.fsaPerPaycheck,
            healthPremiumPerPaycheck: offer.healthPremiumPerPaycheck,
          })
        : null,
    [compareEnabled, year, filingStatus, stateCode, stateFlatRate, offer],
  );

  const sameFrequency =
    offerResult === null || currentResult.payPeriodsPerYear === offerResult.payPeriodsPerYear;

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Paycheck / Offer Modeler</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Gross-to-net for a W-2 paycheck — and what a raise, benefits change, or new offer
          actually does to your take-home pay.
        </p>
      </header>

      <PersonalToolNotice />

      {/* Shared inputs */}
      <div className="rounded-lg border border-border bg-surface/30 p-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Tax year
            <select
              value={year}
              onChange={e => setYear(parseInt(e.target.value, 10) as TaxYear)}
              className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {SUPPORTED_TAX_YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Filing status
            <select
              value={filingStatus}
              onChange={e => setFilingStatus(e.target.value as FilingStatus)}
              className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {FILING_STATUSES.map(fs => (
                <option key={fs} value={fs}>{FILING_STATUS_LABELS[fs]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            State
            <select
              value={stateCode}
              onChange={e => setStateCode(e.target.value)}
              className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {STATE_OPTIONS.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </label>
          {stateCode === 'OTHER' && (
            <NumberField
              label="State flat rate"
              value={stateFlatRate * 100}
              onChange={v => setStateFlatRate(v / 100)}
              step={0.1}
              suffix="%"
              width="w-24"
            />
          )}
          <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer pb-1.5">
            <input
              type="checkbox"
              checked={compareEnabled}
              onChange={e => setCompareEnabled(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            Compare an offer
          </label>
        </div>
        {prefillNote && <p className="mt-3 text-[11px] text-foreground-muted">{prefillNote}</p>}
      </div>

      {/* Scenario inputs side by side */}
      <div className={`grid gap-4 ${compareEnabled ? 'lg:grid-cols-2' : ''}`}>
        <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-4">
          <h2 className="text-base font-semibold text-foreground">Current</h2>
          <ScenarioInputs scenario={current} onChange={setCurrent} />
        </section>
        {compareEnabled && (
          <section className="rounded-lg border border-primary/30 bg-surface/30 p-5 space-y-4">
            <h2 className="text-base font-semibold text-primary">Offer / scenario</h2>
            <ScenarioInputs scenario={offer} onChange={setOffer} />
          </section>
        )}
      </div>

      {/* Headline stats */}
      <StatGrid cols={4}>
        <StatCard
          label="Net per paycheck (current)"
          value={formatCurrency(currentResult.perPaycheck.net)}
          sub={`of ${formatCurrency(currentResult.perPaycheck.gross)} gross`}
        />
        <StatCard
          label="Annual net (current)"
          value={formatCurrency(currentResult.annual.net)}
          sub={`effective tax ${pct(currentResult.effectiveTaxRate)}`}
        />
        {offerResult && (
          <>
            <StatCard
              label="Net per paycheck (offer)"
              value={formatCurrency(offerResult.perPaycheck.net)}
              sub={`of ${formatCurrency(offerResult.perPaycheck.gross)} gross`}
              tone="primary"
            />
            <StatCard
              label="Annual net difference"
              value={`${offerResult.annual.net - currentResult.annual.net >= 0 ? '+' : ''}${formatCurrency(offerResult.annual.net - currentResult.annual.net)}`}
              tone={offerResult.annual.net >= currentResult.annual.net ? 'positive' : 'negative'}
              sub="offer vs current"
            />
          </>
        )}
        {!offerResult && (
          <>
            <StatCard
              label="Marginal rate"
              value={pct(currentResult.combinedMarginalRate)}
              sub={`fed ${pct(currentResult.federalMarginalRate)} + state ${pct(currentResult.stateMarginalRate)}`}
            />
            <StatCard
              label="Pre-tax savings / yr"
              value={formatCurrency(currentResult.annual.contrib401k + currentResult.annual.hsa + currentResult.annual.fsa)}
              sub="401(k) + HSA + FSA"
              tone="positive"
            />
          </>
        )}
      </StatGrid>

      {/* Waterfall */}
      <section className="rounded-lg border border-border bg-surface/30 overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">Per-paycheck waterfall</h2>
          {!sameFrequency && (
            <p className="text-xs text-warning mt-0.5">
              Scenarios use different pay frequencies — per-paycheck deltas compare unlike checks;
              use the annual row.
            </p>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wider text-foreground-muted">
                <th className="px-4 py-2 text-left">Line</th>
                <th className="px-4 py-2 text-right">Current</th>
                {offerResult && <th className="px-4 py-2 text-right">Offer</th>}
                {offerResult && <th className="px-4 py-2 text-right">Δ</th>}
              </tr>
            </thead>
            <tbody>
              {ROWS.map(row => {
                const cur = row.get(currentResult);
                const off = offerResult ? row.get(offerResult) : null;
                if (
                  !row.emphasis &&
                  row.label !== 'Gross pay' &&
                  Math.abs(cur) < 0.005 &&
                  (off === null || Math.abs(off) < 0.005)
                ) {
                  return null; // hide all-zero deduction rows
                }
                const sign = row.negative ? -1 : 1;
                return (
                  <tr
                    key={row.label}
                    className={`border-b border-border/60 ${row.emphasis ? 'bg-primary-light/40' : ''}`}
                  >
                    <td className={`px-4 py-2 ${row.emphasis ? 'font-semibold text-foreground' : 'text-foreground-secondary'}`}>
                      {row.label}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono ${row.emphasis ? 'font-semibold text-foreground' : row.negative ? 'text-negative' : 'text-foreground'}`} style={MONO}>
                      {row.negative && cur > 0 ? '−' : ''}{formatCurrency(cur)}
                    </td>
                    {offerResult && off !== null && (
                      <td className={`px-4 py-2 text-right font-mono ${row.emphasis ? 'font-semibold text-foreground' : row.negative ? 'text-negative' : 'text-foreground'}`} style={MONO}>
                        {row.negative && off > 0 ? '−' : ''}{formatCurrency(off)}
                      </td>
                    )}
                    {offerResult && off !== null && (
                      <td className="px-4 py-2 text-right font-mono" style={MONO}>
                        <DeltaCell delta={sign * (off - cur)} />
                      </td>
                    )}
                  </tr>
                );
              })}
              {/* Annual net row */}
              <tr className="bg-surface">
                <td className="px-4 py-2 font-semibold text-foreground">Annual net</td>
                <td className="px-4 py-2 text-right font-mono font-semibold text-foreground" style={MONO}>
                  {formatCurrency(currentResult.annual.net)}
                </td>
                {offerResult && (
                  <td className="px-4 py-2 text-right font-mono font-semibold text-foreground" style={MONO}>
                    {formatCurrency(offerResult.annual.net)}
                  </td>
                )}
                {offerResult && (
                  <td className="px-4 py-2 text-right font-mono" style={MONO}>
                    <DeltaCell delta={offerResult.annual.net - currentResult.annual.net} />
                  </td>
                )}
              </tr>
              {/* Marginal rate row */}
              <tr>
                <td className="px-4 py-2 text-foreground-secondary">Marginal rate (fed + state)</td>
                <td className="px-4 py-2 text-right font-mono text-foreground-secondary" style={MONO}>
                  {pct(currentResult.combinedMarginalRate)}
                </td>
                {offerResult && (
                  <td className="px-4 py-2 text-right font-mono text-foreground-secondary" style={MONO}>
                    {pct(offerResult.combinedMarginalRate)}
                  </td>
                )}
                {offerResult && <td className="px-4 py-2" />}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[11px] text-foreground-muted">
        Assumes a single W-2 job, standard deduction, no other income, and no credits. 401(k)
        deferrals reduce income tax but not FICA; HSA/FSA/premiums through a cafeteria plan reduce
        both. State tax approximated from federal AGI minus the state standard deduction.
        Estimates only — not tax advice.
      </p>
    </div>
  );
}
