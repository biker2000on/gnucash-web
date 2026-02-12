'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface MortgageConfig {
  id: number;
  name: string;
  tool_type: string;
  account_guid: string | null;
  config: {
    interestRate?: number;
    originalAmount?: number;
    loanTermMonths?: number;
    startDate?: string;
    extraPayment?: number;
  };
  created_at: string;
  updated_at: string;
}

interface AmortizationRow {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  extra: number;
  balance: number;
}

/* ------------------------------------------------------------------ */
/* Mortgage math helpers                                                */
/* ------------------------------------------------------------------ */

function calcMonthlyPayment(principal: number, monthlyRate: number, totalMonths: number): number {
  if (principal <= 0 || totalMonths <= 0) return 0;
  if (monthlyRate === 0) return principal / totalMonths;
  return principal * (monthlyRate * Math.pow(1 + monthlyRate, totalMonths)) / (Math.pow(1 + monthlyRate, totalMonths) - 1);
}

function buildAmortizationSchedule(
  principal: number,
  monthlyRate: number,
  totalMonths: number,
  extraPayment: number,
): AmortizationRow[] {
  const basePayment = calcMonthlyPayment(principal, monthlyRate, totalMonths);
  if (basePayment <= 0 || principal <= 0) return [];

  const rows: AmortizationRow[] = [];
  let balance = principal;

  for (let month = 1; balance > 0; month++) {
    const interest = balance * monthlyRate;
    let principalPortion = basePayment - interest + extraPayment;

    // Final month adjustment
    if (principalPortion > balance) {
      principalPortion = balance;
    }

    const actualExtra = Math.min(extraPayment, Math.max(0, balance - (basePayment - interest)));
    const actualPrincipal = principalPortion - actualExtra;

    balance = Math.max(0, balance - principalPortion);

    rows.push({
      month,
      payment: actualPrincipal + interest + actualExtra,
      principal: actualPrincipal,
      interest,
      extra: actualExtra,
      balance,
    });

    // Safety: prevent runaway loops
    if (month > 1200) break;
  }

  return rows;
}

