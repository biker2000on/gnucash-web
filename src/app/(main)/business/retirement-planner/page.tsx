'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { SUPPORTED_TAX_YEARS, isSupportedTaxYear, type TaxYear } from '@/lib/tax/types';
import { StatCard, StatGrid } from '@/components/ui/StatCard';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

const ENTITY_TYPE_LABELS: Record<string, string> = {
  household: 'household',
  sole_prop: 'sole proprietorship',
  llc_single: 'single-member LLC',
  llc_partnership: 'partnership LLC',
  s_corp: 'S-Corp',
  c_corp: 'C-Corp',
  nonprofit_501c3: '501(c)(3) nonprofit',
};

interface PlanBuckets {
  type: 'solo_401k' | 'sep_ira';
  label: string;
  employeeDeferral: number;
  employeeDeferralLimit: number;
  employerMax: number;
  catchUp: number;
  combinedCap: number;
  total: number;
}

interface RetirementResponse {
  applicable: true;
  year: number;
  entityType: string;
  ytdNetProfit: number;
  annualizedProfit: number;
  elapsedYearFraction: number;
  ownershipPercent: number;
  ownerProfit: number;
  salary: number | null;
  compensation: number;
  birthday: string | null;
  catchUpEligible: boolean;
  overallCap: number;
  plans: PlanBuckets[];
  deadlines: {
    employeeDeferral: string;
    employerContribution: string;
    employerContributionExtended: string;
  };
  notes: string[];
}

