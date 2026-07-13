'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { calculateTimeWeightedReturn } from '@/lib/investment-performance';
import type { PerformanceHistoryPoint, PerformanceCashFlowPoint } from '@/lib/investment-performance';
import {
  runMonteCarlo,
  successRateSensitivity,
  deterministicProjection,
  type MonteCarloInputs,
} from '@/lib/fire/monte-carlo';
import { meanStockReturn, meanBondReturn, meanInflation } from '@/lib/fire/historical-returns';
import { DEFAULT_ASSUMPTIONS, mergeAssumptions, type FireAssumptions } from '@/lib/fire/assumptions';
import {
  estimateSocialSecurityBenefit,
  type EarningsRecord,
  type SocialSecurityEstimate,
} from '@/lib/fire/social-security';
import {
  fmt,
  fmtPct,
  effectiveValue,
  InputField,
  DataDrivenInputField,
  ResultCard,
  SavedConfigCard,
  Toggle,
  type DataDrivenValue,
  type LoadingState,
  type KPIData,
  type FireConfig,
} from './shared';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import MonteCarloChart from './MonteCarloChart';
import AssumptionsPanel from './AssumptionsPanel';
import { FiAgeHistogram, SensitivityRow } from './FiInsights';
import { RelatedLinks } from '@/components/RelatedLinks';

/* ------------------------------------------------------------------ */
/* Debounce hook                                                       */
/* ------------------------------------------------------------------ */

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/* ------------------------------------------------------------------ */
/* Main Page Component                                                 */
/* ------------------------------------------------------------------ */

