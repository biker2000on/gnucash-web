'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { PersonalToolNotice } from '@/components/PersonalToolNotice';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { compareBunching, type BunchingComparison } from '@/lib/tax/bunching';
import {
  FILING_STATUS_LABELS,
  SUPPORTED_TAX_YEARS,
  isSupportedTaxYear,
  type FilingStatus,
  type TaxYear,
} from '@/lib/tax/types';

const MONO = { fontFeatureSettings: "'tnum'" } as const;
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

interface BunchingPayload {
  applicable: boolean;
  entityType: string;
  year: number;
  filingStatus: FilingStatus;
  giving: {
    detected: number;
    reportYtd: number;
    used: number;
    largeDonationCount: number;
  };
  otherItemizables: {
    saltAllowed: number;
    saltCap: number;
    mortgageInterest: number;
    total: number;
  };
  standardDeduction: number;
  marginalRate: number;
  projectedAgi: number;
  elapsedYearFraction: number;
  comparison: BunchingComparison;
}

export default function CharitableBunchingPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [data, setData] = useState<BunchingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // User-adjustable model inputs (seeded from the API payload)
  const [annualGiving, setAnnualGiving] = useState<number | null>(null);
  const [bunchYears, setBunchYears] = useState<2 | 3>(2);
  const [marginalOverride, setMarginalOverride] = useState<number | ''>('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tools/charitable-bunching?year=${year}`)
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? 'Failed to load bunching comparison');
        }
        return (await res.json()) as BunchingPayload;
      })
      .then(payload => {
        if (cancelled) return;
        setData(payload);
        setError(null);
        setAnnualGiving(prev => (prev === null ? payload.giving.detected : prev));
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [year]);

  const giving = annualGiving ?? data?.giving.detected ?? 0;
  const marginalRate =
    marginalOverride !== '' ? marginalOverride / 100 : data?.marginalRate ?? 0.22;

  const comparison = useMemo(() => {
    if (!data) return null;
    return compareBunching({
      annualGiving: giving,
      bunchYears,
      otherItemizable: data.otherItemizables.total,
      standardDeduction: data.standardDeduction,
      marginalRate,
    });
  }, [data, giving, bunchYears, marginalRate]);

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Charitable Bunching</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Stack {bunchYears} years of giving into one so it clears the standard deduction — same
          dollars donated, more deduction.
        </p>
      </header>

      <PersonalToolNotice />

      {loading && !data && (
        <div className="flex items-center justify-center min-h-[200px] text-foreground-muted text-sm">
          Loading giving data…
        </div>
      )}
      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-6 text-sm text-error">{error}</div>
      )}

      {data && comparison && (
        <>
          {/* Inputs */}
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
                Annual giving
                <input
                  type="number"
                  min={0}
                  step={500}
                  value={Math.round(giving)}
                  onChange={e => setAnnualGiving(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
                  style={MONO}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
                Bunch horizon
                <select
                  value={bunchYears}
                  onChange={e => setBunchYears(parseInt(e.target.value, 10) as 2 | 3)}
                  className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                >
                  <option value={2}>2 years</option>
                  <option value={3}>3 years</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
                Marginal rate override (%)
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  placeholder={(data.marginalRate * 100).toFixed(0)}
                  value={marginalOverride}
                  onChange={e =>
                    setMarginalOverride(e.target.value === '' ? '' : Math.max(0, parseFloat(e.target.value) || 0))
                  }
                  className="w-28 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
                  style={MONO}
                />
              </label>
            </div>
            <p className="mt-3 text-[11px] text-foreground-muted">
              Detected giving of {formatCurrency(data.giving.detected)} comes from your charitable
              expense accounts{data.elapsedYearFraction < 1 ? ' (annualized from year-to-date)' : ''}.
              Marginal rate {pct(data.marginalRate)} is from this book&apos;s projected {data.year} income
              ({FILING_STATUS_LABELS[data.filingStatus]}).
            </p>
          </div>

          {/* Headline */}
          <StatGrid cols={4}>
            <StatCard
              label={`Extra tax saved by bunching (${comparison.horizon} yrs)`}
              value={formatCurrency(comparison.extraTaxSavings)}
              tone={comparison.extraTaxSavings > 0 ? 'positive' : 'default'}
              sub={
                comparison.extraTaxSavings > 0
                  ? `${formatCurrency(comparison.extraDeductions)} extra deductions × ${pct(marginalRate)}`
                  : 'No advantage at these numbers'
              }
            />
            <StatCard
              label="Total giving (either way)"
              value={formatCurrency(comparison.totalGiving)}
              sub={`${formatCurrency(giving)} / year`}
            />
            <StatCard
              label="Standard deduction"
              value={formatCurrency(data.standardDeduction)}
              sub={FILING_STATUS_LABELS[data.filingStatus]}
            />
            <StatCard
              label="Other itemizables / yr"
              value={formatCurrency(data.otherItemizables.total)}
              sub={`SALT ${formatCurrency(data.otherItemizables.saltAllowed)} + mortgage ${formatCurrency(data.otherItemizables.mortgageInterest)}`}
            />
          </StatGrid>

          {/* Side-by-side yearly table */}
          <section className="rounded-lg border border-border bg-surface/30 overflow-hidden">
            <div className="p-4 border-b border-border">
              <h2 className="text-base font-semibold text-foreground">Strategy comparison</h2>
              <p className="text-xs text-foreground-muted mt-0.5">
                A: give {formatCurrency(giving)} every year. B: give{' '}
                {formatCurrency(giving * comparison.horizon)} in year 1 (directly or via a
                donor-advised fund), then nothing.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-wider text-foreground-muted">
                    <th className="px-4 py-2 text-left">Year</th>
                    <th className="px-4 py-2 text-right">A · giving</th>
                    <th className="px-4 py-2 text-right">A · deduction taken</th>
                    <th className="px-4 py-2 text-right">B · giving</th>
                    <th className="px-4 py-2 text-right">B · deduction taken</th>
                    <th className="px-4 py-2 text-right">B advantage</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.yearly.years.map((a, i) => {
                    const b = comparison.bunched.years[i];
                    const adv = b.deductionTaken - a.deductionTaken;
                    return (
                      <tr key={a.year} className="border-b border-border/60">
                        <td className="px-4 py-2 text-foreground-secondary">Year {a.year}</td>
                        <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                          {formatCurrency(a.giving)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                          {formatCurrency(a.deductionTaken)}
                          <span className="ml-1.5 text-[10px] uppercase text-foreground-muted">
                            {a.itemized ? 'itemized' : 'std'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                          {formatCurrency(b.giving)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                          {formatCurrency(b.deductionTaken)}
                          <span className="ml-1.5 text-[10px] uppercase text-foreground-muted">
                            {b.itemized ? 'itemized' : 'std'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono" style={MONO}>
                          {Math.abs(adv) < 0.005 ? (
                            <span className="text-foreground-muted">—</span>
                          ) : (
                            <span className={adv > 0 ? 'text-positive' : 'text-negative'}>
                              {adv > 0 ? '+' : ''}{formatCurrency(adv)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-surface font-semibold">
                    <td className="px-4 py-2 text-foreground">Total deductions</td>
                    <td className="px-4 py-2" />
                    <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                      {formatCurrency(comparison.yearly.totalDeductions)}
                    </td>
                    <td className="px-4 py-2" />
                    <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                      {formatCurrency(comparison.bunched.totalDeductions)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono" style={MONO}>
                      <span className={comparison.extraDeductions > 0 ? 'text-positive' : 'text-foreground-muted'}>
                        {comparison.extraDeductions > 0 ? '+' : ''}{formatCurrency(comparison.extraDeductions)}
                      </span>
                    </td>
                  </tr>
                  <tr className="font-semibold">
                    <td className="px-4 py-2 text-foreground">Tax saved vs all-standard</td>
                    <td className="px-4 py-2" />
                    <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                      {formatCurrency(comparison.yearly.taxSavingsVsStandard)}
                    </td>
                    <td className="px-4 py-2" />
                    <td className="px-4 py-2 text-right font-mono text-foreground" style={MONO}>
                      {formatCurrency(comparison.bunched.taxSavingsVsStandard)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono" style={MONO}>
                      <span className={comparison.extraTaxSavings > 0 ? 'text-positive' : 'text-foreground-muted'}>
                        {comparison.extraTaxSavings > 0 ? '+' : ''}{formatCurrency(comparison.extraTaxSavings)}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* DAF note */}
          <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-2">
            <h2 className="text-base font-semibold text-foreground">Donor-advised fund</h2>
            <p className="text-sm text-foreground-secondary">
              A donor-advised fund (DAF) makes bunching practical: contribute the bunched amount in
              year 1 and take the full deduction immediately, then grant to your charities on the
              same yearly schedule they&apos;re used to. The money can stay invested inside the DAF
              between grants. Appreciated stock is often better to contribute than cash — you deduct
              fair market value and never realize the capital gain.
            </p>
          </section>

          {/* Assumptions */}
          <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-2">
            <h2 className="text-base font-semibold text-foreground">Assumptions</h2>
            <ul className="text-sm text-foreground-secondary list-disc pl-5 space-y-1">
              <li>
                Constant marginal rate ({pct(marginalRate)}) — tax saved is estimated as extra
                deductions × marginal rate. Very large gifts can drop you into a lower bracket,
                which this model doesn&apos;t capture.
              </li>
              <li>
                Standard deduction ({formatCurrency(data.standardDeduction)}) and other itemizables
                ({formatCurrency(data.otherItemizables.total)}/yr) held constant across all{' '}
                {comparison.horizon} years — real values are inflation-indexed.
              </li>
              <li>
                SALT is capped at {formatCurrency(data.otherItemizables.saltCap)} for {data.year} at
                your projected AGI (OBBBA phase-down applied where relevant).
              </li>
              <li>
                AGI-based charitable limits (60% of AGI for cash, 30% for appreciated stock) are
                not modeled — very large bunches may need to carry deductions forward.
              </li>
              <li>Federal only; state itemization rules differ and are not modeled.</li>
              <li>Estimates only — not tax advice.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
