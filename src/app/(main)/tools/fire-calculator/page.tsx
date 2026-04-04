'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { calculateTimeWeightedReturn } from '@/lib/investment-performance';
import type { PerformanceHistoryPoint, PerformanceCashFlowPoint } from '@/lib/investment-performance';

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface DataDrivenValue {
  computed: number | null;
  override: number | null;
}

type LoadingState = 'loading' | 'loaded' | 'error' | 'empty';

interface KPIData {
  netWorth: number;
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
  investmentValue: number;
}

interface FireConfig {
  id: number;
  name: string;
  tool_type: string;
  account_guid: string | null;
  config: {
    overrides?: Record<string, number | null>;
    currentAge?: number;
    targetRetirementAge?: number;
    safeWithdrawalRate?: number;
    inflationRate?: number;
    adjustForInflation?: boolean;
  };
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function effectiveValue(ddv: DataDrivenValue, fallback: number): number {
  if (ddv.override !== null) return ddv.override;
  if (ddv.computed !== null) return ddv.computed;
  return fallback;
}

function sourceLabel(ddv: DataDrivenValue): 'data' | 'override' | 'manual' {
  if (ddv.override !== null) return 'override';
  if (ddv.computed !== null) return 'data';
  return 'manual';
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
  const [inflationRate, setInflationRate] = useState(3);
  const [adjustForInflation, setAdjustForInflation] = useState(false);

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
          // Convert total return to annual: (1 + totalReturn)^(1/years) - 1
          const totalReturnDecimal = twr / 100;
          annualReturn = (Math.pow(1 + totalReturnDecimal, 1 / years) - 1) * 100;
        } else {
          annualReturn = twr;
        }

