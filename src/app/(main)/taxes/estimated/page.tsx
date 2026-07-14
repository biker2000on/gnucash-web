'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { SUPPORTED_TAX_YEARS, isSupportedTaxYear, type TaxYear } from '@/lib/tax/types';
import type { QuarterStatus } from '@/lib/tax/estimated-quarters';

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

interface SafeHarborPayload {
  ninetyPercentCurrent: number;
  priorYearSafeHarbor: number | null;
  priorYearMultiplier: number | null;
  requiredAnnualPayment: number;
  withholding: number;
  estimatedPaymentsNeeded: number;
  underThousandDollarRule: boolean;
}

interface TrackerResponse {
  applicable: true;
  year: number;
  asOfDate: string;
  elapsedYearFraction: number;
  filingStatus: string;
  projected: {
    totalTax: number;
    agi: number;
    effectiveRate: number;
    selfEmploymentTax: number;
  };
  linkedBusinesses: Array<{ name: string | null; share: number; treatment: string }>;
  priorYear: { tax: number | null; agi: number | null; pinned: boolean };
  safeHarbor: SafeHarborPayload;
  withholding: { ytd: number; annualized: number };
  estimatedPayments: {
    totalYtd: number;
    list: Array<{ date: string; amount: number; description: string | null; quarter: number | null }>;
  };
  quarters: QuarterStatus[];
}

interface NotApplicableResponse {
  applicable: false;
  entityType: string;
}

