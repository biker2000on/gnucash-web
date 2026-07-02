'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { computeFederalTax, computeSafeHarbor, emptyFederalInputs } from '@/lib/tax/federal';
import { computeStateTax, STATE_OPTIONS } from '@/lib/tax/state';
import type { ScenarioLimits } from '@/lib/tax/scenario';
import {
  FILING_STATUS_LABELS,
  FILING_STATUSES,
  SUPPORTED_TAX_YEARS,
  TAX_CATEGORY_LABELS,
  isSupportedTaxYear,
  type BookTaxData,
  type ContributionScenario,
  type FederalTaxInputs,
  type FilingStatus,
  type TaxCategory,
  type TaxYear,
} from '@/lib/tax/types';
import BracketFillChart from '@/components/tools/tax/BracketFillChart';
import TaxMappingPanel, {
  type MappingAccount,
  type MappingSuggestion,
} from '@/components/tools/tax/TaxMappingPanel';
import ScenarioPanel from '@/components/tools/tax/ScenarioPanel';

/* ------------------------------------------------------------------ */
/* API payload types                                                   */
/* ------------------------------------------------------------------ */

interface LimitInfo {
  base: number;
  catchUp: number;
  total: number;
  catchUpAge: number;
}

interface EstimatePayload {
  bookData: BookTaxData;
  preferences: {
    filingStatus: FilingStatus;
    state: string;
    stateFlatRate: number;
    birthday: string | null;
    ageAtYearEnd: number | null;
  };
  limits: {
    '401k': LimitInfo | null;
    ira: LimitInfo | null;
    hsa: LimitInfo | null;
  };
}

interface MappingsPayload {
  mappings: Record<string, TaxCategory>;
  accounts: MappingAccount[];
  suggestions: MappingSuggestion[];
}

/* ------------------------------------------------------------------ */
/* Book data → engine inputs                                           */
/* ------------------------------------------------------------------ */

function categoryTotal(bookData: BookTaxData, category: TaxCategory): number {
  return bookData.categories.find(c => c.category === category)?.total ?? 0;
}

/** Categories that are simple annual flows we can annualize from YTD */
const ANNUALIZABLE: TaxCategory[] = [
  'w2_wages', 'federal_withholding', 'state_withholding', 'fica_social_security',
  'fica_medicare', 'interest_income', 'ordinary_dividends', 'qualified_dividends',
  'self_employment_income', 'business_expense', 'rental_income', 'retirement_income',
  'social_security_benefits', 'charitable_donation', 'mortgage_interest',
  'property_tax', 'state_local_tax_paid', 'medical_expense', 'education_expense',
  'other_income', 'other_deduction',
];

function buildInputs(
  bookData: BookTaxData,
  year: TaxYear,
  filingStatus: FilingStatus,
  annualize: boolean,
  filersAge65Plus: number,
): { inputs: FederalTaxInputs; withholding: number; stateWithholding: number } {
  const factor = annualize && bookData.elapsedYearFraction < 1
    ? 1 / bookData.elapsedYearFraction
    : 1;
  const get = (c: TaxCategory) =>
    categoryTotal(bookData, c) * (ANNUALIZABLE.includes(c) ? factor : 1);

  const qualifiedDividends = get('qualified_dividends');
  // 401k/IRA/HSA contributions come from the tax-year-aware contribution
  // summary when available, falling back to mapped category totals.
  const c = bookData.contributionsByType;
  const trad401k = Math.max(
    (c['401k'] ?? 0) + (c['403b'] ?? 0) + (c['457'] ?? 0),
    categoryTotal(bookData, 'trad_401k_contribution'),
  );
  const tradIra = Math.max(c['traditional_ira'] ?? 0, categoryTotal(bookData, 'trad_ira_contribution'));
  const hsa = Math.max(c['hsa'] ?? 0, categoryTotal(bookData, 'hsa_contribution'));

  const inputs: FederalTaxInputs = {
    ...emptyFederalInputs(year, filingStatus),
    wages: get('w2_wages'),
    interest: get('interest_income'),
    ordinaryDividends: get('ordinary_dividends') + qualifiedDividends,
    qualifiedDividends,
    shortTermCapitalGains: bookData.realizedGains.shortTerm,
    longTermCapitalGains: bookData.realizedGains.longTerm,
    selfEmploymentIncome: get('self_employment_income') - get('business_expense'),
    rentalIncome: get('rental_income'),
    retirementIncome: get('retirement_income'),
    socialSecurityBenefits: get('social_security_benefits'),
    otherIncome: get('other_income'),
    traditional401kContributions: trad401k,
    traditionalIraContributions: tradIra,
    hsaContributions: hsa,
    charitableDonations: get('charitable_donation'),
    mortgageInterest: get('mortgage_interest'),
    stateLocalTaxesPaid: get('state_withholding') + get('property_tax') + get('state_local_tax_paid'),
    medicalExpenses: get('medical_expense'),
    otherDeductions: get('other_deduction'),
    filersAge65Plus,
  };
  return {
    inputs,
    withholding: get('federal_withholding'),
    stateWithholding: get('state_withholding'),
  };
}