        // Store the computed TWR as informational, but don't use it as the default.
        // A single year's return is too volatile for long-term FIRE projections.
        // Default to 7% (historical real S&P 500 average); user can override.
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
        },
        currentAge,
        targetRetirementAge,
        safeWithdrawalRate,
        inflationRate,
        adjustForInflation,
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
    if (c.inflationRate !== undefined) setInflationRate(c.inflationRate);
    if (c.adjustForInflation !== undefined) setAdjustForInflation(c.adjustForInflation);

    if (c.overrides) {
      setCurrentSavingsDDV(prev => ({ ...prev, override: c.overrides?.currentSavings ?? null }));
      setAnnualSavingsDDV(prev => ({ ...prev, override: c.overrides?.annualSavings ?? null }));
      setAnnualExpensesDDV(prev => ({ ...prev, override: c.overrides?.annualExpenses ?? null }));
      setExpectedReturnDDV(prev => ({ ...prev, override: c.overrides?.expectedReturn ?? null }));
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
          setCurrentSavingsDDV(prev => ({ ...prev, override: val }));
          break;
        case 'annualSavings':
          setAnnualSavingsDDV(prev => ({ ...prev, override: val }));
          break;
        case 'annualExpenses':
          setAnnualExpensesDDV(prev => ({ ...prev, override: val }));
          break;
        case 'expectedReturn':
          setExpectedReturnDDV(prev => ({ ...prev, override: val }));
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
    }
  };

  /* ---------------------------------------------------------------- */
  /* Calculations                                                      */
  /* ---------------------------------------------------------------- */

  const calculations = useMemo(() => {
    const fiNumber = annualExpenses / (safeWithdrawalRate / 100);

    const rNominal = expectedReturn / 100;
    const r = adjustForInflation
      ? (1 + rNominal) / (1 + inflationRate / 100) - 1
      : rNominal;

    const P = currentSavings;
    const C = annualSavings;
    const FI = fiNumber;

    let yearsToFI: number;
    let yearsToFIDisplay: string;

    if (P >= FI) {
      yearsToFI = 0;
      yearsToFIDisplay = '0.0';
    } else if (r === 0) {
      if (C === 0) {
        yearsToFI = Infinity;
        yearsToFIDisplay = 'N/A';
      } else {
        yearsToFI = (FI - P) / C;
        yearsToFIDisplay = yearsToFI < 0 ? '0.0' : yearsToFI.toFixed(1);
        if (yearsToFI < 0) yearsToFI = 0;
      }
    } else {
      const numerator = FI * r + C;
      const denominator = P * r + C;

      if (denominator <= 0 || numerator <= 0 || numerator / denominator <= 0) {
        yearsToFI = NaN;
        yearsToFIDisplay = 'N/A';
      } else {
        yearsToFI = Math.log(numerator / denominator) / Math.log(1 + r);
        if (isNaN(yearsToFI) || !isFinite(yearsToFI)) {
          yearsToFIDisplay = 'N/A';
        } else if (yearsToFI < 0) {
          yearsToFI = 0;
          yearsToFIDisplay = '0.0';
        } else {
          yearsToFIDisplay = yearsToFI.toFixed(1);
        }
      }
    }

    const fiAge = isFinite(yearsToFI) && !isNaN(yearsToFI)
      ? currentAge + yearsToFI
      : NaN;

    const annualIncomeAtFI = fiNumber * (safeWithdrawalRate / 100);
    const monthlyIncomeAtFI = annualIncomeAtFI / 12;

    const progressPercent = fiNumber > 0
      ? Math.min((currentSavings / fiNumber) * 100, 100)
      : 0;

    return {
      fiNumber,
      yearsToFI,
      yearsToFIDisplay,
      fiAge,
      annualIncomeAtFI,
      monthlyIncomeAtFI,
      progressPercent,
      r,
    };
  }, [currentAge, currentSavings, annualSavings, annualExpenses, expectedReturn, safeWithdrawalRate, inflationRate, adjustForInflation]);

  /* ---------------------------------------------------------------- */
  /* Chart data                                                        */
  /* ---------------------------------------------------------------- */

  const chartData = useMemo(() => {
    const { yearsToFI, r } = calculations;
    const fiYears = isFinite(yearsToFI) && !isNaN(yearsToFI) ? Math.ceil(yearsToFI) : 40;
    const maxYears = Math.max(fiYears + 10, 40);

    const data: Array<{ year: number; portfolio: number; projected: number | null }> = [];
    for (let year = 0; year <= maxYears; year++) {
      let portfolio: number;
      if (r === 0) {
        portfolio = currentSavings + annualSavings * year;
      } else {
        const growthFactor = Math.pow(1 + r, year);
        portfolio = currentSavings * growthFactor + annualSavings * (growthFactor - 1) / r;
      }
      const value = Math.round(portfolio);
      // Split into "current trajectory" (solid) and "projected future" (dashed) at FI point
      if (year <= fiYears) {
        data.push({ year, portfolio: value, projected: null });
      } else {
        // Add a bridge point at the FI year boundary
        if (data.length > 0 && data[data.length - 1].projected === null) {
          data[data.length - 1].projected = data[data.length - 1].portfolio;
        }
        data.push({ year, portfolio: null as unknown as number, projected: value });
      }
    }
    return data;
  }, [currentSavings, annualSavings, calculations]);

  /* ---------------------------------------------------------------- */
  /* Overall loading state                                             */
  /* ---------------------------------------------------------------- */

  const isLoading = kpiState === 'loading' || investmentState === 'loading';
  const hasError = kpiState === 'error' && investmentState !== 'loaded';
  const isEmpty = kpiState === 'empty' && investmentState === 'empty';

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-foreground">FIRE Calculator</h1>
        <p className="text-foreground-muted mt-1">
          Calculate your Financial Independence number and estimate years to retirement.
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
        <section className="bg-surface/30 backdrop-blur-xl border border-rose-500/30 rounded-xl p-6">
          <div className="flex items-center gap-3 text-rose-400 mb-4">
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-medium">Couldn&apos;t load your financial data.</span>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleRetry}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm rounded-lg transition-colors"
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

      {/* Primary: FI Dashboard Cards */}
      {!isLoading && (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <ResultCard
            label="Net Worth"
            value={fmt.format(currentSavings)}
            sublabel={sourceLabel(currentSavingsDDV) === 'data' ? 'Current portfolio value' : 'Manual entry'}
            color="primary"
          />
          <ResultCard
            label="FI Number"
            value={fmt.format(calculations.fiNumber)}
            sublabel="Target portfolio size"
            color="emerald"
          />
          <ResultCard
            label="Years to FI"
            value={calculations.yearsToFIDisplay}
            sublabel={
              !isNaN(calculations.fiAge) && isFinite(calculations.fiAge)
                ? `Reaching FI at age ${calculations.fiAge.toFixed(1)}`
                : 'Adjust inputs to calculate'
            }
            color="purple"
            progress={calculations.progressPercent}
          />
          <ResultCard
            label="Annual Income at FI"
            value={fmt.format(calculations.annualIncomeAtFI)}
            sublabel={`${fmtFull.format(calculations.monthlyIncomeAtFI)} / month`}
            color="amber"
          />
        </section>
      )}

      {/* Target Retirement Age Info */}
      {!isLoading && !isNaN(calculations.yearsToFI) && isFinite(calculations.yearsToFI) && calculations.yearsToFI > 0 && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4">
          {currentAge + calculations.yearsToFI <= targetRetirementAge ? (
            <div className="flex items-center gap-3 text-primary">
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">
                You will reach FI <strong>{(targetRetirementAge - currentAge - calculations.yearsToFI).toFixed(1)} years before</strong> your target retirement age of {targetRetirementAge}.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-amber-400">
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-sm">
                At current rates, you will reach FI <strong>{(currentAge + calculations.yearsToFI - targetRetirementAge).toFixed(1)} years after</strong> your target retirement age of {targetRetirementAge}. Consider increasing savings or reducing expenses.
              </span>
            </div>
          )}
        </section>
      )}

      {/* Secondary: Projection Chart */}
      {!isLoading && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Portfolio Growth Projection</h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <defs>
                  <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="projectedGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="year"
                  stroke="var(--color-foreground-muted)"
                  tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                  label={{ value: 'Years', position: 'insideBottomRight', offset: -5, fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                />
                <YAxis
                  stroke="var(--color-foreground-muted)"
                  tick={{ fill: 'var(--color-foreground-muted)', fontSize: 12 }}
                  tickFormatter={(value: number) => {
                    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
                    if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
                    return `$${value}`;
                  }}
                />
                <Tooltip
                  formatter={(value: number | undefined, name?: string) => {
                    if (value === undefined || value === null) return ['', ''];
                    const label = name === 'projected' ? 'Projected' : 'Portfolio Value';
                    return [fmtFull.format(value), label];
                  }}
                  labelFormatter={(label) => `Year ${label}`}
                  contentStyle={{
                    backgroundColor: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '0.5rem',
                    color: 'var(--color-foreground)',
                  }}
                />
                <ReferenceLine
                  y={calculations.fiNumber}
                  stroke="#22d3ee"
                  strokeDasharray="8 4"
                  label={{
                    value: `FI: ${fmt.format(calculations.fiNumber)}`,
                    position: 'right',
                    fill: '#22d3ee',
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="portfolio"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#portfolioGradient)"
                  dot={false}
                  name="Portfolio Value"
                  connectNulls={false}
                />
                <Area
                  type="monotone"
                  dataKey="projected"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  fill="url(#projectedGradient)"
                  dot={false}
                  name="projected"
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-foreground-muted mt-3 text-center">
            Projection based on {adjustForInflation ? 'inflation-adjusted (real)' : 'nominal'} return of{' '}
            {(calculations.r * 100).toFixed(2)}% per year with constant annual contributions of {fmt.format(annualSavings)}.
          </p>
        </section>
      )}

      {/* Tertiary: Inputs Grid with Inline Override */}
      {!isLoading && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Parameters</h2>
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
                label="Expected Annual Return"
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
              {computedPortfolioReturn !== null && (
                <p className="mt-1 text-xs text-foreground-muted">
                  Your portfolio returned {computedPortfolioReturn.toFixed(1)}% over the last year.
                  Default is 7% (historical average).
                </p>
              )}
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
                    className="text-xs bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-white px-3 py-1 rounded-lg"
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
              onChange={setSafeWithdrawalRate}
              type="percent"
            />
            <InputField
              label="Expected Inflation Rate"
              value={inflationRate}
              onChange={setInflationRate}
              type="percent"
            />
            <div className="md:col-span-2 flex items-center gap-3 pt-2">
              <button
                type="button"
                role="switch"
                aria-checked={adjustForInflation}
                onClick={() => setAdjustForInflation(!adjustForInflation)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-transparent ${
                  adjustForInflation ? 'bg-primary' : 'bg-foreground-muted/30'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                    adjustForInflation ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
              <div>
                <span className="text-sm font-medium text-foreground">Adjust for Inflation</span>
                <p className="text-xs text-foreground-muted">
                  {adjustForInflation
                    ? `Using real return rate: ${(((1 + expectedReturn / 100) / (1 + inflationRate / 100) - 1) * 100).toFixed(2)}%`
                    : `Using nominal return rate: ${expectedReturn.toFixed(2)}%`}
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Save / Load Configurations */}
      {!isLoading && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Saved Configurations</h2>

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
              className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors whitespace-nowrap"
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
            <p className="text-xs text-rose-400 mb-4">Failed to save configuration. Please try again.</p>
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
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

interface InputFieldProps {
  label: string;
  value: number;
  onChange: (val: number) => void;
  type: 'number' | 'currency' | 'percent';
  suffix?: string;
}

function InputField({ label, value, onChange, type, suffix }: InputFieldProps) {
  const prefix = type === 'currency' ? '$' : undefined;
  const sfx = type === 'percent' ? '%' : suffix;

  return (
    <div>
      <label className="block text-sm font-medium text-foreground-muted mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          type="number"
          value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          step={type === 'percent' ? 0.1 : type === 'currency' ? 1000 : 1}
          className={`w-full bg-input-bg border border-border rounded-lg py-2 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent ${
            prefix ? 'pl-7 pr-3' : sfx ? 'pl-3 pr-10' : 'pl-3 pr-3'
          }${prefix && sfx ? ' pr-10' : ''}`}
        />
        {sfx && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
            {sfx}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data-driven input with inline override                              */
/* ------------------------------------------------------------------ */

interface DataDrivenInputFieldProps {
  label: string;
  field: string;
  ddv: DataDrivenValue;
  fallback: number;
  type: 'currency' | 'percent';
  editingField: string | null;
  editingValue: string;
  onStartEdit: (field: string, value: number) => void;
  onEditChange: (value: string) => void;
  onCommit: (field: string) => void;
  onReset: (field: string) => void;
}

function DataDrivenInputField({
  label,
  field,
  ddv,
  fallback,
  type,
  editingField,
  editingValue,
  onStartEdit,
  onEditChange,
  onCommit,
  onReset,
}: DataDrivenInputFieldProps) {
  const value = effectiveValue(ddv, fallback);
  const source = sourceLabel(ddv);
  const isEditing = editingField === field;
  const prefix = type === 'currency' ? '$' : undefined;
  const sfx = type === 'percent' ? '%' : undefined;

  const sourceText = source === 'data' ? '(from your data)' : source === 'override' ? '(override)' : '';

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label className="block text-sm font-medium text-foreground-muted">{label}</label>
        {sourceText && (
          <span className={`text-xs ${source === 'data' ? 'text-primary' : 'text-amber-400'}`}>
            {sourceText}
          </span>
        )}
        {source === 'override' && ddv.computed !== null && (
          <button
            type="button"
            onClick={() => onReset(field)}
            className="text-xs text-foreground-muted hover:text-rose-400 transition-colors"
            title="Reset to computed value"
          >
            x
          </button>
        )}
      </div>
      {isEditing ? (
        <div className="relative">
          {prefix && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
              {prefix}
            </span>
          )}
          <input
            type="number"
            value={editingValue}
            onChange={e => onEditChange(e.target.value)}
            onBlur={() => onCommit(field)}
            onKeyDown={e => { if (e.key === 'Enter') onCommit(field); if (e.key === 'Escape') onCommit(field); }}
            autoFocus
            step={type === 'percent' ? 0.1 : 1000}
            className={`w-full bg-input-bg border border-primary rounded-lg py-2 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent ${
              prefix ? 'pl-7 pr-3' : sfx ? 'pl-3 pr-10' : 'pl-3 pr-3'
            }${prefix && sfx ? ' pr-10' : ''}`}
          />
          {sfx && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
              {sfx}
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onStartEdit(field, value)}
          className="w-full text-left bg-input-bg border border-border rounded-lg py-2 px-3 text-foreground text-sm hover:border-primary/50 transition-colors group flex items-center justify-between"
        >
          <span>
            {type === 'currency' ? fmt.format(value) : `${value.toFixed(type === 'percent' ? 2 : 0)}%`}
          </span>
          <svg className="w-3.5 h-3.5 text-foreground-muted opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Result Card                                                         */
/* ------------------------------------------------------------------ */

interface ResultCardProps {
  label: string;
  value: string;
  sublabel: string;
  color: 'primary' | 'emerald' | 'purple' | 'amber';
  progress?: number;
}

function ResultCard({ label, value, sublabel, color, progress }: ResultCardProps) {
  const backgrounds: Record<string, string> = {
    primary: 'bg-primary/10',
    emerald: 'bg-primary/10',
    purple: 'bg-purple-500/10',
    amber: 'bg-amber-500/10',
  };
  const accents: Record<string, string> = {
    primary: 'text-primary',
    emerald: 'text-primary',
    purple: 'text-purple-400',
    amber: 'text-amber-400',
  };
  const bars: Record<string, string> = {
    primary: 'bg-primary',
    emerald: 'bg-primary',
    purple: 'bg-purple-500',
    amber: 'bg-amber-500',
  };

  return (
    <div className={`${backgrounds[color]} backdrop-blur-xl border border-border rounded-xl p-5`}>
      <p className="text-xs font-medium text-foreground-muted uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accents[color]}`}>{value}</p>
      <p className="text-xs text-foreground-muted mt-1">{sublabel}</p>
      {progress !== undefined && (
        <div className="mt-3 h-2 bg-foreground-muted/20 rounded-full overflow-hidden">
          <div
            className={`h-full ${bars[color]} rounded-full transition-all duration-500`}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Saved Config Card                                                   */
/* ------------------------------------------------------------------ */

interface SavedCardProps {
  config: FireConfig;
  onLoad: (config: FireConfig) => void;
  onDelete: (id: number) => void;
  isDeleting: boolean;
}

function SavedConfigCard({ config, onLoad, onDelete, isDeleting }: SavedCardProps) {
  return (
    <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4 flex items-center justify-between gap-4 hover:border-primary/30 transition-colors">
      <button
        type="button"
        onClick={() => onLoad(config)}
        className="flex-1 text-left min-w-0"
      >
        <h3 className="text-sm font-semibold text-foreground truncate">{config.name}</h3>
        <div className="flex items-center gap-3 mt-1 text-xs text-foreground-muted">
          {config.config.safeWithdrawalRate !== undefined && (
            <span>SWR: {config.config.safeWithdrawalRate}%</span>
          )}
          {config.config.currentAge !== undefined && (
            <span>Age: {config.config.currentAge}</span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onDelete(config.id)}
        disabled={isDeleting}
        className="shrink-0 p-1.5 text-foreground-muted hover:text-rose-400 transition-colors disabled:opacity-50"
        title="Delete saved configuration"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}
