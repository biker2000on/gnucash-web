'use client';

/**
 * Collapsible "Assumptions" panel exposing every Monte Carlo model parameter.
 */

import { useState } from 'react';
import type { FireAssumptions } from '@/lib/fire/assumptions';
import { InputField, Segmented, Toggle } from './shared';

interface AssumptionsPanelProps {
  assumptions: FireAssumptions;
  onChange: (patch: Partial<FireAssumptions>) => void;
  /** Fixed nominal return % shown for context when returnMode === 'fixed' */
  fixedReturnPct: number;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-sm font-medium text-foreground-muted mb-1">{children}</label>;
}

function AllocationSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <FieldLabel>{label}</FieldLabel>
        <span className="text-xs font-mono text-foreground-secondary" style={{ fontFeatureSettings: "'tnum'" }}>
          {value}% stocks / {100 - value}% bonds
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={e => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-[var(--color-primary,#2dd4bf)]"
        aria-label={label}
      />
    </div>
  );
}

export default function AssumptionsPanel({ assumptions, onChange, fixedReturnPct }: AssumptionsPanelProps) {
  const [open, setOpen] = useState(false);
  const a = assumptions;

  return (
    <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-6 py-4 text-left"
      >
        <div>
          <h2 className="text-lg font-semibold text-foreground">Assumptions</h2>
          <p className="text-xs text-foreground-muted mt-0.5">
            {a.returnMode === 'historical'
              ? `Monte Carlo: ${a.numSimulations.toLocaleString()} runs over 1928–2024 history, ${a.stockAllocationPct}/${100 - a.stockAllocationPct} stocks/bonds`
              : `Fixed ${fixedReturnPct}% nominal return`}
            {' · '}
            {a.inflationMode === 'historical' ? 'historical inflation' : `${a.fixedInflationPct}% inflation`}
            {' · '}to age {a.endAge}
          </p>
        </div>
        <svg
          className={`w-5 h-5 text-foreground-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-6 pb-6 border-t border-border pt-5 space-y-6">
          {/* Market model */}
          <div>
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
              Market Model
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <div>
                <FieldLabel>Expected Return Mode</FieldLabel>
                <Segmented
                  ariaLabel="Expected return mode"
                  options={[
                    { value: 'historical', label: 'Monte Carlo (historical)' },
                    { value: 'fixed', label: 'Fixed rate' },
                  ]}
                  value={a.returnMode}
                  onChange={v => onChange({ returnMode: v })}
                />
                <p className="text-xs text-foreground-muted mt-1.5">
                  {a.returnMode === 'historical'
                    ? 'Each simulated year samples real stock/bond/inflation data from 1928–2024, preserving their correlation.'
                    : `Every year returns exactly ${fixedReturnPct}% nominal (set under Parameters). No volatility — bands collapse to one line.`}
                </p>
              </div>
              <div>
                <FieldLabel>Inflation</FieldLabel>
                <div className="flex items-center gap-3">
                  <Segmented
                    ariaLabel="Inflation mode"
                    options={[
                      { value: 'historical', label: 'Historical' },
                      { value: 'fixed', label: 'Fixed' },
                    ]}
                    value={a.inflationMode}
                    onChange={v => onChange({ inflationMode: v })}
                  />
                  {a.inflationMode === 'fixed' && (
                    <div className="w-28">
                      <div className="relative">
                        <input
                          type="number"
                          value={a.fixedInflationPct}
                          step={0.1}
                          onChange={e => onChange({ fixedInflationPct: parseFloat(e.target.value) || 0 })}
                          className="w-full bg-input-bg border border-border rounded-lg py-1.5 pl-3 pr-8 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                          aria-label="Fixed inflation rate"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">%</span>
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-xs text-foreground-muted mt-1.5">
                  All results are shown in today&apos;s dollars (inflation-adjusted).
                </p>
              </div>
              <AllocationSlider
                label="Asset Allocation"
                value={a.stockAllocationPct}
                onChange={v => onChange({ stockAllocationPct: v })}
              />
              <div className="space-y-3">
                <Toggle
                  checked={a.glidePathEnabled}
                  onChange={v => onChange({ glidePathEnabled: v })}
                  label="Glide path"
                  description="Linearly shift allocation toward a retirement mix"
                />
                {a.glidePathEnabled && (
                  <AllocationSlider
                    label="Allocation at Retirement"
                    value={a.glidePathRetirementStockPct}
                    onChange={v => onChange({ glidePathRetirementStockPct: v })}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Retirement spending */}
          <div>
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
              Retirement Spending
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <div>
                <FieldLabel>Withdrawal Strategy</FieldLabel>
                <Segmented
                  ariaLabel="Withdrawal strategy"
                  options={[
                    { value: 'fixedReal', label: 'Fixed real (expenses)' },
                    { value: 'percentOfPortfolio', label: '% of portfolio' },
                  ]}
                  value={a.withdrawalStrategy}
                  onChange={v => onChange({ withdrawalStrategy: v })}
                />
                <p className="text-xs text-foreground-muted mt-1.5">
                  {a.withdrawalStrategy === 'fixedReal'
                    ? 'Withdraw your annual expenses every year, inflation-adjusted. Can deplete the portfolio.'
                    : 'Withdraw the SWR percentage of the current balance each year. Income varies but the portfolio never hits zero.'}
                </p>
              </div>
              <InputField
                label="Retirement Tax Rate"
                value={a.retirementTaxRatePct}
                onChange={v => onChange({ retirementTaxRatePct: Math.min(60, Math.max(0, v)) })}
                type="percent"
              />
              <InputField
                label="Healthcare Before 65 (extra / yr)"
                value={a.healthcarePre65Annual}
                onChange={v => onChange({ healthcarePre65Annual: Math.max(0, v) })}
                type="currency"
              />
            </div>
          </div>

          {/* Social Security */}
          <div>
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
              Social Security
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <Toggle
                checked={a.socialSecurityEnabled}
                onChange={v => onChange({ socialSecurityEnabled: v })}
                label="Include Social Security"
                description="Benefits reduce required withdrawals once they start"
              />
              {a.socialSecurityEnabled && (
                <>
                  <InputField
                    label="Benefit Start Age"
                    value={a.socialSecurityStartAge}
                    onChange={v => onChange({ socialSecurityStartAge: Math.min(75, Math.max(50, Math.round(v))) })}
                    type="number"
                    suffix="years"
                    step={1}
                    min={50}
                    max={75}
                  />
                  <InputField
                    label="Monthly Benefit (today's $)"
                    value={a.socialSecurityMonthlyBenefit}
                    onChange={v => onChange({ socialSecurityMonthlyBenefit: Math.max(0, v) })}
                    type="currency"
                    step={100}
                  />
                </>
              )}
            </div>
          </div>

          {/* Simulation */}
          <div>
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
              Simulation
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
              <InputField
                label="Contribution Growth"
                value={a.contributionGrowthPct}
                onChange={v => onChange({ contributionGrowthPct: v })}
                type="percent"
              />
              <InputField
                label="Plan To Age"
                value={a.endAge}
                onChange={v => onChange({ endAge: Math.min(110, Math.max(60, Math.round(v))) })}
                type="number"
                suffix="years"
                step={1}
                min={60}
                max={110}
              />
              <div>
                <FieldLabel>Simulations</FieldLabel>
                <select
                  value={a.numSimulations}
                  onChange={e => onChange({ numSimulations: parseInt(e.target.value, 10) })}
                  className="w-full bg-input-bg border border-border rounded-lg py-2 px-3 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  aria-label="Number of simulations"
                >
                  {[500, 1000, 2000, 5000].map(n => (
                    <option key={n} value={n}>{n.toLocaleString()} runs</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
