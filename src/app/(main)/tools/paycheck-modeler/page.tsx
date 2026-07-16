'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { PAY_FREQUENCIES } from '@/lib/tax/paycheck';
import { STATE_OPTIONS } from '@/lib/tax/state';
import {
  compareOffers,
  defaultOfferScenario,
  EMPLOYMENT_TYPE_LABELS,
  type EmploymentType,
  type OfferScenario,
  type OfferScenarioResult,
} from '@/lib/tax/offer-comparison';
import {
  FILING_STATUS_LABELS,
  FILING_STATUSES,
  SUPPORTED_TAX_YEARS,
  isSupportedTaxYear,
  type FilingStatus,
  type TaxYear,
} from '@/lib/tax/types';

const MONO = { fontFeatureSettings: "'tnum'" } as const;
const TOOL_TYPE = 'paycheck_scenarios';

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Persistence payload                                                 */
/* ------------------------------------------------------------------ */

interface SavedShared {
  filingStatus?: FilingStatus;
  stateCode?: string;
  stateFlatRate?: number;
}

interface SavedConfig {
  scenarios?: OfferScenario[];
  baselineId?: string;
  shared?: SavedShared;
}

/* ------------------------------------------------------------------ */
/* Payslip prefill                                                     */
/* ------------------------------------------------------------------ */

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

function prefillFromPayslip(p: PayslipRow): Partial<OfferScenario> | null {
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
    employmentType: 'salaried_w2',
    salary: Math.round(grossPerCheck * periods),
    payPeriodsPerYear: periods,
    employee401kPercent: grossPerCheck > 0 ? Math.round((d401k / grossPerCheck) * 1000) / 10 : 0,
    hsaPerPaycheck: Math.round(hsa * 100) / 100,
    fsaPerPaycheck: Math.round(fsa * 100) / 100,
    medicalPremiumMonthly: Math.round(((premium * periods) / 12) * 100) / 100,
  };
}

/* ------------------------------------------------------------------ */
/* Small UI helpers                                                    */
/* ------------------------------------------------------------------ */

const inputCls =
  'bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary';