function totalInterestFromSchedule(schedule: AmortizationRow[]): number {
  return schedule.reduce((sum, r) => sum + r.interest, 0);
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

interface InputFieldProps {
  label: string;
  value: number | string;
  onChange: (val: string) => void;
  type?: 'number' | 'currency' | 'percent' | 'date' | 'text';
  suffix?: string;
  placeholder?: string;
  step?: number;
  min?: number;
  max?: number;
}

function InputField({ label, value, onChange, type = 'number', suffix, placeholder, step, min, max }: InputFieldProps) {
  const prefix = type === 'currency' ? '$' : undefined;
  const sfx = type === 'percent' ? '%' : suffix;
  const inputType = type === 'date' ? 'date' : type === 'text' ? 'text' : 'number';

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
          type={inputType}
          value={value}
          onChange={e => onChange(e.target.value)}
          step={step ?? (type === 'percent' ? 0.01 : type === 'currency' ? 100 : 1)}
          min={min}
          max={max}
          placeholder={placeholder}
          className={`w-full bg-input-bg border border-border rounded-lg py-2 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent ${
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

interface ResultCardProps {
  label: string;
  value: string;
  sublabel: string;
  color: 'cyan' | 'emerald' | 'purple' | 'amber' | 'rose';
}

function ResultCard({ label, value, sublabel, color }: ResultCardProps) {
  const gradients: Record<string, string> = {
    cyan: 'from-cyan-500/20 to-cyan-600/5',
    emerald: 'from-emerald-500/20 to-emerald-600/5',
    purple: 'from-purple-500/20 to-purple-600/5',
    amber: 'from-amber-500/20 to-amber-600/5',
    rose: 'from-rose-500/20 to-rose-600/5',
  };
  const accents: Record<string, string> = {
    cyan: 'text-cyan-400',
    emerald: 'text-emerald-400',
    purple: 'text-purple-400',
    amber: 'text-amber-400',
    rose: 'text-rose-400',
  };

  return (
    <div className={`bg-gradient-to-br ${gradients[color]} backdrop-blur-xl border border-border rounded-xl p-5`}>
      <p className="text-xs font-medium text-foreground-muted uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accents[color]}`}>{value}</p>
      <p className="text-xs text-foreground-muted mt-1">{sublabel}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Saved Mortgage Card                                                 */
/* ------------------------------------------------------------------ */

interface SavedCardProps {
  config: MortgageConfig;
  onLoad: (config: MortgageConfig) => void;
  onDelete: (id: number) => void;
  isDeleting: boolean;
}

function SavedMortgageCard({ config, onLoad, onDelete, isDeleting }: SavedCardProps) {
  return (
    <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4 flex items-center justify-between gap-4 hover:border-cyan-500/30 transition-colors">
      <button
        type="button"
        onClick={() => onLoad(config)}
        className="flex-1 text-left min-w-0"
      >
        <h3 className="text-sm font-semibold text-foreground truncate">{config.name}</h3>
        <div className="flex items-center gap-3 mt-1 text-xs text-foreground-muted">
          {config.config.originalAmount !== undefined && (
            <span>{fmt.format(config.config.originalAmount)}</span>
          )}
          {config.config.interestRate !== undefined && (
            <span>{config.config.interestRate}%</span>
          )}
          {config.config.loanTermMonths !== undefined && (
            <span>{Math.round(config.config.loanTermMonths / 12)}yr</span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onDelete(config.id)}
        disabled={isDeleting}
        className="shrink-0 p-1.5 text-foreground-muted hover:text-rose-400 transition-colors disabled:opacity-50"
        title="Delete saved mortgage"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main Page Component                                                 */
/* ------------------------------------------------------------------ */

export default function MortgageCalculatorPage() {
  // ---- Saved configs state ----
  const [savedConfigs, setSavedConfigs] = useState<MortgageConfig[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // ---- Form state ----
  const [name, setName] = useState('My Mortgage');
  const [accountGuid, setAccountGuid] = useState('');
  const [accountName, setAccountName] = useState('');
  const [originalAmount, setOriginalAmount] = useState('300000');
  const [interestRate, setInterestRate] = useState('6.5');
  const [loanTermPreset, setLoanTermPreset] = useState('30');
  const [customMonths, setCustomMonths] = useState('360');
  const [startDate, setStartDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [extraPayment, setExtraPayment] = useState('0');

  // ---- Account balance state ----
  const [accountBalance, setAccountBalance] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  // ---- Payoff mode ----
  const [payoffMode, setPayoffMode] = useState<'extra-to-date' | 'date-to-payment'>('extra-to-date');
  const [payoffExtraPayment, setPayoffExtraPayment] = useState('500');
  const [targetYear, setTargetYear] = useState(() => String(new Date().getFullYear() + 15));

  // ---- Derived values ----
  const loanTermMonths = loanTermPreset === 'custom' ? (parseInt(customMonths) || 0) : (parseInt(loanTermPreset) || 30) * 12;
  const principal = parseFloat(originalAmount) || 0;
  const annualRate = parseFloat(interestRate) || 0;
  const monthlyRate = annualRate / 100 / 12;
  const extra = parseFloat(extraPayment) || 0;

  /* ---------------------------------------------------------------- */
  /* Fetch saved configs on mount                                      */
  /* ---------------------------------------------------------------- */

  const fetchConfigs = useCallback(async () => {
    try {
      setLoadingConfigs(true);
      const res = await fetch('/api/tools/config?toolType=mortgage');
      if (res.ok) {
        const data = await res.json();
        setSavedConfigs(data);
      }
    } catch (err) {
      console.error('Failed to load saved mortgages:', err);
    } finally {
      setLoadingConfigs(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  /* ---------------------------------------------------------------- */
  /* Fetch account balance when accountGuid changes                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!accountGuid) {
      setAccountBalance(null);
      return;
    }

    let cancelled = false;
    async function fetchBalance() {
      setLoadingBalance(true);
      try {
        const res = await fetch(`/api/accounts/${accountGuid}/balance`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          // Liability balances are typically negative in GnuCash; show absolute value
          setAccountBalance(Math.abs(parseFloat(data.total_balance) || 0));
        }
      } catch (err) {
        console.error('Failed to fetch account balance:', err);
      } finally {
        if (!cancelled) setLoadingBalance(false);
      }
    }

    fetchBalance();
    return () => { cancelled = true; };
  }, [accountGuid]);

  /* ---------------------------------------------------------------- */
  /* Save / Update config                                              */
  /* ---------------------------------------------------------------- */

  const handleSave = async () => {
    if (!name.trim()) return;

    setSaveStatus('saving');
    try {
      const configPayload = {
        interestRate: annualRate,
        originalAmount: principal,
        loanTermMonths,
        startDate,
        extraPayment: extra,
      };

      let res: Response;
      if (editingId) {
        res = await fetch(`/api/tools/config/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            accountGuid: accountGuid || null,
            config: configPayload,
          }),
        });
      } else {
        res = await fetch('/api/tools/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolType: 'mortgage',
            name: name.trim(),
            accountGuid: accountGuid || null,
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
  /* Load config from saved card                                       */
  /* ---------------------------------------------------------------- */

  const handleLoadConfig = (config: MortgageConfig) => {
    setEditingId(config.id);
    setName(config.name);
    setAccountGuid(config.account_guid || '');

    const c = config.config;
    if (c.interestRate !== undefined) setInterestRate(String(c.interestRate));
    if (c.originalAmount !== undefined) setOriginalAmount(String(c.originalAmount));
    if (c.startDate) setStartDate(c.startDate);
    if (c.extraPayment !== undefined) setExtraPayment(String(c.extraPayment));

    if (c.loanTermMonths !== undefined) {
      const years = c.loanTermMonths / 12;
      if ([10, 15, 20, 25, 30].includes(years)) {
        setLoanTermPreset(String(years));
      } else {
        setLoanTermPreset('custom');
        setCustomMonths(String(c.loanTermMonths));
      }
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
  /* Calculator results (memoized)                                     */
  /* ---------------------------------------------------------------- */

  const calculations = useMemo(() => {
    const monthlyPayment = calcMonthlyPayment(principal, monthlyRate, loanTermMonths);
    const totalPaid = monthlyPayment * loanTermMonths;
    const totalInterest = totalPaid - principal;

    return {
      monthlyPayment,
      totalPaid,
      totalInterest,
    };
  }, [principal, monthlyRate, loanTermMonths]);

  /* ---------------------------------------------------------------- */
  /* Payoff: Mode 1 - Extra Payment -> Payoff Date                     */
  /* ---------------------------------------------------------------- */

  const payoffExtraCalc = useMemo(() => {
    const payoffExtra = parseFloat(payoffExtraPayment) || 0;

    const scheduleOriginal = buildAmortizationSchedule(principal, monthlyRate, loanTermMonths, 0);
    const scheduleAccelerated = buildAmortizationSchedule(principal, monthlyRate, loanTermMonths, payoffExtra);

    const originalMonths = scheduleOriginal.length;
    const newMonths = scheduleAccelerated.length;
    const monthsSaved = originalMonths - newMonths;

    const originalInterest = totalInterestFromSchedule(scheduleOriginal);
    const newInterest = totalInterestFromSchedule(scheduleAccelerated);
    const interestSaved = originalInterest - newInterest;

    // Compute payoff dates
    const start = startDate ? new Date(startDate + 'T00:00:00') : new Date();
    const originalPayoffDate = new Date(start);
    originalPayoffDate.setMonth(originalPayoffDate.getMonth() + originalMonths);
    const newPayoffDate = new Date(start);
    newPayoffDate.setMonth(newPayoffDate.getMonth() + newMonths);

    return {
      scheduleAccelerated,
      originalMonths,
      newMonths,
      monthsSaved,
      originalInterest,
      newInterest,
      interestSaved,
      originalPayoffDate,
      newPayoffDate,
    };
  }, [principal, monthlyRate, loanTermMonths, payoffExtraPayment, startDate]);

  /* ---------------------------------------------------------------- */
  /* Payoff: Mode 2 - Target Date -> Required Payment                  */
  /* ---------------------------------------------------------------- */

  const payoffTargetCalc = useMemo(() => {
    const start = startDate ? new Date(startDate + 'T00:00:00') : new Date();
    const targetDate = new Date(parseInt(targetYear) || (start.getFullYear() + 15), start.getMonth(), 1);
    const targetMonths = Math.round((targetDate.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.4375));

    if (targetMonths <= 0) {
      return { error: 'Target date must be in the future', requiredPayment: 0, requiredExtra: 0, interestSaved: 0, targetMonths: 0, targetDate };
    }

    let requiredPayment: number;
    if (monthlyRate === 0) {
      requiredPayment = principal / targetMonths;
    } else {
      requiredPayment = principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -targetMonths));
    }

    const basePayment = calculations.monthlyPayment;
    const requiredExtra = requiredPayment - basePayment;

    if (requiredExtra < 0) {
      return { error: null, noExtraNeeded: true, requiredPayment: basePayment, requiredExtra: 0, interestSaved: 0, targetMonths, targetDate };
    }

    const originalInterest = calculations.totalInterest;
    const acceleratedTotalPaid = requiredPayment * targetMonths;
    const acceleratedInterest = acceleratedTotalPaid - principal;
    const interestSaved = originalInterest - acceleratedInterest;

    return {
      error: null,
      noExtraNeeded: false,
      requiredPayment,
      requiredExtra,
      interestSaved,
      targetMonths,
      targetDate,
      originalPayoffMonths: loanTermMonths,
      originalInterest,
      acceleratedInterest,
      acceleratedTotalPaid,
    };
  }, [principal, monthlyRate, loanTermMonths, startDate, targetYear, calculations]);

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function formatMonthsToYearsMonths(months: number): string {
    const y = Math.floor(months / 12);
    const m = months % 12;
    if (y === 0) return `${m} month${m !== 1 ? 's' : ''}`;
    if (m === 0) return `${y} year${y !== 1 ? 's' : ''}`;
    return `${y} year${y !== 1 ? 's' : ''}, ${m} month${m !== 1 ? 's' : ''}`;
  }

  function formatDate(d: Date): string {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Mortgage Calculator</h1>
        <p className="text-foreground-muted mt-1">
          Calculate mortgage payments, track your loan, and estimate payoff with extra payments.
        </p>
      </header>

      {/* ============================================================ */}
      {/* Section 1: Saved Mortgages                                    */}
      {/* ============================================================ */}

      <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Saved Mortgages</h2>
        {loadingConfigs ? (
          <p className="text-sm text-foreground-muted">Loading saved configurations...</p>
        ) : savedConfigs.length === 0 ? (
          <p className="text-sm text-foreground-muted">
            No saved mortgages yet. Fill in the form below and save your first mortgage configuration.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {savedConfigs.map(config => (
              <SavedMortgageCard
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

      {/* ============================================================ */}
      {/* Section 2: Calculator Form                                    */}
      {/* ============================================================ */}

      <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">
            {editingId ? 'Edit Mortgage' : 'New Mortgage'}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setName('My Mortgage');
                setAccountGuid('');
                setAccountName('');
                setOriginalAmount('300000');
                setInterestRate('6.5');
                setLoanTermPreset('30');
                setStartDate(() => {
                  const now = new Date();
                  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
                });
                setExtraPayment('0');
              }}
              className="text-xs text-foreground-muted hover:text-cyan-400 transition-colors"
            >
              + New Mortgage
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
          <InputField
            label="Name"
            value={name}
            onChange={setName}
            type="text"
            placeholder="My Mortgage"
          />

          <div>
            <label className="block text-sm font-medium text-foreground-muted mb-1">Linked Account (Liability)</label>
            <AccountSelector
              accountTypes={['LIABILITY']}
              value={accountGuid}
              onChange={(guid, accName) => {
                setAccountGuid(guid);
                setAccountName(accName);
              }}
              placeholder="Select liability account..."
            />
          </div>

          <InputField
            label="Original Loan Amount"
            value={originalAmount}
            onChange={setOriginalAmount}
            type="currency"
          />

          <InputField
            label="Annual Interest Rate"
            value={interestRate}
            onChange={setInterestRate}
            type="percent"
            step={0.01}
          />

          <div>
            <label className="block text-sm font-medium text-foreground-muted mb-1">Loan Term</label>
            <select
              value={loanTermPreset}
              onChange={e => setLoanTermPreset(e.target.value)}
              className="w-full bg-input-bg border border-border rounded-lg py-2 pl-3 pr-8 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
            >
              <option value="10">10 years</option>
              <option value="15">15 years</option>
              <option value="20">20 years</option>
              <option value="25">25 years</option>
              <option value="30">30 years</option>
              <option value="custom">Custom (months)</option>
            </select>
          </div>

          {loanTermPreset === 'custom' && (
            <InputField
              label="Custom Term (months)"
              value={customMonths}
              onChange={setCustomMonths}
              type="number"
              suffix="mo"
              min={1}
              max={600}
            />
          )}

          <InputField
            label="Loan Start Date"
            value={startDate}
            onChange={setStartDate}
            type="date"
          />

          <InputField
            label="Monthly Extra Payment"
            value={extraPayment}
            onChange={setExtraPayment}
            type="currency"
          />
        </div>

        {/* Save button */}
        <div className="flex items-center gap-3 mt-6">
          <button
            type="button"
            onClick={handleSave}
            disabled={saveStatus === 'saving' || !name.trim()}
            className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saveStatus === 'saving' ? 'Saving...' : editingId ? 'Update' : 'Save'}
          </button>
          {saveStatus === 'saved' && (
            <span className="text-sm text-emerald-400">Saved successfully</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-sm text-rose-400">Failed to save</span>
          )}
        </div>
      </section>

      {/* ============================================================ */}
      {/* Calculator Output / Results                                   */}
      {/* ============================================================ */}

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <ResultCard
          label="Monthly Payment (P&I)"
          value={fmtFull.format(calculations.monthlyPayment)}
          sublabel={extra > 0 ? `+ ${fmtFull.format(extra)} extra = ${fmtFull.format(calculations.monthlyPayment + extra)}/mo` : 'Principal & Interest only'}
          color="cyan"
        />
        <ResultCard
          label="Total Interest"
          value={fmt.format(calculations.totalInterest)}
          sublabel={`Over ${formatMonthsToYearsMonths(loanTermMonths)}`}
          color="rose"
        />
        <ResultCard
          label="Total Amount Paid"
          value={fmt.format(calculations.totalPaid)}
          sublabel={`${fmt.format(principal)} principal + ${fmt.format(calculations.totalInterest)} interest`}
          color="purple"
        />
        {accountGuid ? (
          <ResultCard
            label="Current Balance"
            value={loadingBalance ? '...' : accountBalance !== null ? fmtFull.format(accountBalance) : 'N/A'}
            sublabel={
              loadingBalance
                ? 'Loading from account...'
                : accountBalance !== null
                  ? `${((accountBalance / principal) * 100).toFixed(1)}% of original remaining`
                  : accountName || 'Linked account'
            }
            color="amber"
          />
        ) : (
          <ResultCard
            label="Current Balance"
            value="No Account"
            sublabel="Link a liability account above to see balance"
            color="amber"
          />
        )}
      </section>

      {/* ============================================================ */}
      {/* Payoff Estimator (T10)                                        */}
      {/* ============================================================ */}

      <section id="payoff" className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Payoff Estimator</h2>

        {/* Mode toggle */}
        <div className="flex gap-1 bg-input-bg border border-border rounded-lg p-1 mb-6 max-w-md">
          <button
            type="button"
            onClick={() => setPayoffMode('extra-to-date')}
            className={`flex-1 text-sm py-2 px-3 rounded-md font-medium transition-colors ${
              payoffMode === 'extra-to-date'
                ? 'bg-cyan-600 text-white'
                : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            Extra Payment &rarr; Payoff Date
          </button>
          <button
            type="button"
            onClick={() => setPayoffMode('date-to-payment')}
            className={`flex-1 text-sm py-2 px-3 rounded-md font-medium transition-colors ${
              payoffMode === 'date-to-payment'
                ? 'bg-cyan-600 text-white'
                : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            Target Date &rarr; Required Payment
          </button>
        </div>

        {/* ---------------------------------------------------------- */}
        {/* Mode 1: Extra Payment -> Payoff Date                        */}
        {/* ---------------------------------------------------------- */}

        {payoffMode === 'extra-to-date' && (
          <div className="space-y-6">
            <div className="max-w-xs">
              <InputField
                label="Extra Monthly Payment"
                value={payoffExtraPayment}
                onChange={setPayoffExtraPayment}
                type="currency"
              />
            </div>

            {/* Results */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <ResultCard
                label="Original Payoff"
                value={formatDate(payoffExtraCalc.originalPayoffDate)}
                sublabel={formatMonthsToYearsMonths(payoffExtraCalc.originalMonths)}
                color="amber"
              />
              <ResultCard
                label="New Payoff"
                value={formatDate(payoffExtraCalc.newPayoffDate)}
                sublabel={formatMonthsToYearsMonths(payoffExtraCalc.newMonths)}
                color="emerald"
              />
              <ResultCard
                label="Time Saved"
                value={formatMonthsToYearsMonths(payoffExtraCalc.monthsSaved)}
                sublabel={`${payoffExtraCalc.monthsSaved} fewer payments`}
                color="cyan"
              />
              <ResultCard
                label="Interest Saved"
                value={fmt.format(payoffExtraCalc.interestSaved)}
                sublabel={`${fmtFull.format(payoffExtraCalc.newInterest)} vs ${fmtFull.format(payoffExtraCalc.originalInterest)}`}
                color="purple"
              />
            </div>

            {/* Amortization Table */}
            {payoffExtraCalc.scheduleAccelerated.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">Amortization Schedule</h3>
                <div className="border border-border rounded-xl overflow-hidden max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background-secondary z-10">
                      <tr className="text-foreground-muted text-xs uppercase tracking-wider">
                        <th className="text-left py-3 px-4 font-medium">Month</th>
                        <th className="text-right py-3 px-4 font-medium">Payment</th>
                        <th className="text-right py-3 px-4 font-medium">Principal</th>
                        <th className="text-right py-3 px-4 font-medium">Interest</th>
                        <th className="text-right py-3 px-4 font-medium">Extra</th>
                        <th className="text-right py-3 px-4 font-medium">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payoffExtraCalc.scheduleAccelerated.map((row, idx) => {
                        const isPayoffMonth = row.balance <= 0 || idx === payoffExtraCalc.scheduleAccelerated.length - 1;
                        return (
                          <tr
                            key={row.month}
                            className={`border-t border-border/50 ${
                              isPayoffMonth
                                ? 'bg-emerald-500/10 font-semibold'
                                : idx % 2 === 0
                                  ? 'bg-transparent'
                                  : 'bg-surface/20'
                            }`}
                          >
                            <td className="py-2 px-4 text-foreground">{row.month}</td>
                            <td className="py-2 px-4 text-right text-foreground">{fmtFull.format(row.payment)}</td>
                            <td className="py-2 px-4 text-right text-emerald-400">{fmtFull.format(row.principal)}</td>
                            <td className="py-2 px-4 text-right text-rose-400">{fmtFull.format(row.interest)}</td>
                            <td className="py-2 px-4 text-right text-cyan-400">{fmtFull.format(row.extra)}</td>
                            <td className="py-2 px-4 text-right text-foreground">{fmtFull.format(row.balance)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------- */}
        {/* Mode 2: Target Date -> Required Payment                     */}
        {/* ---------------------------------------------------------- */}

        {payoffMode === 'date-to-payment' && (
          <div className="space-y-6">
            <div className="max-w-xs">
              <InputField
                label="Target Payoff Year"
                value={targetYear}
                onChange={setTargetYear}
                type="number"
                placeholder={String(new Date().getFullYear() + 15)}
                min={new Date().getFullYear()}
                max={new Date().getFullYear() + 100}
              />
            </div>

            {payoffTargetCalc.error ? (
              <div className="flex items-center gap-3 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl">
                <svg className="w-5 h-5 text-rose-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span className="text-sm text-rose-400">{payoffTargetCalc.error}</span>
              </div>
            ) : payoffTargetCalc.noExtraNeeded ? (
              <div className="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
                <svg className="w-5 h-5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm text-emerald-400">
                  No extra payment needed! Your mortgage will already be paid off before {targetYear} with regular payments.
                </span>
              </div>
            ) : (
              <>
                {/* Results */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <ResultCard
                    label="Required Monthly Payment"
                    value={fmtFull.format(payoffTargetCalc.requiredPayment)}
                    sublabel={`Total payment including extra`}
                    color="cyan"
                  />
                  <ResultCard
                    label="Required Extra Payment"
                    value={fmtFull.format(payoffTargetCalc.requiredExtra)}
                    sublabel={`On top of ${fmtFull.format(calculations.monthlyPayment)} base payment`}
                    color="emerald"
                  />
                  <ResultCard
                    label="Interest Saved"
                    value={fmt.format(payoffTargetCalc.interestSaved)}
                    sublabel="Compared to original loan term"
                    color="purple"
                  />
                </div>

                {/* Comparison table */}
                <div className="border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-background-secondary">
                      <tr className="text-foreground-muted text-xs uppercase tracking-wider">
                        <th className="text-left py-3 px-4 font-medium"></th>
                        <th className="text-right py-3 px-4 font-medium">Original</th>
                        <th className="text-right py-3 px-4 font-medium">Accelerated</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-border/50">
                        <td className="py-3 px-4 text-foreground-muted font-medium">Monthly Payment</td>
                        <td className="py-3 px-4 text-right text-foreground">{fmtFull.format(calculations.monthlyPayment)}</td>
                        <td className="py-3 px-4 text-right text-cyan-400 font-semibold">{fmtFull.format(payoffTargetCalc.requiredPayment)}</td>
                      </tr>
                      <tr className="border-t border-border/50 bg-surface/20">
                        <td className="py-3 px-4 text-foreground-muted font-medium">Payoff Term</td>
                        <td className="py-3 px-4 text-right text-foreground">{formatMonthsToYearsMonths(loanTermMonths)}</td>
                        <td className="py-3 px-4 text-right text-emerald-400 font-semibold">{formatMonthsToYearsMonths(payoffTargetCalc.targetMonths)}</td>
                      </tr>
                      <tr className="border-t border-border/50">
                        <td className="py-3 px-4 text-foreground-muted font-medium">Total Interest</td>
                        <td className="py-3 px-4 text-right text-foreground">{fmt.format(payoffTargetCalc.originalInterest ?? 0)}</td>
                        <td className="py-3 px-4 text-right text-emerald-400 font-semibold">{fmt.format(payoffTargetCalc.acceleratedInterest ?? 0)}</td>
                      </tr>
                      <tr className="border-t border-border/50 bg-surface/20">
                        <td className="py-3 px-4 text-foreground-muted font-medium">Total Paid</td>
                        <td className="py-3 px-4 text-right text-foreground">{fmt.format(calculations.totalPaid)}</td>
                        <td className="py-3 px-4 text-right text-emerald-400 font-semibold">{fmt.format(payoffTargetCalc.acceleratedTotalPaid ?? 0)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
