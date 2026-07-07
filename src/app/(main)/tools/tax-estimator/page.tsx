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
import { computeIraDeductionLimit, computeRothIraContributionLimit } from '@/lib/tax/phaseouts';
import { summarizeTaxPayments, type TaxPaymentsSummary } from '@/lib/tax/payments';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from '@/components/ui/MobileCard';
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
    spouseBirthday: string | null;
    spouseAgeAtYearEnd: number | null;
    coveredByEmployerPlan: boolean;
    spouseCoveredByEmployerPlan: boolean;
  };
  entity?: {
    entityType: string;
    entityName: string | null;
    synthesized: boolean;
    memberCount: number;
    dependentsUnder17: number;
    owners: Array<{ name: string | null; ownershipPercent: number | null }>;
  };
  limits: {
    '401k': LimitInfo | null;
    ira: LimitInfo | null;
    hsa: LimitInfo | null;
    spouseIra: LimitInfo | null;
  };
}

const BUSINESS_ENTITY_LABELS: Record<string, string> = {
  sole_prop: 'Sole Proprietorship',
  llc_single: 'Single-Member LLC',
  llc_partnership: 'Partnership LLC',
  s_corp: 'S-Corp',
  c_corp: 'C-Corp',
  nonprofit_501c3: '501(c)(3) Nonprofit',
};

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
  'w2_wages', 'federal_withholding', 'state_withholding', 'estimated_tax_payment',
  'state_estimated_tax_payment', 'fica_social_security',
  'fica_medicare', 'interest_income', 'tax_exempt_interest', 'ordinary_dividends',
  'qualified_dividends',
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
): { inputs: FederalTaxInputs; payments: TaxPaymentsSummary } {
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
  const sepIra = Math.max(c['sep_ira'] ?? 0, categoryTotal(bookData, 'sep_ira_contribution'));
  const simpleIra = Math.max(c['simple_ira'] ?? 0, categoryTotal(bookData, 'simple_ira_contribution'));

  const inputs: FederalTaxInputs = {
    ...emptyFederalInputs(year, filingStatus),
    wages: get('w2_wages'),
    interest: get('interest_income'),
    // Muni interest: excluded from taxable income/AGI; only feeds Social
    // Security taxability (Pub 915) inside the federal engine.
    taxExemptInterest: get('tax_exempt_interest'),
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
    sepIraContributions: sepIra,
    simpleIraContributions: simpleIra,
    charitableDonations: get('charitable_donation'),
    mortgageInterest: get('mortgage_interest'),
    // State estimated payments count as state income tax paid during the
    // year (Schedule A line 5a), same as state withholding.
    stateLocalTaxesPaid: get('state_withholding') + get('state_estimated_tax_payment')
      + get('property_tax') + get('state_local_tax_paid'),
    medicalExpenses: get('medical_expense'),
    otherDeductions: get('other_deduction'),
    filersAge65Plus,
  };
  return {
    inputs,
    payments: summarizeTaxPayments(bookData, factor),
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
  const isMobile = useIsMobile();
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
  const [spouseBirthday, setSpouseBirthday] = useState('');
  const [coveredByPlan, setCoveredByPlan] = useState(true);
  const [spouseCovered, setSpouseCovered] = useState(false);

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
          setSpouseBirthday(est.preferences.spouseBirthday ?? '');
          setCoveredByPlan(est.preferences.coveredByEmployerPlan ?? true);
          setSpouseCovered(est.preferences.spouseCoveredByEmployerPlan ?? false);
          const selfIs65 = est.preferences.ageAtYearEnd !== null && est.preferences.ageAtYearEnd >= 65;
          const spouseIs65 = est.preferences.spouseAgeAtYearEnd !== null && est.preferences.spouseAgeAtYearEnd >= 65;
          if (selfIs65 || spouseIs65) {
            setFilersAge65Plus((selfIs65 ? 1 : 0) + (spouseIs65 ? 1 : 0));
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
    (patch: Partial<{
      filingStatus: FilingStatus;
      state: string;
      flatRate: number;
      spouseBirthday: string | null;
      coveredByPlan: boolean;
      spouseCovered: boolean;
    }>) => {
      const preferences: Record<string, unknown> = {};
      if (patch.filingStatus) preferences.tax_filing_status = patch.filingStatus;
      if (patch.state) preferences.tax_state = patch.state;
      if (patch.flatRate !== undefined) preferences.tax_state_flat_rate = patch.flatRate;
      if (patch.spouseBirthday !== undefined) preferences.spouse_birthday = patch.spouseBirthday || null;
      if (patch.coveredByPlan !== undefined) preferences.tax_covered_by_employer_plan = patch.coveredByPlan;
      if (patch.spouseCovered !== undefined) preferences.tax_spouse_covered_by_employer_plan = patch.spouseCovered;
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
    const { inputs: baseInputs, payments } = buildInputs(
      estimate.bookData, year, filingStatus, annualize, filersAge65Plus,
    );
    // Child Tax Credit: qualifying children come from the household profile
    // (dependents under 17 at year end).
    const inputs: FederalTaxInputs = {
      ...baseInputs,
      qualifyingChildrenUnder17: estimate.entity?.dependentsUnder17 ?? 0,
    };

    // ---- Income-based IRA deduction phase-out ----
    // MAGI for IRA purposes is computed WITHOUT the IRA deduction itself, so
    // run a first pass with zero traditional IRA contributions.
    const magiPass = computeFederalTax({ ...inputs, traditionalIraContributions: 0 });
    const magi = magiPass.agi;

    const isJoint = filingStatus === 'mfj' || filingStatus === 'qss';
    const byOwner = estimate.bookData.contributionsByTypeAndOwner;
    const tradIraSelf = isJoint && byOwner
      ? byOwner['traditional_ira']?.self ?? 0
      : inputs.traditionalIraContributions;
    const tradIraSpouse = isJoint && byOwner ? byOwner['traditional_ira']?.spouse ?? 0 : 0;
    // Owner attribution may not cover category-mapped contributions; put any
    // remainder on self so nothing is silently dropped.
    const attributed = tradIraSelf + tradIraSpouse;
    const remainder = Math.max(0, inputs.traditionalIraContributions - attributed);

    const selfIraLimit = estimate.limits.ira?.total ?? null;
    const spouseIraLimit = estimate.limits.spouseIra?.total ?? null;

    const selfPhaseOut = selfIraLimit !== null
      ? computeIraDeductionLimit({
          year, filingStatus, magi,
          coveredByEmployerPlan: coveredByPlan,
          spouseCoveredByEmployerPlan: spouseCovered,
          iraLimit: selfIraLimit,
        })
      : null;
    const spousePhaseOut = isJoint && spouseIraLimit !== null
      ? computeIraDeductionLimit({
          year, filingStatus, magi,
          coveredByEmployerPlan: spouseCovered,
          spouseCoveredByEmployerPlan: coveredByPlan,
          iraLimit: spouseIraLimit,
        })
      : null;

    const selfRoth = selfIraLimit !== null
      ? computeRothIraContributionLimit({ year, filingStatus, magi, iraLimit: selfIraLimit })
      : null;
    const spouseRoth = isJoint && spouseIraLimit !== null
      ? computeRothIraContributionLimit({ year, filingStatus, magi, iraLimit: spouseIraLimit })
      : null;

    const deductibleSelf = selfPhaseOut
      ? Math.min(tradIraSelf + remainder, selfPhaseOut.deductibleLimit)
      : tradIraSelf + remainder;
    const deductibleSpouse = spousePhaseOut
      ? Math.min(tradIraSpouse, spousePhaseOut.deductibleLimit)
      : tradIraSpouse;
    const deductibleIra = Math.round((deductibleSelf + deductibleSpouse) * 100) / 100;
    const nonDeductibleIra = Math.max(0, inputs.traditionalIraContributions - deductibleIra);

    const cappedInputs: FederalTaxInputs = { ...inputs, traditionalIraContributions: deductibleIra };
    const federal = computeFederalTax(cappedInputs);
    const phaseOuts = {
      magi,
      self: { deduction: selfPhaseOut, roth: selfRoth, tradContrib: tradIraSelf + remainder },
      spouse: isJoint ? { deduction: spousePhaseOut, roth: spouseRoth, tradContrib: tradIraSpouse } : null,
      nonDeductibleIra,
    };
    const state = computeStateTax(stateCode, {
      year,
      filingStatus,
      federalAgi: federal.agi,
      flatRateOverride: stateFlatRate,
    });
    const totalLiability = Math.round((federal.totalTax + state.tax) * 100) / 100;
    // Total taxes paid: withholding + estimated payments (federal and state)
    const totalWithheld = payments.totalPaid;
    const balance = totalLiability - totalWithheld;
    // Safe harbor intentionally receives withholding only: its quarterly
    // schedule computes the estimated payments STILL needed on top of
    // withholding (withholding is treated as paid evenly through the year).
    const safeHarbor = computeSafeHarbor({
      year,
      filingStatus,
      currentYearTax: federal.totalTax,
      priorYearTax: priorYearTax === '' ? null : priorYearTax,
      priorYearAgi: priorYearAgi === '' ? null : priorYearAgi,
      withholding: payments.withholding,
    });
    return { inputs: cappedInputs, federal, state, totalLiability, payments, totalWithheld, balance, safeHarbor, phaseOuts };
  }, [estimate, year, filingStatus, annualize, filersAge65Plus, stateCode, stateFlatRate, priorYearTax, priorYearAgi, coveredByPlan, spouseCovered]);

  const scenarioLimits: ScenarioLimits | null = useMemo(() => {
    if (!estimate || !computed) return null;
    const c = estimate.bookData.contributionsByType;
    // For joint filers each spouse has their own IRA limit (with their own
    // catch-up); the household headroom is the sum.
    const isJoint = filingStatus === 'mfj' || filingStatus === 'qss';
    const iraLimit = estimate.limits.ira !== null
      ? estimate.limits.ira.total + (isJoint ? (estimate.limits.spouseIra?.total ?? 0) : 0)
      : null;
    return {
      limits: {
        trad401k: estimate.limits['401k']?.total ?? null,
        roth401k: estimate.limits['401k']?.total ?? null,
        tradIra: iraLimit,
        rothIra: iraLimit,
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
  }, [estimate, computed, filingStatus]);

  const hasMappings = (estimate?.bookData.mappedAccountCount ?? 0) > 0;
  const isCurrentYear = year === currentYear;

  /* ---- Entity type (from the book's entity profile) ---- */
  const entityType = estimate?.entity?.entityType ?? 'household';
  const isScheduleC = entityType === 'sole_prop' || entityType === 'llc_single';
  // Pass-through entities (S-Corp/partnership) and exempt orgs don't get a
  // personal 1040 estimate on this book; C-Corps get an entity-level estimate.
  const showPersonalEstimate = entityType === 'household' || isScheduleC;

  const businessSummary = useMemo(() => {
    if (!estimate || showPersonalEstimate) return null;
    const rev = (['self_employment_income', 'rental_income', 'interest_income', 'ordinary_dividends', 'other_income'] as TaxCategory[])
      .reduce((s, cat) => s + categoryTotal(estimate.bookData, cat), 0);
    const exp = (['business_expense', 'other_deduction'] as TaxCategory[])
      .reduce((s, cat) => s + categoryTotal(estimate.bookData, cat), 0);
    const net = rev - exp;
    return { revenue: rev, expenses: exp, net };
  }, [estimate, showPersonalEstimate]);

  const settingsSummary = [
    String(year),
    FILING_STATUS_LABELS[filingStatus],
    stateCode === 'OTHER' ? `Flat ${(stateFlatRate * 100).toFixed(1)}%` : stateCode,
    annualize && isCurrentYear ? 'Annualized' : null,
  ].filter(Boolean).join(' · ');

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
      <header>
        <h1 className="text-3xl font-bold text-foreground">Tax Estimator</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Federal + state estimates from your book data, with contribution scenario modeling.
        </p>
      </header>

      {/* Tax settings */}
      <CollapsibleConfigSection
        title="Tax settings"
        summary={settingsSummary}
        configured={!!estimate}
        storageKey="taxEstimator.settingsOpen"
      >
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

        {/* Retirement plan coverage & spouse (drives IRA deduction phase-outs) */}
        <div className="mt-3 pt-3 border-t border-border/60 flex flex-wrap items-center gap-x-4 gap-y-2">
          {estimate?.entity && !estimate.entity.synthesized ? (
            <span className="text-xs text-foreground-muted">
              Household details (spouse, workplace-plan coverage, children) are managed in{' '}
              <Link href="/settings" className="text-primary hover:text-primary-hover underline underline-offset-2">
                Settings → Household &amp; entity
              </Link>
              . {estimate.entity.dependentsUnder17 > 0 && (
                <>Counting {estimate.entity.dependentsUnder17} qualifying child{estimate.entity.dependentsUnder17 === 1 ? '' : 'ren'} under 17 for the Child Tax Credit.</>
              )}
            </span>
          ) : (
          <>
          <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={coveredByPlan}
              onChange={e => {
                setCoveredByPlan(e.target.checked);
                savePreferences({ coveredByPlan: e.target.checked });
              }}
              className="accent-[var(--primary)]"
            />
            Covered by a workplace plan
          </label>
          {(filingStatus === 'mfj' || filingStatus === 'qss') && (
            <>
              <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={spouseCovered}
                  onChange={e => {
                    setSpouseCovered(e.target.checked);
                    savePreferences({ spouseCovered: e.target.checked });
                  }}
                  className="accent-[var(--primary)]"
                />
                Spouse covered by a workplace plan
              </label>
              <label className="flex items-center gap-1.5 text-xs text-foreground-secondary">
                Spouse birthday
                <input
                  type="date"
                  value={spouseBirthday}
                  onChange={e => {
                    setSpouseBirthday(e.target.value);
                    savePreferences({ spouseBirthday: e.target.value });
                  }}
                  onBlur={() => {
                    // Spouse limits are resolved server-side from the birthday
                    fetchEstimate(year).then(setEstimate).catch(() => {});
                  }}
                  className="bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
                />
              </label>
              <span className="text-[11px] text-foreground-muted">
                Enables the spouse&apos;s own IRA limit and catch-up. Mark retirement accounts as
                yours or your spouse&apos;s when editing the account.
              </span>
            </>
          )}
          </>
          )}
        </div>
      </CollapsibleConfigSection>

      {/* Setup guide */}
      <CollapsibleConfigSection
        title="Setup guide — making the estimate accurate"
        summary="How to flag retirement accounts, map categories, and mark non-taxable accounts"
        configured={hasMappings}
        storageKey="taxEstimator.setupGuideOpen"
      >
        <div className="space-y-4 text-sm text-foreground-secondary max-w-3xl">
          <div>
            <h4 className="font-semibold text-foreground mb-1">1. Flag retirement accounts</h4>
            <p>
              Edit each 401(k) / IRA / HSA account (Accounts page → edit) and check{' '}
              <span className="text-foreground">Retirement account</span>, choosing the type and the owner
              (you or your spouse). Everything inside a flagged account is tax-sheltered: its realized
              gains, dividends, and interest never count as taxable here, and its contributions are
              tracked against the right IRS limit per person.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground mb-1">2. Map income &amp; expense accounts to tax categories</h4>
            <p>
              Use <span className="text-foreground">Edit account mapping</span> below. A mapping covers the
              account <em>and all its sub-accounts</em>; an explicit mapping on a child overrides its
              parent. Map W-2 wages, federal/state withholding, FICA, taxable dividends/interest,
              self-employment income, and deductions (charitable, mortgage interest, property tax, medical).
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground mb-1">3. Mark non-taxable accounts as Excluded</h4>
            <p>
              Two places this matters: <span className="text-foreground">non-taxable investment accounts</span>{' '}
              (asset side) mapped to Excluded stop feeding capital gains, and{' '}
              <span className="text-foreground">non-taxable income accounts</span> (e.g. IRA dividends routed
              into a shared <code className="text-xs">Income:…:non-taxable</code> account under a mapped parent)
              mapped to Excluded stop counting as taxable income. Accounts named &ldquo;non-taxable&rdquo; get
              Excluded suggested automatically, and income that lands inside a flagged retirement account is
              guarded even without a mapping.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground mb-1">4. Special categories</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li><span className="text-foreground">Tax-Exempt Interest (muni)</span> — municipal bond interest: excluded from AGI but counted for Social Security taxability.</li>
              <li><span className="text-foreground">Employer Match (income)</span> — the income account funding your employer&rsquo;s match, so match money never counts as your own contribution.</li>
              <li><span className="text-foreground">Federal / State Estimated Tax Payment</span> — accounts you pay 1040-ES or state vouchers from; the refund estimate uses withholding <em>plus</em> these payments.</li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-foreground mb-1">5. Household &amp; filing details</h4>
            <p>
              Set spouse and children (with birthdays) in <span className="text-foreground">Settings →
              Household &amp; entity</span> — birthdays drive catch-up limits, per-spouse IRA tracking, and the
              Child Tax Credit. The workplace-plan coverage checkboxes in Tax settings above control the
              traditional-IRA deduction phase-outs.
            </p>
          </div>
        </div>
      </CollapsibleConfigSection>

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

      {/* Schedule C note for pass-through single-owner businesses */}
      {hasMappings && estimate && isScheduleC && (
        <div className="bg-secondary-light border border-border rounded-lg px-4 py-3 text-xs text-foreground-secondary">
          This book is a <span className="font-medium text-foreground">{BUSINESS_ENTITY_LABELS[entityType]}</span> —
          its activity is reported on Schedule C of your personal return. The estimate below includes
          self-employment tax on mapped self-employment income.
        </div>
      )}

      {/* Business entity mode: S-Corp / Partnership / C-Corp / 501(c)(3) */}
      {hasMappings && estimate && !showPersonalEstimate && businessSummary && (
        <Section
          title={estimate.entity?.entityName
            ? `${estimate.entity.entityName} — ${BUSINESS_ENTITY_LABELS[entityType] ?? entityType}`
            : BUSINESS_ENTITY_LABELS[entityType] ?? entityType}
          subtitle={`Mapped book activity, ${estimate.bookData.startDate} → ${estimate.bookData.asOfDate}`}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
            <SummaryCard label="Revenue (mapped)" value={formatCurrency(businessSummary.revenue)} />
            <SummaryCard label="Expenses (mapped)" value={formatCurrency(businessSummary.expenses)} />
            <SummaryCard
              label="Net income"
              value={formatCurrency(businessSummary.net)}
              tone={businessSummary.net >= 0 ? 'positive' : 'negative'}
            />
            {entityType === 'c_corp' ? (
              <SummaryCard
                label="Est. federal tax (21%)"
                value={formatCurrency(Math.max(0, businessSummary.net) * 0.21)}
                tone="negative"
                sub="Flat corporate rate on net income"
              />
            ) : entityType === 'nonprofit_501c3' ? (
              <SummaryCard label="Federal income tax" value="$0" tone="positive" sub="Exempt under 501(c)(3)" />
            ) : (
              <SummaryCard label="Entity-level federal tax" value="$0" sub="Income passes through to owners (K-1)" />
            )}
          </div>

          {(entityType === 's_corp' || entityType === 'llc_partnership') && (
            <>
              {(estimate.entity?.owners.length ?? 0) > 0 ? (
                <div className="space-y-1 mb-3">
                  <p className="text-xs font-medium text-foreground-secondary">Distributive shares (by ownership %)</p>
                  {estimate.entity!.owners.map((o, i) => (
                    <div key={i} className="flex items-baseline justify-between text-xs border-t border-border/60 py-1">
                      <span className="text-foreground-secondary">
                        {o.name || `Owner ${i + 1}`}{o.ownershipPercent != null ? ` · ${o.ownershipPercent}%` : ''}
                      </span>
                      <span className="font-mono text-foreground">
                        {o.ownershipPercent != null
                          ? formatCurrency(businessSummary.net * (o.ownershipPercent / 100))
                          : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-foreground-muted mb-3">
                  Add owners with ownership percentages in Settings → Household &amp; entity to see distributive shares.
                </p>
              )}
              <p className="text-[11px] text-foreground-muted">
                {entityType === 's_corp'
                  ? 'S-Corps file Form 1120-S; income passes through to shareholders via Schedule K-1 and is taxed on their personal returns. Officer wages must be reasonable compensation and are already reflected in mapped W-2/withholding categories.'
                  : 'Partnerships file Form 1065; income passes through to partners via Schedule K-1 and is taxed on their personal returns (including self-employment tax for general partners).'}
              </p>
            </>
          )}
          {entityType === 'nonprofit_501c3' && (
            <p className="text-[11px] text-foreground-muted">
              501(c)(3) organizations are generally exempt from federal income tax but must file Form 990
              (or 990-EZ/990-N). Unrelated business income (UBIT) is not modeled here.
            </p>
          )}
          <p className="text-[11px] text-foreground-muted mt-2">
            Revenue/expenses come from accounts mapped to income and business-expense tax categories —
            adjust mappings below if these totals look incomplete.
          </p>
        </Section>
      )}

      {/* Business books keep mapping access outside the personal-estimate block */}
      {hasMappings && estimate && !showPersonalEstimate && mappingsData && (
        <Section
          title="Account mapping"
          subtitle="Map book accounts to tax categories to drive the business summary above."
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

      {hasMappings && computed && estimate && showPersonalEstimate && (
        <>
          {/* (b) Summary cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label={`Projected ${year} liability`}
              value={formatCurrency(computed.totalLiability)}
              sub={`Federal ${formatCurrency(computed.federal.totalTax)} + ${computed.state.stateName} ${formatCurrency(computed.state.tax)}`}
            />
            <SummaryCard
              label={
                computed.payments.estimatedPayments + computed.payments.stateEstimatedPayments > 0.004
                  ? 'Taxes paid (projected)'
                  : 'Withheld (projected)'
              }
              value={formatCurrency(computed.totalWithheld)}
              sub={
                computed.payments.estimatedPayments + computed.payments.stateEstimatedPayments > 0.004
                  ? `Withheld ${formatCurrency(computed.payments.withholding + computed.payments.stateWithholding)} · Est. payments ${formatCurrency(computed.payments.estimatedPayments + computed.payments.stateEstimatedPayments)}`
                  : `Federal ${formatCurrency(computed.payments.withholding)} · State ${formatCurrency(computed.payments.stateWithholding)}`
              }
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

          {/* IRA limits & income phase-outs */}
          <Section
            title="IRA limits & income phase-outs"
            subtitle={`MAGI (before IRA deduction): ${formatCurrency(computed.phaseOuts.magi)} · based on your workplace-plan coverage settings`}
          >
            {computed.phaseOuts.nonDeductibleIra > 0.004 && (
              <div className="mb-3 bg-warning/10 border border-warning/30 rounded-md px-3 py-2 text-xs text-warning">
                Only {formatCurrency(computed.inputs.traditionalIraContributions ?? 0)} of your{' '}
                {formatCurrency((computed.inputs.traditionalIraContributions ?? 0) + computed.phaseOuts.nonDeductibleIra)}{' '}
                traditional IRA contributions are deductible at this income level. The remaining{' '}
                {formatCurrency(computed.phaseOuts.nonDeductibleIra)} would be a non-deductible (Form 8606) contribution.
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { label: 'You', data: computed.phaseOuts.self, limit: estimate.limits.ira },
                ...(computed.phaseOuts.spouse
                  ? [{ label: 'Spouse', data: computed.phaseOuts.spouse, limit: estimate.limits.spouseIra }]
                  : []),
              ].map(({ label, data, limit }) => (
                <div key={label} className="bg-surface border border-border rounded-lg p-4 space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-foreground">{label}</span>
                    {limit && (
                      <span className="text-xs text-foreground-muted font-mono">
                        IRA limit {formatCurrency(limit.total)}
                        {limit.catchUp > 0 && limit.total > limit.base ? ' incl. catch-up' : ''}
                      </span>
                    )}
                  </div>
                  {label === 'Spouse' && !limit && (
                    <p className="text-xs text-foreground-muted">
                      Set the spouse birthday in Tax settings to resolve the spouse&apos;s IRA limit and catch-up.
                    </p>
                  )}
                  {data.deduction && (
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-foreground-secondary">Traditional IRA deduction</span>
                      <span className={`font-mono ${
                        data.deduction.status === 'full' ? 'text-positive'
                          : data.deduction.status === 'partial' ? 'text-warning' : 'text-negative'
                      }`}>
                        {data.deduction.status === 'full'
                          ? 'Fully deductible'
                          : data.deduction.status === 'partial'
                            ? `Up to ${formatCurrency(data.deduction.deductibleLimit)}`
                            : 'Not deductible'}
                      </span>
                    </div>
                  )}
                  {data.deduction && data.deduction.phaseOutStart !== null && (
                    <p className="text-[11px] text-foreground-muted">
                      Deduction phases out {formatCurrency(data.deduction.phaseOutStart)} – {formatCurrency(data.deduction.phaseOutEnd ?? 0)} MAGI
                    </p>
                  )}
                  {data.roth && (
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-foreground-secondary">Roth IRA contribution</span>
                      <span className={`font-mono ${
                        data.roth.status === 'full' ? 'text-positive'
                          : data.roth.status === 'partial' ? 'text-warning' : 'text-negative'
                      }`}>
                        {data.roth.status === 'none' ? 'Ineligible' : `Up to ${formatCurrency(data.roth.deductibleLimit)}`}
                      </span>
                    </div>
                  )}
                  {data.roth && data.roth.phaseOutStart !== null && (
                    <p className="text-[11px] text-foreground-muted">
                      Roth eligibility phases out {formatCurrency(data.roth.phaseOutStart)} – {formatCurrency(data.roth.phaseOutEnd ?? 0)} MAGI
                    </p>
                  )}
                  <div className="flex items-baseline justify-between text-xs pt-1 border-t border-border/60">
                    <span className="text-foreground-secondary">Traditional contributions so far</span>
                    <span className="font-mono text-foreground">{formatCurrency(data.tradContrib)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

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
                {isMobile ? (
                  <div className="border-t border-border">
                    {estimate.bookData.categories.map(cat => {
                      const factor = annualize && isCurrentYear && ANNUALIZABLE.includes(cat.category)
                        ? 1 / estimate.bookData.elapsedYearFraction : 1;
                      return (
                        <CategoryCard
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
                        <CategoryCard
                          label="Realized short-term gains (lots)"
                          ytd={estimate.bookData.realizedGains.shortTerm}
                          used={estimate.bookData.realizedGains.shortTerm}
                          accounts={estimate.bookData.realizedGains.accounts.map(a => ({
                            accountGuid: a.accountGuid, accountName: a.accountName,
                            accountPath: a.accountPath, amount: a.shortTerm,
                          }))}
                        />
                        <CategoryCard
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
                  </div>
                ) : (
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
                )}
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
              {isMobile ? (
                <MobileCard
                  className="self-start border border-border rounded-md"
                  fields={computed.safeHarbor.quarterlySchedule.map(q => ({
                    label: `Q${q.quarter} · due ${q.dueDate}`,
                    value: (
                      <span
                        className={`font-mono text-xs ${q.amount > 0 ? 'text-foreground' : 'text-foreground-muted'}`}
                        style={{ fontFeatureSettings: "'tnum'" }}
                      >
                        {formatCurrency(q.amount)}
                      </span>
                    ),
                  }))}
                />
              ) : (
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
              )}
            </div>
          </Section>

          {/* (f) Contribution scenarios */}
          {scenarioLimits && (
            <CollapsibleConfigSection
              title="Contribution scenarios"
              summary={scenarios.length > 0
                ? `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} saved`
                : 'No scenarios yet'}
              configured={scenarios.length > 0}
              storageKey="taxEstimator.scenariosOpen"
            >
              <p className="text-xs text-foreground-muted mb-4">
                Model additional tax-advantaged contributions on top of your actuals. Each scenario is validated against remaining IRS limits.
              </p>
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
            </CollapsibleConfigSection>
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

/** Mobile card version of CategoryRow: same expand behavior, stacked account list */
function CategoryCard({ label, ytd, used, accounts }: {
  label: string;
  ytd: number;
  used: number;
  accounts: Array<{ accountGuid: string; accountName: string; accountPath: string; amount: number }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/50">
      <div
        onClick={() => setOpen(v => !v)}
        className="py-2.5 cursor-pointer active:bg-surface-hover"
      >
        <div className="flex items-center gap-1.5 text-sm text-foreground-secondary">
          <span className="text-foreground-muted text-xs">{open ? '▾' : '▸'}</span>
          <span>{label}</span>
        </div>
        <div className="mt-1.5 space-y-0.5 pl-4">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-foreground-muted uppercase tracking-wider">YTD</span>
            <span className="text-xs font-mono text-right text-foreground-secondary" style={{ fontFeatureSettings: "'tnum'" }}>
              {formatCurrency(ytd)}
            </span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-foreground-muted uppercase tracking-wider">Used</span>
            <span className="text-xs font-mono text-right text-foreground" style={{ fontFeatureSettings: "'tnum'" }}>
              {formatCurrency(used)}
            </span>
          </div>
        </div>
      </div>
      {open && (
        <div className="pb-2.5 pl-4 space-y-1">
          {accounts.map(a => (
            <div key={a.accountGuid} className="flex justify-between items-baseline gap-2">
              <Link
                href={`/accounts/${a.accountGuid}`}
                className="text-[11px] text-secondary hover:text-secondary-hover truncate"
                title={a.accountPath}
              >
                {a.accountPath}
              </Link>
              <span className="text-[11px] font-mono text-right text-foreground-muted shrink-0" style={{ fontFeatureSettings: "'tnum'" }}>
                {formatCurrency(a.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
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
