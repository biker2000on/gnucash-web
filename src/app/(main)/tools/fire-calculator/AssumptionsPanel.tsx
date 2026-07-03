'use client';

/**
 * "Assumptions" panel body exposing every Monte Carlo model parameter.
 * Collapse/expand behavior is provided by the page wrapping this in
 * <CollapsibleConfigSection>.
 */

import { useState } from 'react';
import type { FireAssumptions } from '@/lib/fire/assumptions';
import type { SocialSecurityEstimate } from '@/lib/fire/social-security';
import {
  DataDrivenInputField,
  InputField,
  Segmented,
  Toggle,
  fmt,
  type DataDrivenValue,
  type LoadingState,
} from './shared';

export interface SsaPanelData {
  state: LoadingState;
  /** Benefit estimate per claiming age 62-70, or null when unavailable */
  estimates: Record<number, SocialSecurityEstimate> | null;
  yearsWithEarnings: number;
  source: 'mappings' | 'heuristic' | null;
  assumedFutureEarnings: number | null;
  /** Data-driven monthly benefit: computed estimate + manual override */
  ddv: DataDrivenValue;
}

interface AssumptionsPanelProps {
  assumptions: FireAssumptions;
  onChange: (patch: Partial<FireAssumptions>) => void;
  /** Fixed nominal return % shown for context when returnMode === 'fixed' */
  fixedReturnPct: number;
  /** Social Security estimate from the user's book earnings history */
  ssa: SsaPanelData;
  /** Inline-override editing plumbing shared with the page */
  editingField: string | null;
  editingValue: string;
  onStartEdit: (field: string, value: number) => void;
  onEditChange: (value: string) => void;
  onCommit: (field: string) => void;
  onReset: (field: string) => void;
}

const CLAIMING_AGES = [62, 63, 64, 65, 66, 67, 68, 69, 70] as const;

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