/* ------------------------------------------------------------------ */
/* Small UI helpers                                                    */
/* ------------------------------------------------------------------ */

function SummaryCard({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'positive' | 'negative' | 'neutral';
}) {
  const valueClass =
    tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-foreground';
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <p className="text-xs text-foreground-muted uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-xl font-mono font-semibold ${valueClass}`} style={{ fontFeatureSettings: "'tnum'" }}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-foreground-muted">{sub}</p>}
    </div>
  );
}

function Section({ title, subtitle, children, action }: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-surface/30 border border-border rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-foreground-muted mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function TaxEstimatorPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [filingStatus, setFilingStatus] = useState<FilingStatus>('single');
  const [stateCode, setStateCode] = useState('OTHER');
  const [stateFlatRate, setStateFlatRate] = useState(0);
  const [annualize, setAnnualize] = useState(true);
  const [filersAge65Plus, setFilersAge65Plus] = useState(0);
  const [priorYearTax, setPriorYearTax] = useState<number | ''>('');
  const [priorYearAgi, setPriorYearAgi] = useState<number | ''>('');

  const [estimate, setEstimate] = useState<EstimatePayload | null>(null);
  const [mappingsData, setMappingsData] = useState<MappingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingMappings, setSavingMappings] = useState(false);
  const [showMapper, setShowMapper] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const [scenarios, setScenarios] = useState<ContributionScenario[]>([]);
  const [scenarioConfigId, setScenarioConfigId] = useState<number | null>(null);
  const [scenarioSaveStatus, setScenarioSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  /* ---- Data fetching ---- */

  const fetchEstimate = useCallback(async (taxYear: number) => {
    const res = await fetch(`/api/tax/estimate?year=${taxYear}`);
    if (!res.ok) throw new Error('Failed to load tax estimate');
    return (await res.json()) as EstimatePayload;
  }, []);

  const fetchMappings = useCallback(async () => {
    const res = await fetch('/api/tax/mappings');
    if (!res.ok) throw new Error('Failed to load tax mappings');
    return (await res.json()) as MappingsPayload;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchEstimate(year), fetchMappings()])
      .then(([est, maps]) => {
        if (cancelled) return;
        setEstimate(est);
        setMappingsData(maps);
        if (!prefsLoaded) {
          setFilingStatus(est.preferences.filingStatus);
          setStateCode(est.preferences.state);
          setStateFlatRate(est.preferences.stateFlatRate);
          if (est.preferences.ageAtYearEnd !== null && est.preferences.ageAtYearEnd >= 65) {
            setFilersAge65Plus(1);
          }
          setPrefsLoaded(true);
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, fetchEstimate, fetchMappings]);

  /* ---- Load saved scenario config ---- */
  useEffect(() => {
    fetch('/api/tools/config?toolType=tax-estimator')
      .then(res => (res.ok ? res.json() : []))
      .then((configs: Array<{ id: number; config: Record<string, unknown> }>) => {
        if (!Array.isArray(configs) || configs.length === 0) return;
        const cfg = configs[0];
        setScenarioConfigId(cfg.id);
        const saved = cfg.config as {
          scenarios?: ContributionScenario[];
          priorYearTax?: number;
          priorYearAgi?: number;
        };
        if (Array.isArray(saved.scenarios)) setScenarios(saved.scenarios.slice(0, 3));
        if (typeof saved.priorYearTax === 'number') setPriorYearTax(Math.max(0, saved.priorYearTax));
        if (typeof saved.priorYearAgi === 'number') setPriorYearAgi(Math.max(0, saved.priorYearAgi));
      })
      .catch(() => {});
  }, []);

  /* ---- Persist preferences ---- */
  const savePreferences = useCallback(
    (patch: Partial<{ filingStatus: FilingStatus; state: string; flatRate: number }>) => {
      const preferences: Record<string, unknown> = {};
      if (patch.filingStatus) preferences.tax_filing_status = patch.filingStatus;
      if (patch.state) preferences.tax_state = patch.state;
      if (patch.flatRate !== undefined) preferences.tax_state_flat_rate = patch.flatRate;
      fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences }),
      }).catch(() => {});
    },
    [],
  );

  /* ---- Mapping save ---- */
  const handleSaveMappings = useCallback(
    async (changes: Array<{ accountGuid: string; taxCategory: TaxCategory | null }>) => {
      setSavingMappings(true);
      try {
        const res = await fetch('/api/tax/mappings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mappings: changes }),
        });
        if (!res.ok) throw new Error('Save failed');
        const [est, maps] = await Promise.all([fetchEstimate(year), fetchMappings()]);
        setEstimate(est);
        setMappingsData(maps);
      } finally {
        setSavingMappings(false);
      }
    },
    [fetchEstimate, fetchMappings, year],
  );

  /* ---- Scenario persistence ---- */
  const handleSaveScenarios = useCallback(async () => {
    setScenarioSaveStatus('saving');
    try {
      const payload = {
        toolType: 'tax-estimator',
        name: 'Tax Estimator Scenarios',
        config: {
          scenarios,
          priorYearTax: priorYearTax === '' ? undefined : priorYearTax,
          priorYearAgi: priorYearAgi === '' ? undefined : priorYearAgi,
        },
      };
      const res = scenarioConfigId
        ? await fetch(`/api/tools/config/${scenarioConfigId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: payload.name, config: payload.config }),
          })
        : await fetch('/api/tools/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      if (!res.ok) throw new Error('save failed');
      const saved = await res.json();
      if (saved?.id) setScenarioConfigId(saved.id);
      setScenarioSaveStatus('saved');
      setTimeout(() => setScenarioSaveStatus('idle'), 2000);
    } catch {
      setScenarioSaveStatus('error');
      setTimeout(() => setScenarioSaveStatus('idle'), 3000);
    }
  }, [scenarios, priorYearTax, priorYearAgi, scenarioConfigId]);

  /* ---- Compute ---- */

  const computed = useMemo(() => {
    if (!estimate) return null;
    const { inputs, withholding, stateWithholding } = buildInputs(
      estimate.bookData, year, filingStatus, annualize, filersAge65Plus,
    );
    const federal = computeFederalTax(inputs);
    const state = computeStateTax(stateCode, {
      year,
      filingStatus,
      federalAgi: federal.agi,
      flatRateOverride: stateFlatRate,
    });
    const totalLiability = Math.round((federal.totalTax + state.tax) * 100) / 100;
    const totalWithheld = withholding + stateWithholding;
    const balance = totalLiability - totalWithheld;
    const safeHarbor = computeSafeHarbor({
      year,
      filingStatus,
      currentYearTax: federal.totalTax,
      priorYearTax: priorYearTax === '' ? null : priorYearTax,
      priorYearAgi: priorYearAgi === '' ? null : priorYearAgi,
      withholding,
    });
    return { inputs, federal, state, totalLiability, withholding, stateWithholding, totalWithheld, balance, safeHarbor };
  }, [estimate, year, filingStatus, annualize, filersAge65Plus, stateCode, stateFlatRate, priorYearTax, priorYearAgi]);

  const scenarioLimits: ScenarioLimits | null = useMemo(() => {
    if (!estimate || !computed) return null;
    const c = estimate.bookData.contributionsByType;
    return {
      limits: {
        trad401k: estimate.limits['401k']?.total ?? null,
        roth401k: estimate.limits['401k']?.total ?? null,
        tradIra: estimate.limits.ira?.total ?? null,
        rothIra: estimate.limits.ira?.total ?? null,
        hsa: estimate.limits.hsa?.total ?? null,
      },
      actuals: {
        trad401k: (c['401k'] ?? 0) + (c['403b'] ?? 0) + (c['457'] ?? 0),
        roth401k: 0, // Roth deferrals tracked within the same flagged 401k account
        tradIra: c['traditional_ira'] ?? 0,
        rothIra: c['roth_ira'] ?? 0,
        hsa: c['hsa'] ?? 0,
      },
    };
  }, [estimate, computed]);

  const hasMappings = (estimate?.bookData.mappedAccountCount ?? 0) > 0;
  const isCurrentYear = year === currentYear;

  /* ---- Render ---- */

  if (loading && !estimate) {
    return (
      <div className="flex items-center justify-center min-h-[300px] text-foreground-muted text-sm">
        Loading tax estimator…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-error/10 border border-error/30 rounded-lg p-6 text-sm text-error">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* (a) Header */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Tax Estimator</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Federal + state estimates from your book data, with contribution scenario modeling.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={year}
              onChange={e => setYear(parseInt(e.target.value, 10) as TaxYear)}
              aria-label="Tax year"
              className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {SUPPORTED_TAX_YEARS.map(y => (
                <option key={y} value={y}>Tax year {y}</option>
              ))}
            </select>
            <select
              value={filingStatus}
              onChange={e => {
                const fs = e.target.value as FilingStatus;
                setFilingStatus(fs);
                savePreferences({ filingStatus: fs });
              }}
              aria-label="Filing status"
              className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {FILING_STATUSES.map(fs => (
                <option key={fs} value={fs}>{FILING_STATUS_LABELS[fs]}</option>
              ))}
            </select>
            <select
              value={stateCode}
              onChange={e => {
                setStateCode(e.target.value);
                savePreferences({ state: e.target.value });
              }}
              aria-label="State"
              className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {STATE_OPTIONS.map(s => (
                <option key={s.code} value={s.code}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {stateCode === 'OTHER' && (
              <label className="flex items-center gap-1.5 text-xs text-foreground-secondary">
                Flat rate %
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={0.1}
                  value={stateFlatRate * 100 || ''}
                  placeholder="0"
                  onChange={e => {
                    const rate = Math.max(0, (parseFloat(e.target.value) || 0) / 100);
                    setStateFlatRate(rate);
                    savePreferences({ flatRate: rate });
                  }}
                  className="w-16 bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-right font-mono text-foreground focus:outline-none focus:border-primary"
                />
              </label>
            )}
            {isCurrentYear && (
              <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={annualize}
                  onChange={e => setAnnualize(e.target.checked)}
                  className="accent-[var(--primary)]"
                />
                Annualize YTD
              </label>
            )}
            <label className="flex items-center gap-1.5 text-xs text-foreground-secondary">
              Filers 65+
              <select
                value={filersAge65Plus}
                onChange={e => setFilersAge65Plus(parseInt(e.target.value, 10))}
                className="bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
              >
                <option value={0}>0</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
          </div>
        </div>
      </header>

      {/* Onboarding empty state */}
      {!hasMappings && mappingsData && (
        <Section
          title="Get started: map your accounts to tax categories"
          subtitle="The estimator reads income, withholding, deductions, and contributions from your book once accounts are mapped. Start from the suggestions below. Hidden and placeholder accounts are excluded."
        >
          <TaxMappingPanel
            accounts={mappingsData.accounts}
            mappings={mappingsData.mappings}
            suggestions={mappingsData.suggestions}
            saving={savingMappings}
            onSave={handleSaveMappings}
          />
        </Section>
      )}

      {hasMappings && computed && estimate && (
        <>
          {/* (b) Summary cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label={`Projected ${year} liability`}
              value={formatCurrency(computed.totalLiability)}
              sub={`Federal ${formatCurrency(computed.federal.totalTax)} + ${computed.state.stateName} ${formatCurrency(computed.state.tax)}`}
            />
            <SummaryCard
              label="Withheld (projected)"
              value={formatCurrency(computed.totalWithheld)}
              sub={`Federal ${formatCurrency(computed.withholding)} · State ${formatCurrency(computed.stateWithholding)}`}
            />
            <SummaryCard
              label={computed.balance >= 0 ? 'Projected balance due' : 'Projected refund'}
              value={formatCurrency(Math.abs(computed.balance))}
              tone={computed.balance >= 0 ? 'negative' : 'positive'}
              sub={annualize && isCurrentYear ? 'Annualized from YTD' : 'Year totals'}
            />
            <SummaryCard
              label="Marginal / effective rate"
              value={`${pct(computed.federal.marginalRate, 0)} / ${pct(computed.federal.effectiveRate)}`}
              sub="Federal ordinary marginal · effective on AGI"
            />
          </div>

          {/* (c) Income & deduction breakdown */}
          <Section
            title="Income & deductions"
            subtitle={`From mapped accounts, ${estimate.bookData.startDate} → ${estimate.bookData.asOfDate}${annualize && isCurrentYear ? ` · annualized ×${(1 / estimate.bookData.elapsedYearFraction).toFixed(2)}` : ''}`}
            action={
              <button
                onClick={() => setShowMapper(v => !v)}
                className="text-xs font-medium px-3 py-1.5 rounded-md border border-border text-foreground-secondary hover:text-primary hover:border-primary/50 transition-colors"
              >
                {showMapper ? 'Hide account mapping' : 'Edit account mapping'}
              </button>
            }
          >
            {showMapper && mappingsData && (
              <div className="border-b border-border pb-4 mb-2">
                <TaxMappingPanel
                  accounts={mappingsData.accounts}
                  mappings={mappingsData.mappings}
                  suggestions={mappingsData.suggestions}
                  saving={savingMappings}
                  onSave={handleSaveMappings}
                />
              </div>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              {/* Category provenance table */}
              <div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-foreground-muted border-b border-border">
                      <th className="py-2 font-medium">Category</th>
                      <th className="py-2 font-medium text-right">YTD</th>
                      <th className="py-2 font-medium text-right pr-1">Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {estimate.bookData.categories.map(cat => {
                      const factor = annualize && isCurrentYear && ANNUALIZABLE.includes(cat.category)
                        ? 1 / estimate.bookData.elapsedYearFraction : 1;
                      return (
                        <CategoryRow
                          key={cat.category}
                          label={TAX_CATEGORY_LABELS[cat.category]}
                          ytd={cat.total}
                          used={cat.total * factor}
                          accounts={cat.accounts}
                        />
                      );
                    })}
                    {(Math.abs(estimate.bookData.realizedGains.shortTerm) > 0.004 ||
                      Math.abs(estimate.bookData.realizedGains.longTerm) > 0.004) && (
                      <>
                        <CategoryRow
                          label="Realized short-term gains (lots)"
                          ytd={estimate.bookData.realizedGains.shortTerm}
                          used={estimate.bookData.realizedGains.shortTerm}
                          accounts={estimate.bookData.realizedGains.accounts.map(a => ({
                            accountGuid: a.accountGuid, accountName: a.accountName,
                            accountPath: a.accountPath, amount: a.shortTerm,
                          }))}
                        />
                        <CategoryRow
                          label="Realized long-term gains (lots)"
                          ytd={estimate.bookData.realizedGains.longTerm}
                          used={estimate.bookData.realizedGains.longTerm}
                          accounts={estimate.bookData.realizedGains.accounts.map(a => ({
                            accountGuid: a.accountGuid, accountName: a.accountName,
                            accountPath: a.accountPath, amount: a.longTerm,
                          }))}
                        />
                      </>
                    )}
                  </tbody>
                </table>
                <p className="text-[11px] text-foreground-muted mt-2">
                  Realized gains and retirement contributions are never annualized.
                  Click a category to see source accounts.
                </p>
              </div>

              {/* Computation breakdown */}
              <div className="text-sm">
                <dl className="space-y-1.5 font-mono text-xs" style={{ fontFeatureSettings: "'tnum'" }}>
                  <BreakdownRow label="Total income" value={computed.federal.totalIncome} />
                  <BreakdownRow label="Adjustments (401k/IRA/HSA/½ SE tax)" value={-computed.federal.adjustments} />
                  <BreakdownRow label="AGI" value={computed.federal.agi} strong />
                  <BreakdownRow
                    label={computed.federal.usedItemized
                      ? `Itemized deduction (SALT capped at ${formatCurrency(computed.federal.itemizedBreakdown.saltCap)})`
                      : 'Standard deduction'}
                    value={-computed.federal.deductionTaken}
                  />
                  {computed.federal.seniorDeduction > 0 && (
                    <BreakdownRow label="Senior deduction (OBBBA)" value={-computed.federal.seniorDeduction} />
                  )}
                  <BreakdownRow label="Taxable income" value={computed.federal.taxableIncome} strong />
                  <div className="pt-2" />
                  <BreakdownRow label="Ordinary income tax" value={computed.federal.ordinaryTax} />
                  <BreakdownRow label="Capital gains / QDI tax" value={computed.federal.capitalGainsTax} />
                  {computed.federal.selfEmploymentTax > 0 && (
                    <BreakdownRow label="Self-employment tax" value={computed.federal.selfEmploymentTax} />
                  )}
                  {computed.federal.niit > 0 && (
                    <BreakdownRow label="Net investment income tax (3.8%)" value={computed.federal.niit} />
                  )}
                  {computed.federal.additionalMedicareTax > 0 && (
                    <BreakdownRow label="Additional Medicare (0.9%)" value={computed.federal.additionalMedicareTax} />
                  )}
                  <BreakdownRow label="Credits (not yet modeled)" value={-computed.federal.credits} />
                  <BreakdownRow label="Federal total" value={computed.federal.totalTax} strong />
                  <BreakdownRow label={`${computed.state.stateName} tax`} value={computed.state.tax} />
                  <BreakdownRow label="Combined liability" value={computed.totalLiability} strong />
                </dl>
                {computed.state.notes.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {computed.state.notes.map((n, i) => (
                      <li key={i} className="text-[11px] text-foreground-muted">• {n}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Section>

          {/* (d) Bracket fill chart */}
          <Section
            title="Bracket fill"
            subtitle="How taxable income fills the federal brackets. LTCG and qualified dividends stack on top of ordinary income."
          >
            <BracketFillChart federal={computed.federal} />
          </Section>

          {/* (e) Quarterly estimated payments */}
          <Section
            title="Quarterly estimated payments"
            subtitle="Safe harbor: pay the smaller of 90% of this year's tax or 100% of last year's (110% if prior AGI over $150k) through withholding and estimates to avoid penalties."
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="flex flex-wrap gap-4">
                  <label className="text-xs text-foreground-secondary">
                    Prior-year total tax
                    <input
                      type="number"
                      min={0}
                      value={priorYearTax}
                      placeholder="e.g. 24000"
                      onChange={e => setPriorYearTax(e.target.value === '' ? '' : Math.max(0, parseFloat(e.target.value) || 0))}
                      className="block mt-1 w-36 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-xs text-right font-mono text-foreground focus:outline-none focus:border-primary"
                    />
                  </label>
                  <label className="text-xs text-foreground-secondary">
                    Prior-year AGI
                    <input
                      type="number"
                      min={0}
                      value={priorYearAgi}
                      placeholder="e.g. 180000"
                      onChange={e => setPriorYearAgi(e.target.value === '' ? '' : Math.max(0, parseFloat(e.target.value) || 0))}
                      className="block mt-1 w-36 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-xs text-right font-mono text-foreground focus:outline-none focus:border-primary"
                    />
                  </label>
                </div>
                <dl className="space-y-1.5 font-mono text-xs" style={{ fontFeatureSettings: "'tnum'" }}>
                  <BreakdownRow label="90% of current-year tax" value={computed.safeHarbor.ninetyPercentCurrent} />
                  {computed.safeHarbor.priorYearSafeHarbor !== null && (
                    <BreakdownRow
                      label={`${Math.round((computed.safeHarbor.priorYearMultiplier ?? 1) * 100)}% of prior-year tax`}
                      value={computed.safeHarbor.priorYearSafeHarbor}
                    />
                  )}
                  <BreakdownRow label="Required annual payment" value={computed.safeHarbor.requiredAnnualPayment} strong />
                  <BreakdownRow label="Projected federal withholding" value={-computed.safeHarbor.withholding} />
                  <BreakdownRow label="Estimated payments needed" value={computed.safeHarbor.estimatedPaymentsNeeded} strong />
                </dl>
                {computed.safeHarbor.underThousandDollarRule && (
                  <p className="text-[11px] text-positive">
                    Projected balance due after withholding is under $1,000 — no estimated payments required.
                  </p>
                )}
                {!computed.safeHarbor.underThousandDollarRule && computed.safeHarbor.estimatedPaymentsNeeded > 0 && (
                  <p className="text-[11px] text-warning">
                    Withholding alone does not reach the safe harbor — quarterly payments below avoid an underpayment penalty.
                  </p>
                )}
              </div>
              <table className="w-full text-sm self-start">
                <thead>
                  <tr className="text-left text-xs text-foreground-muted border-b border-border">
                    <th className="py-2 font-medium">Quarter</th>
                    <th className="py-2 font-medium">Due date</th>
                    <th className="py-2 font-medium text-right">Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {computed.safeHarbor.quarterlySchedule.map(q => (
                    <tr key={q.quarter} className="border-b border-border/50">
                      <td className="py-2 text-foreground-secondary">Q{q.quarter}</td>
                      <td className="py-2 font-mono text-xs text-foreground-secondary">{q.dueDate}</td>
                      <td className={`py-2 text-right font-mono text-xs ${q.amount > 0 ? 'text-foreground' : 'text-foreground-muted'}`}>
                        {formatCurrency(q.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* (f) Contribution scenarios */}
          {scenarioLimits && (
            <Section
              title="Contribution scenarios"
              subtitle="Model additional tax-advantaged contributions on top of your actuals. Each scenario is validated against remaining IRS limits."
            >
              <ScenarioPanel
                baseInputs={computed.inputs}
                limits={scenarioLimits}
                stateCode={stateCode}
                stateFlatRateOverride={stateFlatRate}
                baselineLiability={computed.totalLiability}
                scenarios={scenarios}
                onScenariosChange={setScenarios}
                onSaveScenarios={handleSaveScenarios}
                saveStatus={scenarioSaveStatus}
              />
            </Section>
          )}
        </>
      )}

      {/* (h) Disclaimer */}
      <footer className="border-t border-border pt-4 pb-2">
        <p className="text-[11px] text-foreground-muted">
          Estimates only — not tax advice. This tool simplifies many provisions (credits, AMT, phase-outs,
          state-specific deductions and credits are not modeled). Bracket and deduction figures from IRS
          Rev. Proc. 2023-34, 2024-40, and 2025-32, as amended by the One Big Beautiful Bill Act.
          Consult a tax professional before making decisions.
        </p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Row components                                                      */
/* ------------------------------------------------------------------ */

function BreakdownRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-border pt-1.5' : ''}`}>
      <dt className={strong ? 'text-foreground font-medium' : 'text-foreground-muted'}>{label}</dt>
      <dd className={strong ? 'text-foreground font-semibold' : 'text-foreground-secondary'}>
        {formatCurrency(value)}
      </dd>
    </div>
  );
}

function CategoryRow({ label, ytd, used, accounts }: {
  label: string;
  ytd: number;
  used: number;
  accounts: Array<{ accountGuid: string; accountName: string; accountPath: string; amount: number }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="border-b border-border/50 hover:bg-surface-hover cursor-pointer"
        onClick={() => setOpen(v => !v)}
      >
        <td className="py-1.5 text-xs text-foreground-secondary">
          <span className="text-foreground-muted mr-1">{open ? '▾' : '▸'}</span>
          {label}
        </td>
        <td className="py-1.5 text-right font-mono text-xs text-foreground-secondary" style={{ fontFeatureSettings: "'tnum'" }}>
          {formatCurrency(ytd)}
        </td>
        <td className="py-1.5 text-right font-mono text-xs text-foreground pr-1" style={{ fontFeatureSettings: "'tnum'" }}>
          {formatCurrency(used)}
        </td>
      </tr>
      {open && accounts.map(a => (
        <tr key={a.accountGuid} className="border-b border-border/30">
          <td className="py-1 pl-6 text-[11px]">
            <Link href={`/accounts/${a.accountGuid}`} className="text-secondary hover:text-secondary-hover" title={a.accountPath}>
              {a.accountPath}
            </Link>
          </td>
          <td className="py-1 text-right font-mono text-[11px] text-foreground-muted" colSpan={2}>
            {formatCurrency(a.amount)}
          </td>
        </tr>
      ))}
    </>
  );
}