interface NotApplicableResponse {
  applicable: false;
  entityType: string;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

export default function RetirementPlannerPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [salary, setSalary] = useState<number | ''>('');
  const [data, setData] = useState<RetirementResponse | null>(null);
  const [notApplicable, setNotApplicable] = useState<NotApplicableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ year: String(year) });
    if (salary !== '') params.set('salary', String(salary));

    const timer = setTimeout(() => {
      fetch(`/api/business/retirement-analysis?${params.toString()}`)
        .then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error ?? 'Failed to load retirement analysis');
          }
          return (await res.json()) as RetirementResponse | NotApplicableResponse;
        })
        .then(payload => {
          if (cancelled) return;
          if (!payload.applicable) {
            setNotApplicable(payload);
            return;
          }
          setData(payload);
        })
        .catch(err => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [year, salary]);

  if (notApplicable) {
    const entityLabel = ENTITY_TYPE_LABELS[notApplicable.entityType] ?? notApplicable.entityType;
    return (
      <div className="space-y-6 max-w-[1100px]">
        <header>
          <h1 className="text-3xl font-bold text-foreground">Self-Employed Retirement Planner</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            How much you can shelter in a Solo 401(k) or SEP-IRA at your current profit run rate.
          </p>
        </header>
        <div className="rounded-lg border border-border bg-surface/30 p-6 space-y-3">
          <p className="text-sm text-foreground-secondary">
            The retirement planner applies to pass-through business books (sole proprietorship,
            LLC, or S-corp). This book is a {entityLabel}, so self-employed retirement plans
            don&apos;t apply here.
          </p>
          <Link
            href="/business"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary-hover transition-colors"
          >
            Back to business dashboard
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </div>
    );
  }

  const solo = data?.plans.find(p => p.type === 'solo_401k') ?? null;
  const sep = data?.plans.find(p => p.type === 'sep_ira') ?? null;
  const isScorp = data?.entityType === 's_corp';

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Self-Employed Retirement Planner</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Contribution capacity for {year}: employee deferral, employer contribution, the
          §415(c) combined cap, and catch-up — Solo 401(k) versus SEP-IRA.
        </p>
      </header>

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
              {SUPPORTED_TAX_YEARS.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          {isScorp && (
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              W-2 salary
              <input
                type="number"
                min={0}
                step={1000}
                placeholder={data?.salary != null ? String(Math.round(data.salary)) : 'auto'}
                value={salary}
                onChange={e => setSalary(e.target.value === '' ? '' : Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
          )}
        </div>
        {isScorp && (
          <p className="mt-3 text-[11px] text-foreground-muted">
            Employer contributions are 25% of W-2 salary. Leave blank to use the salary pinned
            in the{' '}
            <Link href="/business/s-corp-analyzer" className="text-primary hover:text-primary-hover underline underline-offset-2">
              S-Corp Analyzer
            </Link>
            .
          </p>
        )}
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center min-h-[240px] text-foreground-muted text-sm">
          Loading retirement analysis…
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-6 text-sm text-error">{error}</div>
      )}

      {data && solo && sep && !error && (
        <>
          {/* Capacity cards */}
          <StatGrid cols={4}>
            <StatCard
              label="Employee deferral"
              value={formatCurrency(solo.employeeDeferral)}
              sub={`${year} 402(g) limit ${formatCurrency(solo.employeeDeferralLimit)}`}
            />
            <StatCard
              label="Employer contribution"
              value={formatCurrency(solo.employerMax)}
              sub={isScorp
                ? `25% of ${formatCurrency(data.salary ?? 0)} salary`
                : `~20% of ${formatCurrency(data.ownerProfit)} net profit`}
            />
            <StatCard
              label="Combined §415(c) cap"
              value={formatCurrency(data.overallCap)}
              sub={data.catchUpEligible ? `+ ${formatCurrency(solo.catchUp)} catch-up on top` : 'Before catch-up'}
            />
            <StatCard
              label="Total Solo 401(k) capacity"
              value={formatCurrency(solo.total)}
              tone="primary"
              sub={`vs SEP-IRA ${formatCurrency(sep.total)}`}
            />
          </StatGrid>

          {/* Comparison table */}
          <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">Solo 401(k) vs SEP-IRA</h2>
              <p className="text-xs text-foreground-muted mt-0.5">
                Based on {formatCurrency(data.annualizedProfit)} annualized net profit
                ({formatCurrency(data.ytdNetProfit)} YTD ÷ {data.elapsedYearFraction.toFixed(2)} of
                the year elapsed) at {data.ownershipPercent}% ownership.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-foreground-muted border-b border-border">
                    <th className="py-2 pr-4 font-medium">Bucket</th>
                    <th className="py-2 px-4 font-medium text-right">Solo 401(k)</th>
                    <th className="py-2 pl-4 font-medium text-right">SEP-IRA</th>
                  </tr>
                </thead>
                <tbody className="font-mono" style={MONO}>
                  <tr className="border-b border-border/60">
                    <td className="py-2 pr-4 font-sans text-foreground-secondary">Employee deferral</td>
                    <td className="py-2 px-4 text-right text-foreground">{formatCurrency(solo.employeeDeferral)}</td>
                    <td className="py-2 pl-4 text-right text-foreground-muted">—</td>
                  </tr>
                  <tr className="border-b border-border/60">
                    <td className="py-2 pr-4 font-sans text-foreground-secondary">Employer contribution</td>
                    <td className="py-2 px-4 text-right text-foreground">{formatCurrency(solo.employerMax)}</td>
                    <td className="py-2 pl-4 text-right text-foreground">{formatCurrency(sep.employerMax)}</td>
                  </tr>
                  <tr className="border-b border-border/60">
                    <td className="py-2 pr-4 font-sans text-foreground-secondary">Catch-up (50+)</td>
                    <td className="py-2 px-4 text-right text-foreground">
                      {data.catchUpEligible ? formatCurrency(solo.catchUp) : '—'}
                    </td>
                    <td className="py-2 pl-4 text-right text-foreground-muted">—</td>
                  </tr>
                  <tr className="border-b border-border/60">
                    <td className="py-2 pr-4 font-sans text-foreground-secondary">§415(c) combined cap</td>
                    <td className="py-2 px-4 text-right text-foreground">{formatCurrency(solo.combinedCap)}</td>
                    <td className="py-2 pl-4 text-right text-foreground">{formatCurrency(sep.combinedCap)}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-sans font-semibold text-foreground">Total capacity</td>
                    <td className="py-2 px-4 text-right font-semibold text-primary">{formatCurrency(solo.total)}</td>
                    <td className="py-2 pl-4 text-right font-semibold text-foreground">{formatCurrency(sep.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-foreground-muted">
              The Solo 401(k) usually wins at lower profit because of the employee deferral
              bucket; at high profit both converge on the §415(c) cap. SEP-IRA is simpler to
              administer but has no deferral or catch-up bucket.
            </p>
          </section>

          {/* Deadlines */}
          <section className="rounded-lg border border-secondary/30 bg-secondary-light p-5 space-y-2">
            <h2 className="text-base font-semibold text-foreground">Deadlines for {data.year}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-foreground-muted">Employee deferral</p>
                <p className="font-mono text-sm text-foreground mt-1" style={MONO}>
                  {formatDate(data.deadlines.employeeDeferral)}
                </p>
                <p className="text-[11px] text-foreground-muted mt-0.5">
                  {isScorp ? 'Must run through payroll by year end' : 'Election by year end'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-foreground-muted">Employer contribution</p>
                <p className="font-mono text-sm text-foreground mt-1" style={MONO}>
                  {formatDate(data.deadlines.employerContribution)}
                </p>
                <p className="text-[11px] text-foreground-muted mt-0.5">
                  {isScorp ? '1120-S filing deadline' : 'Personal filing deadline'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-foreground-muted">With extension</p>
                <p className="font-mono text-sm text-foreground mt-1" style={MONO}>
                  {formatDate(data.deadlines.employerContributionExtended)}
                </p>
                <p className="text-[11px] text-foreground-muted mt-0.5">Extended filing deadline</p>
              </div>
            </div>
          </section>

          {/* Notes */}
          <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-2">
            <h2 className="text-base font-semibold text-foreground">Notes</h2>
            <ul className="space-y-1.5 list-disc list-inside">
              {data.notes.map((n, i) => (
                <li key={i} className="text-xs text-foreground-secondary">{n}</li>
              ))}
            </ul>
            <p className="text-xs text-foreground-secondary">
              Record actual contributions in the household book and check progress against IRS
              limits in the{' '}
              <Link href="/reports/contribution_summary" className="text-primary hover:text-primary-hover underline underline-offset-2">
                Contribution Summary report
              </Link>
              .
            </p>
          </section>

          <p className="text-[11px] text-foreground-muted">
            Estimates only — not tax advice. Deferral capacity assumes no 401(k) deferrals at
            another employer (the 402(g) limit is per person across all plans).
          </p>
        </>
      )}
    </div>
  );
}