export default function AssumptionsPanel({
  assumptions,
  onChange,
  fixedReturnPct,
  ssa,
  editingField,
  editingValue,
  onStartEdit,
  onEditChange,
  onCommit,
  onReset,
}: AssumptionsPanelProps) {
  const [showSsaDetails, setShowSsaDetails] = useState(false);
  const a = assumptions;

  const claimingAge = Math.min(70, Math.max(62, Math.round(a.socialSecurityStartAge)));
  const currentEstimate = ssa.estimates?.[claimingAge] ?? null;

  return (
    <div className="space-y-6">
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
            <p className="text-xs text-foreground-secondary mt-1.5">
              Historical mode samples actual 1928–2024 annual returns, preserving stock/bond/inflation
              correlation; fixed mode applies a constant {fixedReturnPct}% nominal return every year
              (set under Parameters).
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
        <div className="space-y-4">
          <Toggle
            checked={a.socialSecurityEnabled}
            onChange={v => onChange({ socialSecurityEnabled: v })}
            label="Include Social Security"
            description="Benefits reduce required withdrawals once they start"
          />
          {a.socialSecurityEnabled && (
            <>
              {/* Claiming age selector with per-age benefit preview */}
              <div>
                <FieldLabel>Claiming Age</FieldLabel>
                <div
                  role="radiogroup"
                  aria-label="Social Security claiming age"
                  className="grid grid-cols-3 sm:grid-cols-9 gap-1.5"
                >
                  {CLAIMING_AGES.map(age => {
                    const est = ssa.estimates?.[age] ?? null;
                    const selected = claimingAge === age;
                    return (
                      <button
                        key={age}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => onChange({ socialSecurityStartAge: age })}
                        className={`rounded-lg border px-1 py-2 text-center transition-colors duration-150 ${
                          selected
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-border bg-background-tertiary text-foreground-muted hover:text-foreground hover:border-border-hover'
                        }`}
                      >
                        <span className="block text-sm font-semibold">{age}</span>
                        {est && (
                          <span
                            className="block text-[11px] font-mono mt-0.5"
                            style={{ fontFeatureSettings: "'tnum'" }}
                          >
                            {fmt.format(est.monthlyBenefit)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {ssa.estimates && currentEstimate && (
                  <p className="text-xs text-foreground-muted mt-1.5">
                    Estimated from your earnings history ({ssa.yearsWithEarnings}{' '}
                    {ssa.yearsWithEarnings === 1 ? 'year' : 'years'}):{' '}
                    <span className="text-foreground-secondary font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                      {fmt.format(currentEstimate.monthlyBenefit)}/mo
                    </span>{' '}
                    at age {claimingAge}
                    {ssa.source === 'heuristic' && ' (matched salary/payroll accounts)'}
                    {ssa.source === 'mappings' && ' (from your tax mappings)'}.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <div>
                  <DataDrivenInputField
                    label="Monthly Benefit (today's $)"
                    field="socialSecurityMonthlyBenefit"
                    ddv={ssa.ddv}
                    fallback={a.socialSecurityMonthlyBenefit}
                    type="currency"
                    editingField={editingField}
                    editingValue={editingValue}
                    onStartEdit={onStartEdit}
                    onEditChange={onEditChange}
                    onCommit={onCommit}
                    onReset={onReset}
                  />
                  {ssa.state === 'loading' && (
                    <p className="text-xs text-foreground-muted mt-1">
                      Estimating from your earnings history…
                    </p>
                  )}
                  {ssa.state !== 'loading' && !ssa.estimates && (
                    <p className="text-xs text-foreground-muted mt-1">
                      No usable earnings history found — enter your estimate from{' '}
                      <a
                        href="https://www.ssa.gov/myaccount/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:text-primary-hover"
                      >
                        ssa.gov
                      </a>{' '}
                      manually.
                    </p>
                  )}
                </div>
              </div>

              {/* Sparse-history caveat */}
              {ssa.estimates && ssa.yearsWithEarnings < 10 && (
                <p className="text-xs text-warning">
                  Your book only covers {ssa.yearsWithEarnings}{' '}
                  {ssa.yearsWithEarnings === 1 ? 'year' : 'years'} of earnings, so this
                  estimate misses most of your real earnings record. For a more accurate
                  number, enter the estimate from your{' '}
                  <a
                    href="https://www.ssa.gov/myaccount/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    SSA.gov statement
                  </a>{' '}
                  as a manual override.
                </p>
              )}

              {/* How this was computed */}
              {currentEstimate && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowSsaDetails(s => !s)}
                    aria-expanded={showSsaDetails}
                    className="flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors"
                  >
                    <svg
                      className={`w-3.5 h-3.5 transition-transform duration-150 ${showSsaDetails ? 'rotate-90' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    How this was computed
                  </button>
                  {showSsaDetails && (
                    <div className="mt-2 rounded-lg border border-border bg-background-tertiary p-4 text-xs text-foreground-muted space-y-1.5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                        <span>
                          Years with earnings:{' '}
                          <span className="text-foreground-secondary font-mono">
                            {currentEstimate.diagnostics.yearsWithEarnings}
                          </span>
                        </span>
                        <span>
                          Projected future years:{' '}
                          <span className="text-foreground-secondary font-mono">
                            {currentEstimate.diagnostics.projectedYears}
                          </span>
                          {ssa.assumedFutureEarnings !== null && currentEstimate.diagnostics.projectedYears > 0 && (
                            <> at {fmt.format(ssa.assumedFutureEarnings)}/yr</>
                          )}
                        </span>
                        <span>
                          Zero years in top 35:{' '}
                          <span className="text-foreground-secondary font-mono">
                            {currentEstimate.diagnostics.zeroYearsInTop35}
                          </span>
                        </span>
                        <span>
                          AIME:{' '}
                          <span className="text-foreground-secondary font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                            {fmt.format(currentEstimate.diagnostics.aime)}
                          </span>
                        </span>
                        <span>
                          PIA (today&apos;s $):{' '}
                          <span className="text-foreground-secondary font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                            ${currentEstimate.diagnostics.pia.toFixed(2)}/mo
                          </span>
                        </span>
                        <span>
                          Bend points:{' '}
                          <span className="text-foreground-secondary font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                            ${currentEstimate.diagnostics.bendPoints[0].toLocaleString()} / $
                            {currentEstimate.diagnostics.bendPoints[1].toLocaleString()}
                          </span>{' '}
                          ({currentEstimate.diagnostics.eligibilityYear})
                        </span>
                        <span>
                          Full retirement age:{' '}
                          <span className="text-foreground-secondary font-mono">
                            {currentEstimate.diagnostics.nraLabel}
                          </span>
                        </span>
                        <span>
                          Claiming at {claimingAge}:{' '}
                          <span className="text-foreground-secondary font-mono" style={{ fontFeatureSettings: "'tnum'" }}>
                            {(currentEstimate.diagnostics.claimingAdjustment * 100).toFixed(1)}% of PIA
                          </span>
                        </span>
                      </div>
                      <p className="pt-1 border-t border-border mt-2">
                        Earnings are capped at each year&apos;s taxable wage base, wage-indexed
                        through your age-60 year, and the top 35 years (zero-filled) average to
                        the AIME. The PIA applies 90/32/15% bend-point factors
                        {currentEstimate.diagnostics.usedEstimatedParams &&
                          '; future-year SSA parameters are held at today’s values so the result is in today’s dollars'}
                        . Assumes your latest year&apos;s earnings continue until claiming.
                      </p>
                    </div>
                  )}
                </div>
              )}
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
  );
}
