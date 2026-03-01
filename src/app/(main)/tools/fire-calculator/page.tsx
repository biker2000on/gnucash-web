'use client';

import { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function FireCalculatorPage() {
  const [currentAge, setCurrentAge] = useState(30);
  const [targetRetirementAge, setTargetRetirementAge] = useState(55);
  const [currentSavings, setCurrentSavings] = useState(0);
  const [annualSavings, setAnnualSavings] = useState(0);
  const [annualExpenses, setAnnualExpenses] = useState(50000);
  const [expectedReturn, setExpectedReturn] = useState(7);
  const [safeWithdrawalRate, setSafeWithdrawalRate] = useState(4);
  const [inflationRate, setInflationRate] = useState(3);
  const [adjustForInflation, setAdjustForInflation] = useState(false);

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

  const chartData = useMemo(() => {
    const { yearsToFI, r } = calculations;
    const maxYears = Math.max(
      isFinite(yearsToFI) && !isNaN(yearsToFI) ? Math.ceil(yearsToFI) + 10 : 40,
      40
    );

    const data: Array<{ year: number; portfolio: number }> = [];
    for (let year = 0; year <= maxYears; year++) {
      let portfolio: number;
      if (r === 0) {
        portfolio = currentSavings + annualSavings * year;
      } else {
        const growthFactor = Math.pow(1 + r, year);
        portfolio = currentSavings * growthFactor + annualSavings * (growthFactor - 1) / r;
      }
      data.push({ year, portfolio: Math.round(portfolio) });
    }
    return data;
  }, [currentSavings, annualSavings, calculations]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-foreground">FIRE Calculator</h1>
        <p className="text-foreground-muted mt-1">
          Calculate your Financial Independence number and estimate years to retirement.
        </p>
      </header>

      {/* Input Fields */}
      <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Parameters</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
          <InputField
            label="Current Age"
            value={currentAge}
            onChange={setCurrentAge}
            type="number"
            suffix="years"
          />
          <InputField
            label="Target Retirement Age"
            value={targetRetirementAge}
            onChange={setTargetRetirementAge}
            type="number"
            suffix="years"
          />
          <InputField
            label="Current Savings / Investments"
            value={currentSavings}
            onChange={setCurrentSavings}
            type="currency"
          />
          <InputField
            label="Annual Savings Rate"
            value={annualSavings}
            onChange={setAnnualSavings}
            type="currency"
          />
          <InputField
            label="Annual Expenses"
            value={annualExpenses}
            onChange={setAnnualExpenses}
            type="currency"
          />
          <InputField
            label="Expected Annual Return"
            value={expectedReturn}
            onChange={setExpectedReturn}
            type="percent"
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
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-transparent ${
                adjustForInflation ? 'bg-cyan-600' : 'bg-foreground-muted/30'
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
                  ? `Using real return rate: ${((1 + expectedReturn / 100) / (1 + inflationRate / 100) - 1) * 100 > 0 ? '' : ''}${(((1 + expectedReturn / 100) / (1 + inflationRate / 100) - 1) * 100).toFixed(2)}%`
                  : `Using nominal return rate: ${expectedReturn.toFixed(2)}%`}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Results Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <ResultCard
          label="FI Number"
          value={fmt.format(calculations.fiNumber)}
          sublabel="Target portfolio size"
          color="cyan"
        />
        <ResultCard
          label="Years to FI"
          value={calculations.yearsToFIDisplay}
          sublabel={
            !isNaN(calculations.fiAge) && isFinite(calculations.fiAge)
              ? `Reaching FI at age ${calculations.fiAge.toFixed(1)}`
              : 'Adjust inputs to calculate'
          }
          color="emerald"
        />
        <ResultCard
          label="Annual Income at FI"
          value={fmt.format(calculations.annualIncomeAtFI)}
          sublabel={`${fmtFull.format(calculations.monthlyIncomeAtFI)} / month`}
          color="purple"
        />
        <ResultCard
          label="FI Progress"
          value={`${calculations.progressPercent.toFixed(1)}%`}
          sublabel={`${fmt.format(currentSavings)} of ${fmt.format(calculations.fiNumber)}`}
          color="amber"
          progress={calculations.progressPercent}
        />
      </section>

      {/* Target Retirement Age Info */}
      {!isNaN(calculations.yearsToFI) && isFinite(calculations.yearsToFI) && calculations.yearsToFI > 0 && (
        <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-4">
          {currentAge + calculations.yearsToFI <= targetRetirementAge ? (
            <div className="flex items-center gap-3 text-emerald-400">
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

      {/* Projection Chart */}
      <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Portfolio Growth Projection</h2>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
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
                formatter={(value: number | undefined) => value !== undefined ? [fmtFull.format(value), 'Portfolio Value'] : ['', '']}
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
              <Line
                type="monotone"
                dataKey="portfolio"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                name="Portfolio Value"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-foreground-muted mt-3 text-center">
          Projection based on {adjustForInflation ? 'inflation-adjusted (real)' : 'nominal'} return of{' '}
          {(calculations.r * 100).toFixed(2)}% per year with constant annual contributions of {fmt.format(annualSavings)}.
        </p>
      </section>
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
  color: 'cyan' | 'emerald' | 'purple' | 'amber';
  progress?: number;
}

function ResultCard({ label, value, sublabel, color, progress }: ResultCardProps) {
  const gradients: Record<string, string> = {
    cyan: 'from-cyan-500/20 to-cyan-600/5',
    emerald: 'from-emerald-500/20 to-emerald-600/5',
    purple: 'from-purple-500/20 to-purple-600/5',
    amber: 'from-amber-500/20 to-amber-600/5',
  };
  const accents: Record<string, string> = {
    cyan: 'text-cyan-400',
    emerald: 'text-emerald-400',
    purple: 'text-purple-400',
    amber: 'text-amber-400',
  };
  const bars: Record<string, string> = {
    cyan: 'bg-cyan-500',
    emerald: 'bg-emerald-500',
    purple: 'bg-purple-500',
    amber: 'bg-amber-500',
  };

  return (
    <div className={`bg-gradient-to-br ${gradients[color]} backdrop-blur-xl border border-border rounded-xl p-5`}>
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