const selectCls =
  'bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary';

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
        className={`${width} ${inputCls} text-right font-mono`}
        style={MONO}
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-md border border-border p-3">
      <legend className="px-1.5 text-[11px] uppercase tracking-wider text-foreground-muted">
        {title}
      </legend>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">{children}</div>
    </fieldset>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function DeltaCell({ delta, suffix }: { delta: number; suffix?: string }) {
  if (Math.abs(delta) < 0.005) return <span className="text-foreground-muted">—</span>;
  return (
    <span className={delta > 0 ? 'text-positive' : 'text-negative'}>
      {delta > 0 ? '+' : ''}{suffix === '%' ? `${(delta * 100).toFixed(1)}%` : formatCurrency(delta)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Scenario editor                                                     */
/* ------------------------------------------------------------------ */

function ScenarioEditor({
  scenario,
  onChange,
}: {
  scenario: OfferScenario;
  onChange: (s: OfferScenario) => void;
}) {
  const set = <K extends keyof OfferScenario>(key: K, value: OfferScenario[K]) =>
    onChange({ ...scenario, [key]: value });
  const type = scenario.employmentType;

  return (
    <div className="space-y-3">
      <Section title="Pay">
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          Employment type
          <select
            value={type}
            onChange={e => set('employmentType', e.target.value as EmploymentType)}
            className={selectCls}
          >
            {(Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[]).map(t => (
              <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </label>
        {type === 'salaried_w2' && (
          <NumberField label="Annual salary" value={scenario.salary} onChange={v => set('salary', v)} step={1000} width="w-32" />
        )}
        {type === 'hourly_w2' && (
          <>
            <NumberField label="Hourly rate" value={scenario.hourlyRate} onChange={v => set('hourlyRate', v)} step={0.5} />
            <NumberField label="Hours / week" value={scenario.hoursPerWeek} onChange={v => set('hoursPerWeek', v)} step={1} width="w-20" />
            <NumberField label="Overtime hrs / yr" value={scenario.overtimeHoursPerYear} onChange={v => set('overtimeHoursPerYear', v)} step={10} width="w-24" />
            <NumberField label="OT multiplier" value={scenario.overtimeMultiplier} onChange={v => set('overtimeMultiplier', v)} step={0.25} width="w-20" />
          </>
        )}
        {type === 'self_employed_1099' && (
          <>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Billing basis
              <select
                value={scenario.payBasis1099}
                onChange={e => set('payBasis1099', e.target.value as 'hourly' | 'flat')}
                className={selectCls}
              >
                <option value="hourly">Hourly x billable hours</option>
                <option value="flat">Flat annual</option>
              </select>
            </label>
            {scenario.payBasis1099 === 'hourly' ? (
              <>
                <NumberField label="Hourly rate" value={scenario.hourlyRate} onChange={v => set('hourlyRate', v)} step={5} />
                <NumberField label="Billable hrs / yr" value={scenario.billableHoursPerYear} onChange={v => set('billableHoursPerYear', v)} step={40} width="w-24" />
              </>
            ) : (
              <NumberField label="Flat annual" value={scenario.flatAnnual1099} onChange={v => set('flatAnnual1099', v)} step={1000} width="w-32" />
            )}
            <NumberField label="Business deductions" value={scenario.deductionsPercent1099} onChange={v => set('deductionsPercent1099', v)} step={1} suffix="% of gross" width="w-24" />
          </>
        )}
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          Pay frequency
          <select
            value={scenario.payPeriodsPerYear}
            onChange={e => set('payPeriodsPerYear', parseInt(e.target.value, 10))}
            className={selectCls}
          >
            {PAY_FREQUENCIES.map(f => (
              <option key={f.periodsPerYear} value={f.periodsPerYear}>
                {f.label} ({f.periodsPerYear})
              </option>
            ))}
          </select>
        </label>
      </Section>

      <Section title="Bonus & equity">
        <NumberField label="Bonus" value={scenario.bonusPercent} onChange={v => set('bonusPercent', v)} step={1} suffix="% of pay" width="w-20" />
        <NumberField label="Bonus multiplier" value={scenario.bonusMultiplier} onChange={v => set('bonusMultiplier', Math.min(2, v))} step={0.1} suffix="0-2 expected payout" width="w-20" />
        <NumberField label="ESOP / equity potential" value={scenario.esopPotential} onChange={v => set('esopPotential', v)} step={500} suffix="$ / yr" width="w-28" />
      </Section>

      <Section title="Employer retirement money">
        <NumberField label="401(k) match" value={scenario.match401kPercent} onChange={v => set('match401kPercent', v)} step={0.5} suffix="% of pay" width="w-20" />
        <NumberField
          label={scenario.otherEmployerContribLabel || 'Other employer contribution'}
          value={scenario.otherEmployerContrib}
          onChange={v => set('otherEmployerContrib', v)}
          step={100}
          suffix="$ / yr"
          width="w-28"
        />
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          Label for other contribution
          <input
            type="text"
            value={scenario.otherEmployerContribLabel}
            onChange={e => set('otherEmployerContribLabel', e.target.value)}
            placeholder="HSA seed, profit sharing..."
            className={`w-52 ${inputCls}`}
          />
        </label>
      </Section>

      <Section title="Time off">
        <NumberField label="Holidays" value={scenario.holidays} onChange={v => set('holidays', v)} step={1} suffix="days" width="w-20" />
        <NumberField label="Vacation" value={scenario.vacationDays} onChange={v => set('vacationDays', v)} step={1} suffix="days" width="w-20" />
        <p className="basis-full text-[11px] text-foreground-muted">
          {type === 'salaried_w2'
            ? 'Salaried: paid time off ADDS value (days x salary / 260).'
            : 'Hourly / 1099: time off is unpaid — it REDUCES annual pay instead of adding a PTO line.'}
        </p>
      </Section>

      <Section title="Healthcare">
        <NumberField label="Medical premium" value={scenario.medicalPremiumMonthly} onChange={v => set('medicalPremiumMonthly', v)} step={10} suffix="$ / mo" width="w-24" />
        <NumberField label="Dental premium" value={scenario.dentalPremiumMonthly} onChange={v => set('dentalPremiumMonthly', v)} step={5} suffix="$ / mo" width="w-24" />
        <NumberField label="Other premium" value={scenario.otherPremiumMonthly} onChange={v => set('otherPremiumMonthly', v)} step={5} suffix="$ / mo" width="w-24" />
        <NumberField label="Employer HSA seed" value={scenario.hsaSeed} onChange={v => set('hsaSeed', v)} step={100} suffix="$ / yr" width="w-24" />
        <NumberField label="Deductible" value={scenario.deductible} onChange={v => set('deductible', v)} step={250} width="w-24" />
        <NumberField label="OOP max" value={scenario.oopMax} onChange={v => set('oopMax', v)} step={250} width="w-24" />
        <NumberField label="Coinsurance" value={scenario.coinsurancePercentAfterDeductible} onChange={v => set('coinsurancePercentAfterDeductible', v)} step={5} suffix="% you pay after deductible" width="w-20" />
        <NumberField label="Expected care billed" value={scenario.expectedAnnualCareBilled} onChange={v => set('expectedAnnualCareBilled', v)} step={250} suffix="$ / yr" width="w-28" />
        <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer pb-1.5">
          <input
            type="checkbox"
            checked={scenario.isHdhp}
            onChange={e => set('isHdhp', e.target.checked)}
            className="accent-[var(--primary)]"
          />
          HDHP (HSA-eligible)
        </label>
        {scenario.isHdhp && (
          <p className="basis-full text-[11px] text-foreground-muted">
            HDHP: your HSA payroll contribution earns a tax-value credit at your combined
            marginal rate, reducing the all-in healthcare cost.
          </p>
        )}
      </Section>

      <Section title="Your deferrals">
        <NumberField label="401(k)" value={scenario.employee401kPercent} onChange={v => set('employee401kPercent', v)} step={0.5} suffix="% of gross" width="w-20" />
        <NumberField label="HSA" value={scenario.hsaPerPaycheck} onChange={v => set('hsaPerPaycheck', v)} step={5} suffix="$ / check" width="w-24" />
        {type !== 'self_employed_1099' && (
          <NumberField label="FSA" value={scenario.fsaPerPaycheck} onChange={v => set('fsaPerPaycheck', v)} step={5} suffix="$ / check" width="w-24" />
        )}
        {type === 'self_employed_1099' && (
          <p className="basis-full text-[11px] text-foreground-muted">
            1099: the 401(k) percent models a solo-401(k) elective deferral on net profit; the
            HSA amount is deducted above the line. No FSA without an employer plan.
          </p>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Comparison table rows                                               */
/* ------------------------------------------------------------------ */

type RowKind = 'money' | 'text' | 'pct';

interface CompareRowDef {
  key: string;
  label: string;
  kind: RowKind;
  get: (r: OfferScenarioResult) => number | string | null;
  negative?: boolean;
  emphasis?: boolean;
  muted?: boolean;
  /** Hide the row when every scenario is zero/empty. */
  hideWhenAllZero?: boolean;
}

const COMPARE_ROWS: CompareRowDef[] = [
  { key: 'type', label: 'Employment type', kind: 'text', get: r => EMPLOYMENT_TYPE_LABELS[r.employmentType], muted: true },
  { key: 'basePay', label: 'Base pay (after unpaid time off)', kind: 'money', get: r => r.basePay },
  { key: 'overtime', label: 'Overtime pay', kind: 'money', get: r => r.overtimePay, hideWhenAllZero: true },
  { key: 'bonus', label: 'Estimated bonus', kind: 'money', get: r => r.estimatedBonus, hideWhenAllZero: true },
  { key: 'match', label: '401(k) match', kind: 'money', get: r => r.employerMatch, hideWhenAllZero: true },
  { key: 'otherEmp', label: 'Other employer contribution', kind: 'money', get: r => r.otherEmployerContrib, hideWhenAllZero: true },
  { key: 'esop', label: 'ESOP / equity potential', kind: 'money', get: r => r.esopPotential, hideWhenAllZero: true },
  { key: 'totalComp', label: 'Total compensation', kind: 'money', get: r => r.totalCompensation, emphasis: true },
  { key: 'pto', label: 'PTO value (salaried)', kind: 'money', get: r => r.ptoValue, hideWhenAllZero: true },
  { key: 'unpaidTo', label: 'Unpaid time off (already in pay)', kind: 'money', get: r => -r.unpaidTimeOffReduction, muted: true, hideWhenAllZero: true },
  { key: 'premiums', label: 'Premiums / yr', kind: 'money', get: r => r.premiumsAnnual, negative: true, hideWhenAllZero: true },
  { key: 'oop', label: 'Expected out-of-pocket care', kind: 'money', get: r => r.expectedOopCost, negative: true, hideWhenAllZero: true },
  { key: 'hsaSeed', label: 'Employer HSA seed', kind: 'money', get: r => r.hsaSeed, hideWhenAllZero: true },
  { key: 'hsaTax', label: 'HSA tax value (HDHP)', kind: 'money', get: r => r.hsaTaxValue, hideWhenAllZero: true },
  { key: 'allInHc', label: 'All-in healthcare cost', kind: 'money', get: r => r.allInHealthcareCost, negative: true },
  { key: 'seTax', label: 'Self-employment tax', kind: 'money', get: r => r.seTax, negative: true, hideWhenAllZero: true },
  { key: 'overall', label: 'Overall annual total', kind: 'money', get: r => r.overallAnnualTotal, emphasis: true },
  { key: 'overallMo', label: 'Overall / month', kind: 'money', get: r => r.overallMonthly },
  { key: 'takeHomeMo', label: 'Take-home / month (post-tax)', kind: 'money', get: r => r.takeHomeMonthly },
  { key: 'effHourly', label: 'Effective hourly rate', kind: 'money', get: r => r.effectiveHourlyRate },
  { key: 'workedHours', label: 'Worked hours / yr', kind: 'text', get: r => r.workedHours.toLocaleString(), muted: true },
  { key: 'marginal', label: 'Marginal rate (fed + state)', kind: 'pct', get: r => r.combinedMarginalRate, muted: true },
  { key: 'effTax', label: 'Effective tax rate', kind: 'pct', get: r => r.effectiveTaxRate, muted: true },
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function PaycheckModelerPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  /* ---- Shared tax settings (global across scenarios) ---- */
  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [filingStatus, setFilingStatus] = useState<FilingStatus>('single');
  const [stateCode, setStateCode] = useState('OTHER');
  const [stateFlatRate, setStateFlatRate] = useState(0);

  /* ---- Scenarios ---- */
  const initial = useMemo(() => {
    const current = defaultOfferScenario(makeId(), 'Current');
    const offer = { ...defaultOfferScenario(makeId(), 'Offer'), salary: 100_000 };
    return { scenarios: [current, offer], baselineId: current.id };
  }, []);

  const [scenarios, setScenarios] = useState<OfferScenario[]>(initial.scenarios);
  const [baselineId, setBaselineId] = useState<string>(initial.baselineId);
  const [selectedId, setSelectedId] = useState<string>(initial.scenarios[1].id);
  const [viewMode, setViewMode] = useState<'quick' | 'table'>('quick');
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);

  /* ---- Persistence ---- */
  const [configId, setConfigId] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [prefillNote, setPrefillNote] = useState<string | null>(null);
  const hydratedFromConfig = useRef(false);

  // Load saved config first; only prefill from entity/payslip when nothing saved.
  useEffect(() => {
    let cancelled = false;

    const prefillFromEntity = () => {
      fetch('/api/entity')
        .then(res => (res.ok ? res.json() : null))
        .then(profile => {
          if (!profile || cancelled || hydratedFromConfig.current) return;
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
    };

    const prefillFromLatestPayslip = () => {
      fetch('/api/payslips')
        .then(res => (res.ok ? res.json() : null))
        .then((payslips: PayslipRow[] | null) => {
          if (cancelled || hydratedFromConfig.current) return;
          if (!Array.isArray(payslips) || payslips.length === 0) return;
          const latest = payslips[0]; // API sorts by pay_date desc
          const prefill = prefillFromPayslip(latest);
          if (prefill) {
            setScenarios(prev =>
              prev.map(s => (s.name === 'Current' ? { ...s, ...prefill } : s)),
            );
            setPrefillNote(
              `Current prefilled from your latest payslip (${String(latest.pay_date).slice(0, 10)}).`,
            );
          }
        })
        .catch(() => { /* prefill is best-effort */ });
    };

    fetch(`/api/tools/config?toolType=${TOOL_TYPE}`)
      .then(res => (res.ok ? res.json() : []))
      .then((configs: Array<{ id: number; config: SavedConfig }>) => {
        if (cancelled) return;
        if (Array.isArray(configs) && configs.length > 0) {
          const cfg = configs[0];
          const saved = cfg.config ?? {};
          if (Array.isArray(saved.scenarios) && saved.scenarios.length > 0) {
            hydratedFromConfig.current = true;
            setConfigId(cfg.id);
            // Merge over defaults so fields added later get sane values.
            const merged = saved.scenarios.map(s => ({
              ...defaultOfferScenario(s.id ?? makeId(), s.name ?? 'Scenario'),
              ...s,
            }));
            setScenarios(merged);
            const bl = merged.some(s => s.id === saved.baselineId)
              ? (saved.baselineId as string)
              : merged[0].id;
            setBaselineId(bl);
            setSelectedId(merged.find(s => s.id !== bl)?.id ?? merged[0].id);
            const sh = saved.shared ?? {};
            if (
              typeof sh.filingStatus === 'string' &&
              (FILING_STATUSES as readonly string[]).includes(sh.filingStatus)
            ) {
              setFilingStatus(sh.filingStatus);
            }
            if (typeof sh.stateCode === 'string' && sh.stateCode) setStateCode(sh.stateCode);
            if (typeof sh.stateFlatRate === 'number') setStateFlatRate(sh.stateFlatRate);
            return;
          }
          // A config row exists but has no scenarios — reuse its id on save.
          setConfigId(cfg.id);
        }
        prefillFromEntity();
        prefillFromLatestPayslip();
      })
      .catch(() => {
        if (!cancelled) {
          prefillFromEntity();
          prefillFromLatestPayslip();
        }
      });

    return () => { cancelled = true; };
  }, []);

  const handleSave = useCallback(async () => {
    setSaveStatus('saving');
    try {
      const config: SavedConfig = {
        scenarios,
        baselineId,
        shared: { filingStatus, stateCode, stateFlatRate },
      };
      const res = configId
        ? await fetch(`/api/tools/config/${configId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Paycheck scenarios', config }),
          })
        : await fetch('/api/tools/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolType: TOOL_TYPE, name: 'Paycheck scenarios', config }),
          });
      if (!res.ok) throw new Error('save failed');
      const saved = await res.json();
      if (saved?.id) setConfigId(saved.id);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [scenarios, baselineId, filingStatus, stateCode, stateFlatRate, configId]);

  /* ---- Scenario management ---- */

  const selected = scenarios.find(s => s.id === selectedId) ?? scenarios[0];

  const updateScenario = useCallback((next: OfferScenario) => {
    setScenarios(prev => prev.map(s => (s.id === next.id ? next : s)));
  }, []);

  const addScenario = useCallback(() => {
    const s = defaultOfferScenario(makeId(), `Scenario ${scenarios.length + 1}`);
    setScenarios(prev => [...prev, s]);
    setSelectedId(s.id);
  }, [scenarios.length]);

  const duplicateScenario = useCallback((id: string) => {
    setScenarios(prev => {
      const src = prev.find(s => s.id === id);
      if (!src) return prev;
      const copy = { ...src, id: makeId(), name: `${src.name} (copy)` };
      setSelectedId(copy.id);
      return [...prev, copy];
    });
  }, []);

  const deleteScenario = useCallback((id: string) => {
    setScenarios(prev => {
      if (prev.length <= 1) return prev;
      const next = prev.filter(s => s.id !== id);
      if (baselineId === id) setBaselineId(next[0].id);
      if (selectedId === id) setSelectedId(next[0].id);
      return next;
    });
    setHiddenIds(prev => prev.filter(h => h !== id));
  }, [baselineId, selectedId]);

  /* ---- Computation ---- */

  const comparison = useMemo(
    () =>
      compareOffers(scenarios, baselineId, {
        year,
        filingStatus,
        stateCode,
        stateFlatRate: stateCode === 'OTHER' ? stateFlatRate : undefined,
      }),
    [scenarios, baselineId, year, filingStatus, stateCode, stateFlatRate],
  );

  const baselineResult = comparison.results.find(r => r.scenarioId === comparison.baselineId);
  const selectedResult = comparison.results.find(r => r.scenarioId === selected?.id);

  // Table columns: baseline pinned first, then the rest in scenario order,
  // filtered by the show/hide toggles (baseline always visible).
  const columns = useMemo(() => {
    const ordered = [
      ...comparison.results.filter(r => r.scenarioId === comparison.baselineId),
      ...comparison.results.filter(r => r.scenarioId !== comparison.baselineId),
    ];
    if (viewMode === 'quick') {
      return ordered.filter(
        r => r.scenarioId === comparison.baselineId || r.scenarioId === selected?.id,
      );
    }
    return ordered.filter(
      r => r.scenarioId === comparison.baselineId || !hiddenIds.includes(r.scenarioId),
    );
  }, [comparison, viewMode, hiddenIds, selected?.id]);

  const visibleRows = COMPARE_ROWS.filter(row => {
    if (!row.hideWhenAllZero) return true;
    return columns.some(c => {
      const v = row.get(c);
      return typeof v === 'number' && Math.abs(v) >= 0.005;
    });
  });

  const scorpHints = columns.filter(c => c.scorpSavingsHint !== null && c.scorpSavingsHint > 0);

  return (
    <div className="space-y-6 max-w-[1400px]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Paycheck / Offer Modeler</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Compare job offers the way a spreadsheet would: total compensation, PTO economics,
            all-in healthcare cost, self-employment taxes, and real take-home pay — side by side.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
          >
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : 'Save scenarios'}
          </button>
          {saveStatus === 'error' && (
            <span className="text-xs text-negative">Save failed</span>
          )}
        </div>
      </header>

      <PersonalToolNotice />

      {/* Shared tax settings */}
      <div className="rounded-lg border border-border bg-surface/30 p-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Tax year
            <select
              value={year}
              onChange={e => setYear(parseInt(e.target.value, 10) as TaxYear)}
              className={selectCls}
            >
              {SUPPORTED_TAX_YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Filing status
            <select
              value={filingStatus}
              onChange={e => setFilingStatus(e.target.value as FilingStatus)}
              className={selectCls}
            >
              {FILING_STATUSES.map(fs => (
                <option key={fs} value={fs}>{FILING_STATUS_LABELS[fs]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            State
            <select value={stateCode} onChange={e => setStateCode(e.target.value)} className={selectCls}>
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
          <div className="ml-auto flex items-end gap-1 pb-0.5">
            {(['quick', 'table'] as const).map(m => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium border transition-colors ${
                  viewMode === m
                    ? 'border-primary/50 bg-primary-light text-primary'
                    : 'border-border text-foreground-secondary hover:text-foreground'
                }`}
              >
                {m === 'quick' ? 'Quick compare' : 'Full table'}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-3 text-[11px] text-foreground-muted">
          Tax settings apply to every scenario. {prefillNote ?? ''}
        </p>
      </div>

      {/* Scenario manager */}
      <div className="rounded-lg border border-border bg-surface/30 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {scenarios.map(s => {
            const isBaseline = s.id === comparison.baselineId;
            const isSelected = s.id === selected?.id;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  isSelected
                    ? 'border-primary/60 bg-primary-light text-primary'
                    : 'border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                }`}
              >
                {isBaseline && <span title="Baseline" aria-label="Baseline">★</span>}
                {s.name}
              </button>
            );
          })}
          <button
            onClick={addScenario}
            className="rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground hover:border-border-hover"
          >
            + Add scenario
          </button>
        </div>

        {selected && (
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 border-t border-border/60 pt-3">
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Scenario name
              <input
                type="text"
                value={selected.name}
                onChange={e => updateScenario({ ...selected, name: e.target.value })}
                className={`w-48 ${inputCls}`}
              />
            </label>
            <div className="flex gap-2 pb-0.5">
              {selected.id !== comparison.baselineId && (
                <button
                  onClick={() => setBaselineId(selected.id)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground-secondary hover:text-foreground"
                >
                  ★ Set as baseline
                </button>
              )}
              <button
                onClick={() => duplicateScenario(selected.id)}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground-secondary hover:text-foreground"
              >
                Duplicate
              </button>
              <button
                onClick={() => deleteScenario(selected.id)}
                disabled={scenarios.length <= 1}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-negative hover:border-border-hover disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Editor for the selected scenario */}
      {selected && (
        <section className="rounded-lg border border-primary/30 bg-surface/30 p-5 space-y-4">
          <h2 className="text-base font-semibold text-primary">
            Editing: {selected.name}
            {selected.id === comparison.baselineId && (
              <span className="ml-2 text-xs font-normal text-foreground-muted">(baseline)</span>
            )}
          </h2>
          <ScenarioEditor scenario={selected} onChange={updateScenario} />
        </section>
      )}

      {/* Headline stats: selected vs baseline */}
      {baselineResult && selectedResult && (
        <StatGrid cols={4}>
          <StatCard
            label={`Overall annual (${baselineResult.name})`}
            value={formatCurrency(baselineResult.overallAnnualTotal)}
            sub={`take-home ${formatCurrency(baselineResult.takeHomeMonthly)}/mo`}
          />
          {selectedResult.scenarioId !== baselineResult.scenarioId ? (
            <>
              <StatCard
                label={`Overall annual (${selectedResult.name})`}
                value={formatCurrency(selectedResult.overallAnnualTotal)}
                sub={`take-home ${formatCurrency(selectedResult.takeHomeMonthly)}/mo`}
                tone="primary"
              />
              <StatCard
                label="Delta vs baseline"
                value={`${(selectedResult.deltaVsBaseline?.amount ?? 0) >= 0 ? '+' : ''}${formatCurrency(selectedResult.deltaVsBaseline?.amount ?? 0)}`}
                tone={(selectedResult.deltaVsBaseline?.amount ?? 0) >= 0 ? 'positive' : 'negative'}
                sub={`${((selectedResult.deltaVsBaseline?.percent ?? 0) * 100).toFixed(1)}% of baseline`}
              />
              <StatCard
                label="Effective hourly"
                value={`${formatCurrency(selectedResult.effectiveHourlyRate)}/hr`}
                sub={`vs ${formatCurrency(baselineResult.effectiveHourlyRate)}/hr baseline`}
              />
            </>
          ) : (
            <>
              <StatCard
                label="Total compensation"
                value={formatCurrency(baselineResult.totalCompensation)}
                sub="pay + bonus + employer money"
              />
              <StatCard
                label="All-in healthcare"
                value={formatCurrency(baselineResult.allInHealthcareCost)}
                sub="premiums + expected OOP − credits"
              />
              <StatCard
                label="Effective hourly"
                value={`${formatCurrency(baselineResult.effectiveHourlyRate)}/hr`}
                sub={`${baselineResult.workedHours.toLocaleString()} worked hrs/yr`}
              />
            </>
          )}
        </StatGrid>
      )}

      {/* Column visibility toggles (full table only) */}
      {viewMode === 'table' && comparison.results.length > 2 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-secondary">
          <span className="text-foreground-muted uppercase tracking-wider text-[10px]">Columns</span>
          {comparison.results
            .filter(r => r.scenarioId !== comparison.baselineId)
            .map(r => (
              <label key={r.scenarioId} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!hiddenIds.includes(r.scenarioId)}
                  onChange={e =>
                    setHiddenIds(prev =>
                      e.target.checked
                        ? prev.filter(h => h !== r.scenarioId)
                        : [...prev, r.scenarioId],
                    )
                  }
                  className="accent-[var(--primary)]"
                />
                {r.name}
              </label>
            ))}
        </div>
      )}

      {/* Comparison table */}
      <section className="rounded-lg border border-border bg-surface/30 overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            {viewMode === 'quick' ? 'Baseline vs selected' : 'Scenario comparison'}
          </h2>
          <p className="text-xs text-foreground-muted mt-0.5">
            Baseline column pinned first. Overall total = total comp + PTO value (salaried)
            − all-in healthcare − SE tax (1099).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wider text-foreground-muted">
                <th className="px-4 py-2 text-left sticky left-0 bg-surface z-10">Metric</th>
                {columns.map(c => (
                  <th key={c.scenarioId} className="px-4 py-2 text-right whitespace-nowrap">
                    {c.scenarioId === comparison.baselineId ? '★ ' : ''}{c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(row => (
                <tr
                  key={row.key}
                  className={`border-b border-border/60 ${row.emphasis ? 'bg-primary-light/40' : ''}`}
                >
                  <td
                    className={`px-4 py-2 sticky left-0 bg-surface z-10 ${
                      row.emphasis
                        ? 'font-semibold text-foreground'
                        : row.muted
                          ? 'text-foreground-muted'
                          : 'text-foreground-secondary'
                    }`}
                  >
                    {row.label}
                  </td>
                  {columns.map(c => {
                    const v = row.get(c);
                    let content: React.ReactNode;
                    if (v === null || v === undefined) content = '—';
                    else if (row.kind === 'text') content = String(v);
                    else if (row.kind === 'pct') content = pct(v as number);
                    else {
                      const n = v as number;
                      content = `${row.negative && n > 0 ? '−' : ''}${formatCurrency(n)}`;
                    }
                    return (
                      <td
                        key={c.scenarioId}
                        className={`px-4 py-2 text-right font-mono whitespace-nowrap ${
                          row.emphasis
                            ? 'font-semibold text-foreground'
                            : row.negative
                              ? 'text-negative'
                              : row.muted
                                ? 'text-foreground-muted'
                                : 'text-foreground'
                        }`}
                        style={MONO}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* Delta rows */}
              <tr className="bg-surface border-b border-border/60">
                <td className="px-4 py-2 font-semibold text-foreground sticky left-0 bg-surface z-10">
                  Δ vs baseline ($)
                </td>
                {columns.map(c => (
                  <td key={c.scenarioId} className="px-4 py-2 text-right font-mono" style={MONO}>
                    {c.deltaVsBaseline === null ? (
                      <span className="text-foreground-muted">baseline</span>
                    ) : (
                      <DeltaCell delta={c.deltaVsBaseline.amount} />
                    )}
                  </td>
                ))}
              </tr>
              <tr className="bg-surface">
                <td className="px-4 py-2 font-semibold text-foreground sticky left-0 bg-surface z-10">
                  Δ vs baseline (%)
                </td>
                {columns.map(c => (
                  <td key={c.scenarioId} className="px-4 py-2 text-right font-mono" style={MONO}>
                    {c.deltaVsBaseline === null ? (
                      <span className="text-foreground-muted">—</span>
                    ) : (
                      <DeltaCell delta={c.deltaVsBaseline.percent} suffix="%" />
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* S-corp hints for 1099 scenarios */}
      {scorpHints.length > 0 && (
        <div className="rounded-lg border border-secondary/30 bg-secondary-light p-4 text-xs text-foreground-secondary space-y-1">
          {scorpHints.map(c => (
            <p key={c.scenarioId}>
              <span className="font-medium text-foreground">{c.name}:</span> an S-corp election
              could save roughly {formatCurrency(c.scorpSavingsHint!)} / yr at a 50%-of-profit
              reasonable salary (before payroll-service and filing costs — see the S-corp
              analyzer for the full picture).
            </p>
          ))}
        </div>
      )}

      <p className="text-[11px] text-foreground-muted">
        Model notes: salaried PTO adds value (days × salary/260) while hourly and 1099 time off
        reduces annual pay instead. Expected out-of-pocket care = min(OOP max, min(billed,
        deductible) + coinsurance% × care above the deductible). HDHP plans credit the tax value
        of your HSA contribution at the combined marginal rate. 1099 scenarios pay both halves of
        self-employment tax and premiums after tax; W-2 take-home assumes cafeteria-plan premiums
        and a traditional 401(k). Employer match, other contributions, and ESOP count toward Total
        Comp but not take-home. Assumes standard deduction, no other income, no credits.
        Estimates only — not tax advice.
      </p>
    </div>
  );
}