export default function FireCalculatorPage() {
  // ---- Data loading state ----
  const [kpiState, setKpiState] = useState<LoadingState>('loading');
  const [investmentState, setInvestmentState] = useState<LoadingState>('loading');

  // ---- Data-driven values ----
  const [currentSavingsDDV, setCurrentSavingsDDV] = useState<DataDrivenValue>({ computed: null, override: null });
  const [annualSavingsDDV, setAnnualSavingsDDV] = useState<DataDrivenValue>({ computed: null, override: null });
  const [annualExpensesDDV, setAnnualExpensesDDV] = useState<DataDrivenValue>({ computed: null, override: null });
  const [expectedReturnDDV, setExpectedReturnDDV] = useState<DataDrivenValue>({ computed: null, override: null });
  const [computedPortfolioReturn, setComputedPortfolioReturn] = useState<number | null>(null);

  // ---- Birthday-derived age ----
  const [birthday, setBirthday] = useState<string | null>(null);
  const [birthdayLoading, setBirthdayLoading] = useState(true);
  const [birthdayEditing, setBirthdayEditing] = useState(false);
  const [birthdayInput, setBirthdayInput] = useState('');
  const [birthdaySaving, setBirthdaySaving] = useState(false);

  // ---- Manual-only inputs ----
  const [currentAge, setCurrentAge] = useState(30);
  const [targetRetirementAge, setTargetRetirementAge] = useState(55);
  const [safeWithdrawalRate, setSafeWithdrawalRate] = useState(4);

  // ---- Social Security estimate from book earnings history ----
  const [ssaState, setSsaState] = useState<LoadingState>('loading');
  const [ssaData, setSsaData] = useState<{
    available: boolean;
    birthYear: number | null;
    earningsYears: EarningsRecord[];
    yearsWithEarnings: number;
    source: 'mappings' | 'heuristic' | null;
    assumedFutureEarnings: number | null;
  } | null>(null);
  const [ssBenefitOverride, setSsBenefitOverride] = useState<number | null>(null);

  // ---- Monte Carlo assumptions ----
  const [assumptions, setAssumptions] = useState<FireAssumptions>(DEFAULT_ASSUMPTIONS);
  const [showDeterministic, setShowDeterministic] = useState(false);
  const patchAssumptions = useCallback((patch: Partial<FireAssumptions>) => {
    setAssumptions(prev => ({ ...prev, ...patch }));
  }, []);

  // ---- Saved configs state ----
  const [savedConfigs, setSavedConfigs] = useState<FireConfig[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [configName, setConfigName] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // ---- Editing state for inline override ----
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  // ---- Effective values ----
  const currentSavings = effectiveValue(currentSavingsDDV, 0);
  const annualSavings = effectiveValue(annualSavingsDDV, 0);
  const annualExpenses = effectiveValue(annualExpensesDDV, 50000);
  const expectedReturn = effectiveValue(expectedReturnDDV, 7);

  /* ---------------------------------------------------------------- */
  /* Fetch birthday on mount                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    async function fetchBirthday() {
      try {
        const res = await fetch('/api/user/preferences?key=birthday');
        if (res.ok) {
          const data = await res.json();
          const prefs = data.preferences || {};
          if (prefs.birthday) {
            setBirthday(prefs.birthday);
            const ageYears = Math.floor(
              (Date.now() - new Date(prefs.birthday + 'T00:00:00').getTime()) /
              (365.25 * 24 * 60 * 60 * 1000)
            );
            if (ageYears > 0 && ageYears < 120) {
              setCurrentAge(ageYears);
            }
          }
        }
      } catch {
        // ignore — age stays at manual default
      } finally {
        setBirthdayLoading(false);
      }
    }
    fetchBirthday();
  }, []);

  const saveBirthday = async (dateStr: string) => {
    setBirthdaySaving(true);
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { birthday: dateStr } }),
      });
      if (res.ok) {
        setBirthday(dateStr);
        const ageYears = Math.floor(
          (Date.now() - new Date(dateStr + 'T00:00:00').getTime()) /
          (365.25 * 24 * 60 * 60 * 1000)
        );
        if (ageYears > 0 && ageYears < 120) {
          setCurrentAge(ageYears);
        }
        setBirthdayEditing(false);
      }
    } catch {
      // ignore
    } finally {
      setBirthdaySaving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Fetch KPI data on mount                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    async function fetchKPIs() {
      setKpiState('loading');
      try {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setFullYear(startDate.getFullYear() - 1);
        const startStr = startDate.toISOString().split('T')[0];
        const endStr = now.toISOString().split('T')[0];
        const qs = `?startDate=${startStr}&endDate=${endStr}`;

        const res = await fetch(`/api/dashboard/kpis${qs}`);
        if (!res.ok) throw new Error('KPI fetch failed');
        const data: KPIData = await res.json();
        if (cancelled) return;

        const hasData = data.netWorth !== 0 || data.totalIncome !== 0 || data.totalExpenses !== 0;
        if (!hasData) {
          setKpiState('empty');
          return;
        }

        // Net worth or investment value as current savings
        const savingsValue = data.investmentValue > 0 ? data.investmentValue : Math.max(data.netWorth, 0);
        setCurrentSavingsDDV(prev => ({ ...prev, computed: savingsValue }));

        // Annual savings = income - expenses
        const computedAnnualSavings = Math.max(data.totalIncome - data.totalExpenses, 0);
        setAnnualSavingsDDV(prev => ({ ...prev, computed: computedAnnualSavings }));

        // Annual expenses
        setAnnualExpensesDDV(prev => ({ ...prev, computed: data.totalExpenses }));

        setKpiState('loaded');
      } catch {
        if (!cancelled) setKpiState('error');
      }
    }
    fetchKPIs();
    return () => { cancelled = true; };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Fetch portfolio return on mount                                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    async function fetchPortfolioReturn() {
      setInvestmentState('loading');
      try {
        const res = await fetch('/api/investments/history?days=365');
        if (!res.ok) throw new Error('Investment history fetch failed');
        const data: { history: PerformanceHistoryPoint[]; cashFlows: PerformanceCashFlowPoint[] } = await res.json();
        if (cancelled) return;

        if (!data.history || data.history.length < 2) {
          setInvestmentState('empty');
          return;
        }

        const twr = calculateTimeWeightedReturn(data.history, data.cashFlows || []);

        // TWR is already a percentage for the period. Annualize if period != 1 year.
        const startDate = new Date(data.history[0].date);
        const endDate = new Date(data.history[data.history.length - 1].date);
        const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
        const years = daysDiff / 365.25;

        let annualReturn: number;
        if (years > 0 && years !== 1) {
          const totalReturnDecimal = twr / 100;
          annualReturn = (Math.pow(1 + totalReturnDecimal, 1 / years) - 1) * 100;
        } else {
          annualReturn = twr;
        }

        // Informational only: a single year's return is too volatile for
        // long-term FIRE projections. Default stays at 7%; user can override.
        if (Number.isFinite(annualReturn)) {
          setComputedPortfolioReturn(Math.round(annualReturn * 100) / 100);
        }

        setInvestmentState('loaded');
      } catch {
        if (!cancelled) setInvestmentState('empty');
      }
    }
    fetchPortfolioReturn();
    return () => { cancelled = true; };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Fetch Social Security earnings history on mount                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    async function fetchSsa() {
      setSsaState('loading');
      try {
        const res = await fetch('/api/fire/social-security');
        if (!res.ok) throw new Error('Social Security fetch failed');
        const data = await res.json();
        if (cancelled) return;
        setSsaData({
          available: !!data.available,
          birthYear: data.birthYear ?? null,
          earningsYears: data.earningsYears ?? [],
          yearsWithEarnings: data.yearsWithEarnings ?? 0,
          source: data.source ?? null,
          assumedFutureEarnings: data.assumedFutureEarnings ?? null,
        });
        setSsaState(data.available ? 'loaded' : 'empty');
      } catch {
        if (!cancelled) setSsaState('error');
      }
    }
    fetchSsa();
    return () => { cancelled = true; };
  }, []);

  // Recompute benefits per claiming age locally — the engine is pure, so
  // changing the claiming age never needs another round-trip.
  const ssaEstimates = useMemo<Record<number, SocialSecurityEstimate> | null>(() => {
    if (!ssaData?.available || ssaData.birthYear === null) return null;
    const map: Record<number, SocialSecurityEstimate> = {};
    for (let age = 62; age <= 70; age++) {
      map[age] = estimateSocialSecurityBenefit({
        earnings: ssaData.earningsYears,
        birthYear: ssaData.birthYear,
        claimingAge: age,
        projectFutureEarnings: true,
      });
    }
    return map;
  }, [ssaData]);

  const ssClaimingAge = Math.min(70, Math.max(62, Math.round(assumptions.socialSecurityStartAge)));
  const ssBenefitDDV: DataDrivenValue = {
    computed: ssaEstimates?.[ssClaimingAge]?.monthlyBenefit ?? null,
    override: ssBenefitOverride,
  };
  const ssMonthlyBenefit = effectiveValue(ssBenefitDDV, assumptions.socialSecurityMonthlyBenefit);

  /* ---------------------------------------------------------------- */
  /* Fetch saved configs on mount                                      */
  /* ---------------------------------------------------------------- */

  const fetchConfigs = useCallback(async () => {
    try {
      setLoadingConfigs(true);
      const res = await fetch('/api/tools/config?toolType=fire-calculator');
      if (res.ok) {
        const data = await res.json();
        setSavedConfigs(data);
      }
    } catch (err) {
      console.error('Failed to load saved FIRE configs:', err);
    } finally {
      setLoadingConfigs(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  /* ---------------------------------------------------------------- */
  /* Save / Update config                                              */
  /* ---------------------------------------------------------------- */

  const handleSave = async () => {
    if (!configName.trim()) return;
    setSaveStatus('saving');
    try {
      const configPayload = {
        overrides: {
          currentSavings: currentSavingsDDV.override,
          annualSavings: annualSavingsDDV.override,
          annualExpenses: annualExpensesDDV.override,
          expectedReturn: expectedReturnDDV.override,
          socialSecurityMonthlyBenefit: ssBenefitOverride,
        },
        currentAge,
        targetRetirementAge,
        safeWithdrawalRate,
        // Legacy fields kept for backward compatibility with older readers
        inflationRate: assumptions.fixedInflationPct,
        adjustForInflation: true,
        // v2: full Monte Carlo assumption set
        assumptions,
      };

      let res: Response;
      if (editingId) {
        res = await fetch(`/api/tools/config/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: configName.trim(),
            accountGuid: null,
            config: configPayload,
          }),
        });
      } else {
        res = await fetch('/api/tools/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolType: 'fire-calculator',
            name: configName.trim(),
            accountGuid: null,
            config: configPayload,
          }),
        });
      }

      if (res.ok) {
        setSaveStatus('saved');
        const saved = await res.json();
        setEditingId(saved.id);
        await fetchConfigs();
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
        setTimeout(() => setSaveStatus('idle'), 3000);
      }
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Load config                                                       */
  /* ---------------------------------------------------------------- */

  const handleLoadConfig = (config: FireConfig) => {
    setEditingId(config.id);
    setConfigName(config.name);

    const c = config.config;
    if (c.currentAge !== undefined) setCurrentAge(c.currentAge);
    if (c.targetRetirementAge !== undefined) setTargetRetirementAge(c.targetRetirementAge);
    if (c.safeWithdrawalRate !== undefined) setSafeWithdrawalRate(c.safeWithdrawalRate);

    // v2 assumptions (merged with defaults); legacy configs map inflationRate
    if (c.assumptions) {
      setAssumptions(mergeAssumptions(c.assumptions));
    } else {
      setAssumptions(mergeAssumptions(
        c.inflationRate !== undefined
          ? { inflationMode: 'fixed', fixedInflationPct: c.inflationRate }
          : undefined
      ));
    }

    if (c.overrides) {
      const nonNegative = (v: number | null | undefined) => (v == null ? null : Math.max(0, v));
      setCurrentSavingsDDV(prev => ({ ...prev, override: nonNegative(c.overrides?.currentSavings) }));
      setAnnualSavingsDDV(prev => ({ ...prev, override: nonNegative(c.overrides?.annualSavings) }));
      setAnnualExpensesDDV(prev => ({ ...prev, override: nonNegative(c.overrides?.annualExpenses) }));
      setExpectedReturnDDV(prev => ({ ...prev, override: c.overrides?.expectedReturn ?? null }));
      setSsBenefitOverride(c.overrides?.socialSecurityMonthlyBenefit ?? null);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Delete config                                                     */
  /* ---------------------------------------------------------------- */

  const handleDeleteConfig = async (id: number) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/tools/config/${id}`, { method: 'DELETE' });
      if (res.ok || res.status === 204) {
        setSavedConfigs(prev => prev.filter(c => c.id !== id));
        if (editingId === id) {
          setEditingId(null);
        }
      }
    } catch (err) {
      console.error('Failed to delete config:', err);
    } finally {
      setDeletingId(null);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Retry data loading                                                */
  /* ---------------------------------------------------------------- */

  const handleRetry = () => {
    window.location.reload();
  };

  const handleUseManual = () => {
    setKpiState('empty');
    setInvestmentState('empty');
  };

  /* ---------------------------------------------------------------- */
  /* Inline override helpers                                           */
  /* ---------------------------------------------------------------- */

  const startEditing = (field: string, value: number) => {
    setEditingField(field);
    setEditingValue(String(value));
  };

  const commitEdit = (field: string) => {
    const val = parseFloat(editingValue);
    if (!isNaN(val)) {
      switch (field) {
        case 'currentSavings':
          setCurrentSavingsDDV(prev => ({ ...prev, override: Math.max(0, val) }));
          break;
        case 'annualSavings':
          setAnnualSavingsDDV(prev => ({ ...prev, override: Math.max(0, val) }));
          break;
        case 'annualExpenses':
          setAnnualExpensesDDV(prev => ({ ...prev, override: Math.max(0, val) }));
          break;
        case 'expectedReturn':
          setExpectedReturnDDV(prev => ({ ...prev, override: val }));
          break;
        case 'socialSecurityMonthlyBenefit':
          setSsBenefitOverride(Math.max(0, val));
          break;
      }
    }
    setEditingField(null);
  };

  const resetOverride = (field: string) => {
    switch (field) {
      case 'currentSavings':
        setCurrentSavingsDDV(prev => ({ ...prev, override: null }));
        break;
      case 'annualSavings':
        setAnnualSavingsDDV(prev => ({ ...prev, override: null }));
        break;
      case 'annualExpenses':
        setAnnualExpensesDDV(prev => ({ ...prev, override: null }));
        break;
      case 'expectedReturn':
        setExpectedReturnDDV(prev => ({ ...prev, override: null }));
        break;
      case 'socialSecurityMonthlyBenefit':
        setSsBenefitOverride(null);
        break;
    }
  };

  /* ---------------------------------------------------------------- */
  /* Monte Carlo simulation (debounced)                                */
  /* ---------------------------------------------------------------- */

  const mcInputs = useMemo<MonteCarloInputs>(() => ({
    currentSavings,
    annualContribution: annualSavings,
    contributionGrowthPct: assumptions.contributionGrowthPct,
    annualExpenses,
    safeWithdrawalRate,
    currentAge,
    retirementAge: targetRetirementAge,
    endAge: assumptions.endAge,
    stockAllocationPct: assumptions.stockAllocationPct,
    glidePathRetirementStockPct: assumptions.glidePathEnabled ? assumptions.glidePathRetirementStockPct : null,
    returnMode: assumptions.returnMode,
    fixedReturnPct: expectedReturn,
    inflationMode: assumptions.inflationMode,
    fixedInflationPct: assumptions.fixedInflationPct,
    numSimulations: assumptions.numSimulations,
    seed: 12345,
    withdrawalStrategy: assumptions.withdrawalStrategy,
    retirementTaxRatePct: assumptions.retirementTaxRatePct,
    socialSecurity: assumptions.socialSecurityEnabled
      ? { startAge: assumptions.socialSecurityStartAge, annualBenefit: ssMonthlyBenefit * 12 }
      : null,
    healthcarePre65Annual: assumptions.healthcarePre65Annual,
  }), [
    currentSavings, annualSavings, annualExpenses, expectedReturn,
    safeWithdrawalRate, currentAge, targetRetirementAge, assumptions,
    ssMonthlyBenefit,
  ]);

  // Debounce by serialized inputs so rapid slider/typing changes coalesce.
  const liveKey = useMemo(() => JSON.stringify(mcInputs), [mcInputs]);
  const debouncedKey = useDebounced(liveKey, 250);
  // True from the moment any input changes until the simulation memos below
  // have recomputed with the new inputs — drives the inline indicator.
  const isRecalculating = liveKey !== debouncedKey;

  const mcResult = useMemo(() => {
    const inputs = JSON.parse(debouncedKey) as MonteCarloInputs;
    return runMonteCarlo(inputs);
  }, [debouncedKey]);

  const sensitivity = useMemo(() => {
    const inputs = JSON.parse(debouncedKey) as MonteCarloInputs;
    return successRateSensitivity(inputs, [-2, -1, 0, 1, 2]);
  }, [debouncedKey]);

  // Deterministic overlay: expected real return applied to the accumulation
  // phase only (no withdrawals), shown in today's dollars.
  const deterministicValues = useMemo(() => {
    const inputs = JSON.parse(debouncedKey) as MonteCarloInputs;
    const infl = inputs.inflationMode === 'fixed' ? (inputs.fixedInflationPct ?? 3) / 100 : meanInflation();
    let nominal: number;
    if (inputs.returnMode === 'fixed') {
      nominal = (inputs.fixedReturnPct ?? 7) / 100;
    } else {
      const w = inputs.stockAllocationPct / 100;
      nominal = w * meanStockReturn() + (1 - w) * meanBondReturn();
    }
    const realPct = ((1 + nominal) / (1 + infl) - 1) * 100;
    const accumYears = Math.max(0, (inputs.retirementAge ?? 65) - inputs.currentAge);
    return deterministicProjection({
      currentSavings: inputs.currentSavings,
      annualContribution: inputs.annualContribution,
      contributionGrowthPct: inputs.contributionGrowthPct,
      realReturnPct: realPct,
      years: accumYears,
    });
  }, [debouncedKey]);

  /* ---------------------------------------------------------------- */
  /* Derived headline metrics                                          */
  /* ---------------------------------------------------------------- */

  const progressPercent = mcResult.fiNumber > 0 && Number.isFinite(mcResult.fiNumber)
    ? Math.min((currentSavings / mcResult.fiNumber) * 100, 100)
    : 0;

  const medianYearsToFi = mcResult.medianFiAge !== null ? mcResult.medianFiAge - currentAge : null;
  const yearsToFiRange = mcResult.fiAgeP10 !== null && mcResult.fiAgeP90 !== null
    ? `${Math.max(0, mcResult.fiAgeP10 - currentAge)}–${Math.max(0, mcResult.fiAgeP90 - currentAge)} yrs (10th–90th pct)`
    : 'wide uncertainty';

  const annualIncomeAtFI = mcResult.fiNumber * (safeWithdrawalRate / 100);

  /* ---------------------------------------------------------------- */
  /* Overall loading state                                             */
  /* ---------------------------------------------------------------- */

  const isLoading = kpiState === 'loading' || investmentState === 'loading';
  const hasError = kpiState === 'error' && investmentState !== 'loaded';
  const isEmpty = kpiState === 'empty' && investmentState === 'empty';

  // Subtle dimming while results are stale (per DESIGN.md: 150ms, ease-out)
  const recalcDim = `transition-opacity duration-150 ease-out ${isRecalculating ? 'opacity-60' : 'opacity-100'}`;

  // One-line summaries shown when the config sections are collapsed
  const parametersSummary = `Age ${currentAge} → ${targetRetirementAge} · ${safeWithdrawalRate}% SWR · $${Math.round(annualExpenses / 1000)}k/yr expenses`;
  const assumptionsSummary = `${
    assumptions.returnMode === 'historical'
      ? `Monte Carlo · ${assumptions.numSimulations.toLocaleString()} runs · ${assumptions.stockAllocationPct}/${100 - assumptions.stockAllocationPct} stocks/bonds`
      : `Fixed ${expectedReturn}% return`
  } · ${assumptions.inflationMode === 'historical' ? 'historical inflation' : `${assumptions.fixedInflationPct}% inflation`} · to age ${assumptions.endAge}`;

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-foreground">FIRE Calculator</h1>
        <p className="text-foreground-muted mt-1">
          Monte Carlo financial independence projections using {assumptions.returnMode === 'historical' ? '97 years of market history (1928–2024)' : 'your fixed return assumption'}.
          All values in today&apos;s dollars.
        </p>
      </header>

      {/* Loading State */}
      {isLoading && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-8">
          <div className="flex items-center gap-4">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
            <div>
              <p className="text-foreground font-medium">Loading your financial data...</p>
              <p className="text-sm text-foreground-muted mt-1">Fetching KPIs and portfolio performance</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-foreground-muted/10 rounded-xl p-5 animate-pulse">
                <div className="h-3 bg-foreground-muted/20 rounded w-20 mb-3" />
                <div className="h-7 bg-foreground-muted/20 rounded w-28 mb-2" />
                <div className="h-3 bg-foreground-muted/20 rounded w-24" />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Error State */}
      {!isLoading && hasError && (
        <section className="bg-surface/30 backdrop-blur-xl border border-error/30 rounded-xl p-6">
          <div className="flex items-center gap-3 text-error mb-4">
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-medium">Couldn&apos;t load your financial data.</span>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleRetry}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm rounded-lg transition-colors"
            >
              Retry
            </button>
            <button
              onClick={handleUseManual}
              className="px-4 py-2 bg-surface border border-border hover:border-foreground-muted/50 text-foreground text-sm rounded-lg transition-colors"
            >
              Use Manual
            </button>
          </div>
        </section>
      )}

      {/* Empty State */}
      {!isLoading && isEmpty && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
          <div className="flex items-center gap-3 text-foreground-muted mb-2">
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm">No financial data found. Enter values manually to get started.</span>
          </div>
        </section>
      )}

      {/* Headline results */}
      {!isLoading && (
        <section className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 ${recalcDim}`}>
          <ResultCard
            label="FI Number"
            value={Number.isFinite(mcResult.fiNumber) ? fmt.format(mcResult.fiNumber) : '—'}
            sublabel={`${(100 / safeWithdrawalRate).toFixed(0)}x expenses at ${safeWithdrawalRate}% SWR · ${fmt.format(annualIncomeAtFI)}/yr income`}
            color="primary"
            progress={progressPercent}
          />
          <ResultCard
            label="Median FI Age"
            value={mcResult.medianFiAge !== null ? String(mcResult.medianFiAge) : '—'}
            sublabel={
              medianYearsToFi !== null
                ? `${medianYearsToFi} yrs to FI · range ${yearsToFiRange}`
                : mcResult.probNeverFi >= 0.5
                  ? 'Most scenarios never reach FI in horizon'
                  : 'Adjust inputs to estimate'
            }
            color="emerald"
          />
          <ResultCard
            label={`FI by Age ${targetRetirementAge}`}
            value={fmtPct(mcResult.probFiByRetirementAge)}
            sublabel={`Chance of hitting your FI number by your target retirement age`}
            color="purple"
          />
          <ResultCard
            label="Plan Success Rate"
            value={fmtPct(mcResult.successRate)}
            sublabel={`Retire at ${targetRetirementAge}, money lasts to ${assumptions.endAge} in ${mcResult.numSimulations.toLocaleString()} scenarios`}
            color="amber"
          />
        </section>
      )}

      {/* Target retirement readiness note */}
      {!isLoading && mcResult.medianFiAge !== null && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4">
          {mcResult.medianFiAge <= targetRetirementAge ? (
            <div className="flex items-center gap-3 text-primary">
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">
                In the median scenario you reach FI at age <strong>{mcResult.medianFiAge}</strong>,{' '}
                <strong>{targetRetirementAge - mcResult.medianFiAge} years before</strong> your target retirement age of {targetRetirementAge}.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-warning">
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-sm">
                In the median scenario FI arrives at age <strong>{mcResult.medianFiAge}</strong>,{' '}
                <strong>{mcResult.medianFiAge - targetRetirementAge} years after</strong> your target of {targetRetirementAge}.
                Consider increasing savings, reducing expenses, or retiring later.
              </span>
            </div>
          )}
        </section>
      )}

      {/* Monte Carlo projection chart */}
      {!isLoading && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-foreground">Portfolio Projection</h2>
                {isRecalculating && (
                  <span className="flex items-center gap-1.5 text-xs text-foreground-muted" role="status" aria-live="polite">
                    <span className="animate-spin h-3 w-3 border-2 border-primary border-t-transparent rounded-full" />
                    Recalculating…
                  </span>
                )}
              </div>
              <p className="text-xs text-foreground-muted mt-0.5">
                Real (inflation-adjusted) portfolio value across {mcResult.numSimulations.toLocaleString()} simulated futures
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-3 text-xs text-foreground-muted">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-primary/10 border border-primary/30" /> 10–90%
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-primary/25 border border-primary/40" /> 25–75%
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-4 h-0.5 bg-primary" /> Median
                </span>
              </div>
              <Toggle
                checked={showDeterministic}
                onChange={setShowDeterministic}
                label="Deterministic"
              />
            </div>
          </div>
          <div className={recalcDim}>
            <MonteCarloChart
              result={mcResult}
              deterministic={deterministicValues}
              retirementAge={targetRetirementAge}
              showDeterministic={showDeterministic}
            />
          </div>
          <p className="text-xs text-foreground-muted mt-3 text-center">
            {assumptions.returnMode === 'historical'
              ? `Each simulated year samples stock, bond, and inflation outcomes together from the same historical year (1928–2024) to preserve their correlation. Contributions of ${fmt.format(annualSavings)}/yr until age ${targetRetirementAge}, then withdrawals.`
              : `Fixed ${expectedReturn}% nominal return every year. Switch to Monte Carlo in Assumptions to see market uncertainty.`}
          </p>
        </section>
      )}

      {/* FI distribution + sensitivity */}
      {!isLoading && (
        <section className={`grid grid-cols-1 lg:grid-cols-2 gap-4 ${recalcDim}`}>
          <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-foreground mb-1">When Do You Reach FI?</h2>
            <p className="text-xs text-foreground-muted mb-4">
              Distribution of the age your portfolio first crosses the FI number
              {mcResult.probNeverFi > 0 && ` · ${fmtPct(mcResult.probNeverFi)} of runs never reach it`}
            </p>
            <FiAgeHistogram result={mcResult} />
          </div>
          <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-foreground mb-1">Retirement Age Sensitivity</h2>
            <p className="text-xs text-foreground-muted mb-4">
              Success rate (money lasts to {assumptions.endAge}) if you retire a little earlier or later
            </p>
            <SensitivityRow rows={sensitivity} retirementAge={targetRetirementAge} />
          </div>
        </section>
      )}

      {/* Parameters with inline override */}
      {!isLoading && (
        <CollapsibleConfigSection
          title="Parameters"
          summary={parametersSummary}
          configured={!isLoading}
          storageKey="fire.parametersOpen"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            <DataDrivenInputField
              label="Current Savings / Investments"
              field="currentSavings"
              ddv={currentSavingsDDV}
              fallback={0}
              type="currency"
              editingField={editingField}
              editingValue={editingValue}
              onStartEdit={startEditing}
              onEditChange={setEditingValue}
              onCommit={commitEdit}
              onReset={resetOverride}
            />
            <DataDrivenInputField
              label="Annual Savings Rate"
              field="annualSavings"
              ddv={annualSavingsDDV}
              fallback={0}
              type="currency"
              editingField={editingField}
              editingValue={editingValue}
              onStartEdit={startEditing}
              onEditChange={setEditingValue}
              onCommit={commitEdit}
              onReset={resetOverride}
            />
            <DataDrivenInputField
              label="Annual Expenses"
              field="annualExpenses"
              ddv={annualExpensesDDV}
              fallback={50000}
              type="currency"
              editingField={editingField}
              editingValue={editingValue}
              onStartEdit={startEditing}
              onEditChange={setEditingValue}
              onCommit={commitEdit}
              onReset={resetOverride}
            />
            <div>
              <DataDrivenInputField
                label={assumptions.returnMode === 'fixed' ? 'Expected Annual Return (used)' : 'Expected Annual Return (fixed-mode only)'}
                field="expectedReturn"
                ddv={expectedReturnDDV}
                fallback={7}
                type="percent"
                editingField={editingField}
                editingValue={editingValue}
                onStartEdit={startEditing}
                onEditChange={setEditingValue}
                onCommit={commitEdit}
                onReset={resetOverride}
              />
              <p className="mt-1 text-xs text-foreground-muted">
                {assumptions.returnMode === 'historical'
                  ? 'Monte Carlo mode samples historical returns; this rate only applies in fixed-rate mode (see Assumptions).'
                  : computedPortfolioReturn !== null
                    ? `Your portfolio returned ${computedPortfolioReturn.toFixed(1)}% over the last year. Default is 7%.`
                    : 'Default is 7% (historical average).'}
              </p>
            </div>
            <div>
              <InputField
                label="Current Age"
                value={currentAge}
                onChange={setCurrentAge}
                type="number"
                suffix="years"
              />
              {birthday && !birthdayLoading ? (
                <p className="mt-1 text-xs text-foreground-muted">
                  From your birthday ({birthday})
                </p>
              ) : !birthdayLoading && !birthdayEditing ? (
                <button
                  type="button"
                  onClick={() => { setBirthdayEditing(true); setBirthdayInput(''); }}
                  className="mt-1 text-xs text-primary hover:text-primary-hover"
                >
                  Set your birthday to auto-calculate age
                </button>
              ) : null}
              {birthdayEditing && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="date"
                    value={birthdayInput}
                    onChange={(e) => setBirthdayInput(e.target.value)}
                    className="bg-background-tertiary border border-border rounded-lg px-2 py-1 text-sm text-foreground focus:outline-none focus:border-primary/50"
                  />
                  <button
                    type="button"
                    onClick={() => birthdayInput && saveBirthday(birthdayInput)}
                    disabled={!birthdayInput || birthdaySaving}
                    className="text-xs bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground px-3 py-1 rounded-lg"
                  >
                    {birthdaySaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBirthdayEditing(false)}
                    className="text-xs text-foreground-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            <InputField
              label="Target Retirement Age"
              value={targetRetirementAge}
              onChange={setTargetRetirementAge}
              type="number"
              suffix="years"
            />
            <InputField
              label="Safe Withdrawal Rate"
              value={safeWithdrawalRate}
              onChange={v => setSafeWithdrawalRate(Math.max(0.1, v))}
              type="percent"
            />
          </div>
        </CollapsibleConfigSection>
      )}

      {/* Assumptions */}
      {!isLoading && (
        <CollapsibleConfigSection
          title="Assumptions"
          summary={assumptionsSummary}
          configured={!isLoading}
          storageKey="fire.assumptionsOpen"
        >
          <AssumptionsPanel
            assumptions={assumptions}
            onChange={patchAssumptions}
            fixedReturnPct={expectedReturn}
            ssa={{
              state: ssaState,
              estimates: ssaEstimates,
              yearsWithEarnings: ssaData?.yearsWithEarnings ?? 0,
              source: ssaData?.source ?? null,
              assumedFutureEarnings: ssaData?.assumedFutureEarnings ?? null,
              ddv: ssBenefitDDV,
            }}
            editingField={editingField}
            editingValue={editingValue}
            onStartEdit={startEditing}
            onEditChange={setEditingValue}
            onCommit={commitEdit}
            onReset={resetOverride}
          />
        </CollapsibleConfigSection>
      )}

      {/* Save / Load Configurations */}
      {!isLoading && (
        <CollapsibleConfigSection
          title="Saved Configurations"
          summary={savedConfigs.length > 0
            ? `${savedConfigs.length} saved configuration${savedConfigs.length === 1 ? '' : 's'}`
            : 'No saved configurations yet'}
          configured={savedConfigs.length > 0}
          storageKey="fire.savedConfigsOpen"
        >
          {/* Save form */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <input
              type="text"
              value={configName}
              onChange={e => setConfigName(e.target.value)}
              placeholder="Configuration name..."
              className="flex-1 bg-input-bg border border-border rounded-lg py-2 px-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            />
            <button
              onClick={handleSave}
              disabled={!configName.trim() || saveStatus === 'saving'}
              className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground text-sm rounded-lg transition-colors whitespace-nowrap"
            >
              {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : editingId ? 'Update' : 'Save'}
            </button>
            {editingId && (
              <button
                onClick={() => { setEditingId(null); setConfigName(''); }}
                className="px-4 py-2 bg-surface border border-border hover:border-foreground-muted/50 text-foreground text-sm rounded-lg transition-colors whitespace-nowrap"
              >
                New
              </button>
            )}
          </div>
          {saveStatus === 'error' && (
            <p className="text-xs text-error mb-4">Failed to save configuration. Please try again.</p>
          )}

          {/* Saved configs list */}
          {loadingConfigs ? (
            <p className="text-sm text-foreground-muted">Loading saved configurations...</p>
          ) : savedConfigs.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              No saved configurations yet. Name and save your current setup above.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {savedConfigs.map(config => (
                <SavedConfigCard
                  key={config.id}
                  config={config}
                  onLoad={handleLoadConfig}
                  onDelete={handleDeleteConfig}
                  isDeleting={deletingId === config.id}
                />
              ))}
            </div>
          )}
        </CollapsibleConfigSection>
      )}

      {/* Methodology footnote */}
      {!isLoading && (
        <p className="text-xs text-foreground-muted">
          Methodology: bootstrap Monte Carlo over annual S&amp;P 500 total returns, 10-year Treasury
          returns, and CPI inflation, 1928–2024 (NYU Stern / Damodaran dataset). Withdrawals are
          taken at the start of each retirement year{assumptions.retirementTaxRatePct > 0 ? `, grossed up for a ${assumptions.retirementTaxRatePct}% tax rate` : ''};
          contributions are invested at year end. Past performance does not guarantee future results.
        </p>
      )}
      <RelatedLinks ids={['tool-drawdown', 'tool-scenario', 'rpt-nw-attribution']} />
    </div>
  );
}