function formatDue(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function QuarterCard({ q, today }: { q: QuarterStatus; today: string }) {
  const past = q.dueDate < today;
  const behind = q.shortfall > 0.005;
  const tone = behind
    ? past
      ? 'border-negative/40 bg-negative/5'
      : 'border-warning/40 bg-warning/5'
    : 'border-border bg-surface/30';
  return (
    <div className={`rounded-lg border p-4 space-y-2 ${tone}`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">Q{q.quarter}</h3>
        <span className={`text-xs ${past ? 'text-foreground-muted' : 'text-foreground-secondary'}`}>
          due {formatDue(q.dueDate)}
        </span>
      </div>
      <dl className="space-y-1 text-xs">
        <div className="flex justify-between">
          <dt className="text-foreground-secondary">Required (cumulative)</dt>
          <dd className="font-mono text-foreground" style={MONO}>{formatCurrency(q.requiredCumulative)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-foreground-secondary">Estimated paid this qtr</dt>
          <dd className="font-mono text-foreground" style={MONO}>{formatCurrency(q.estimatedPaid)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-foreground-secondary">Withholding credit</dt>
          <dd className="font-mono text-foreground-secondary" style={MONO}>{formatCurrency(q.withholdingCreditCumulative)}</dd>
        </div>
        <div className="flex justify-between border-t border-border/60 pt-1">
          <dt className="text-foreground-secondary">Total credited</dt>
          <dd className="font-mono text-foreground" style={MONO}>{formatCurrency(q.totalCreditedCumulative)}</dd>
        </div>
      </dl>
      {behind ? (
        <p className={`text-xs font-medium ${past ? 'text-negative' : 'text-warning'}`}>
          {past ? 'Shortfall' : 'On track to fall short by'}{' '}
          <span className="font-mono" style={MONO}>{formatCurrency(q.shortfall)}</span>
        </p>
      ) : (
        <p className="text-xs font-medium text-positive">
          Covered{q.surplus > 0.005 ? (
            <> — surplus <span className="font-mono" style={MONO}>{formatCurrency(q.surplus)}</span></>
          ) : null}
        </p>
      )}
    </div>
  );
}

export default function EstimatedTaxPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [priorYearTax, setPriorYearTax] = useState<number | null>(null);
  const [priorYearAgi, setPriorYearAgi] = useState<number | null>(null);
  const [data, setData] = useState<TrackerResponse | null>(null);
  const [notApplicable, setNotApplicable] = useState<NotApplicableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const seededRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ year: String(year) });
    if (priorYearTax !== null) params.set('priorYearTax', String(priorYearTax));
    if (priorYearAgi !== null) params.set('priorYearAgi', String(priorYearAgi));

    const timer = setTimeout(() => {
      fetch(`/api/tax/estimated?${params.toString()}`)
        .then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error ?? 'Failed to load estimated tax tracker');
          }
          return (await res.json()) as TrackerResponse | NotApplicableResponse;
        })
        .then(payload => {
          if (cancelled) return;
          if (!payload.applicable) {
            setNotApplicable(payload);
            return;
          }
          setData(payload);
          if (!seededRef.current) {
            seededRef.current = true;
            if (payload.priorYear.tax !== null) setPriorYearTax(payload.priorYear.tax);
            if (payload.priorYear.agi !== null) setPriorYearAgi(payload.priorYear.agi);
          }
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
  }, [year, priorYearTax, priorYearAgi]);

  const savePriorYear = useCallback(async () => {
    setSaveState('saving');
    try {
      const body: Record<string, number> = {};
      if (priorYearTax !== null) body.priorYearTax = priorYearTax;
      if (priorYearAgi !== null) body.priorYearAgi = priorYearAgi;
      const res = await fetch('/api/tax/estimated', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('save failed');
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }, [priorYearTax, priorYearAgi]);

  if (notApplicable) {
    const entityLabel = ENTITY_TYPE_LABELS[notApplicable.entityType] ?? notApplicable.entityType;
    return (
      <div className="space-y-6 max-w-[1100px]">
        <header>
          <h1 className="text-3xl font-bold text-foreground">Estimated Taxes</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Quarterly 1040-ES targets from safe harbor versus what you actually paid.
          </p>
        </header>
        <div className="rounded-lg border border-border bg-surface/30 p-6 space-y-3">
          <p className="text-sm text-foreground-secondary">
            The estimated tax tracker applies to household books (personal 1040 filers). This
            book is a {entityLabel}, so quarterly 1040-ES tracking doesn&apos;t apply here.
          </p>
          <Link
            href="/taxes/compliance"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary-hover transition-colors"
          >
            See this entity&apos;s compliance calendar instead
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </div>
    );
  }

  const sh = data?.safeHarbor ?? null;
  const totalShortfall = data
    ? data.quarters.reduce((max, q) => Math.max(max, q.dueDate <= data.asOfDate ? q.shortfall : 0), 0)
    : 0;

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Estimated Taxes</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Projects your full-year federal liability (linked business profit included), derives
            the safe-harbor payment target, and tracks each quarterly voucher against it.
          </p>
        </div>
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
      </header>

      {/* Prior-year inputs */}
      <div className="rounded-lg border border-border bg-surface/30 p-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Prior-year total tax ({year - 1} Form 1040 line 22)
            <input
              type="number"
              min={0}
              step={100}
              value={priorYearTax ?? ''}
              placeholder="not set"
              onChange={e =>
                setPriorYearTax(e.target.value === '' ? null : Math.max(0, parseFloat(e.target.value) || 0))
              }
              className="w-40 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Prior-year AGI ({year - 1} Form 1040 line 11)
            <input
              type="number"
              min={0}
              step={1000}
              value={priorYearAgi ?? ''}
              placeholder="not set"
              onChange={e =>
                setPriorYearAgi(e.target.value === '' ? null : Math.max(0, parseFloat(e.target.value) || 0))
              }
              className="w-40 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          <button
            onClick={savePriorYear}
            disabled={saveState === 'saving' || (priorYearTax === null && priorYearAgi === null)}
            className="ml-auto px-3 py-1.5 text-sm rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : saveState === 'error' ? 'Save failed' : 'Save prior-year figures'}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-foreground-muted">
          Without prior-year figures the target falls back to 90% of this year&apos;s projected
          tax — usually a higher bar than the prior-year safe harbor.
        </p>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center min-h-[200px] text-foreground-muted text-sm">
          Loading estimated tax tracker…
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-4 text-sm text-error">{error}</div>
      )}

      {data && sh && !error && (
        <>
          <StatGrid cols={4}>
            <StatCard
              label="Projected federal tax"
              value={formatCurrency(data.projected.totalTax)}
              sub={`annualized from ${Math.round(data.elapsedYearFraction * 100)}% of ${data.year}`}
            />
            <StatCard
              label="Safe-harbor target"
              value={formatCurrency(sh.requiredAnnualPayment)}
              sub={
                sh.priorYearSafeHarbor !== null && sh.requiredAnnualPayment === sh.priorYearSafeHarbor
                  ? `${Math.round((sh.priorYearMultiplier ?? 1) * 100)}% of prior-year tax`
                  : '90% of current-year tax'
              }
              tone="primary"
            />
            <StatCard
              label="Withholding YTD"
              value={formatCurrency(data.withholding.ytd)}
              sub={`${formatCurrency(data.withholding.annualized)} annualized`}
            />
            <StatCard
              label={totalShortfall > 0.005 ? 'Behind by' : 'Estimated paid YTD'}
              value={
                totalShortfall > 0.005
                  ? formatCurrency(totalShortfall)
                  : formatCurrency(data.estimatedPayments.totalYtd)
              }
              tone={totalShortfall > 0.005 ? 'negative' : 'positive'}
              sub={totalShortfall > 0.005 ? 'vs installments due so far' : 'all quarters covered so far'}
            />
          </StatGrid>

          {/* Quarter cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.quarters.map(q => (
              <QuarterCard key={q.period} q={q} today={data.asOfDate} />
            ))}
          </div>

          {data.linkedBusinesses.filter(b => b.treatment !== 'none').length > 0 && (
            <div className="rounded-lg border border-border bg-surface/30 p-4 text-xs text-foreground-secondary">
              Projection includes linked business profit:{' '}
              {data.linkedBusinesses
                .filter(b => b.treatment !== 'none')
                .map(b => `${b.name ?? 'business'} (${formatCurrency(b.share)})`)
                .join(', ')}
            </div>
          )}

          {/* Payment log */}
          {data.estimatedPayments.list.length > 0 && (
            <section className="rounded-lg border border-border bg-surface/30 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-secondary">
                1040-ES payments recorded
              </h2>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-foreground-muted">
                    <th className="py-1.5 pr-3 font-medium">Date</th>
                    <th className="py-1.5 pr-3 font-medium">Description</th>
                    <th className="py-1.5 pr-3 font-medium">Quarter</th>
                    <th className="py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.estimatedPayments.list.map((p, i) => (
                    <tr key={`${p.date}-${i}`} className="border-t border-border/60">
                      <td className="py-1.5 pr-3 font-mono text-xs text-foreground-secondary" style={MONO}>{p.date}</td>
                      <td className="py-1.5 pr-3 text-foreground-secondary">{p.description ?? '—'}</td>
                      <td className="py-1.5 pr-3 text-foreground-secondary">
                        {p.quarter ? `Q${p.quarter}` : 'prior year'}
                      </td>
                      <td className="py-1.5 text-right font-mono text-foreground" style={MONO}>
                        {formatCurrency(p.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Safe-harbor explainer */}
          <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-secondary">
              How the safe harbor works
            </h2>
            <p className="text-xs text-foreground-secondary max-w-[760px]">
              There is no underpayment penalty when your withholding plus timely estimated
              payments reach the SMALLER of (a) 90% of this year&apos;s tax or (b) 100% of last
              year&apos;s tax — <span className="text-foreground font-medium">110% of last
              year&apos;s tax if your prior-year AGI was above $150,000</span> ($75,000 married
              filing separately). Payments are due in four installments of 25% each; withholding
              counts as paid evenly through the year regardless of when it happens.
              {sh.underThousandDollarRule && (
                <span className="text-positive">
                  {' '}Your projected balance due after withholding is under $1,000, so no
                  estimated payments are required this year.
                </span>
              )}
            </p>
            <Link
              href="/taxes/compliance"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary-hover transition-colors"
            >
              See all deadlines on the compliance calendar
              <span aria-hidden>&rarr;</span>
            </Link>
          </section>
        </>
      )}
    </div>
  );
}
