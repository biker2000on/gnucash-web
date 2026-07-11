'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import {
  FILING_STATUS_LABELS,
  FILING_STATUSES,
  SUPPORTED_TAX_YEARS,
  isSupportedTaxYear,
  type FilingStatus,
  type TaxYear,
} from '@/lib/tax/types';
import type { WithholdingCheckupPayload } from '@/lib/withholding';
import WithholdingHeadline from './WithholdingHeadline';
import { StatCard, StatGrid } from '@/components/ui/StatCard';

const MONO = { fontFeatureSettings: "'tnum'" } as const;
const PAY_FREQUENCIES: Array<{ value: number; label: string }> = [
  { value: 52, label: 'Weekly (52)' },
  { value: 26, label: 'Biweekly (26)' },
  { value: 24, label: 'Semi-monthly (24)' },
  { value: 12, label: 'Monthly (12)' },
];

function formatDueDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function MetricCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'positive' | 'negative' | 'neutral';
}) {
  return (
    <StatCard
      label={label}
      value={value}
      sub={sub}
      tone={tone === 'positive' ? 'positive' : tone === 'negative' ? 'negative' : 'default'}
    />
  );
}

export default function WithholdingCheckupPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [filingStatus, setFilingStatus] = useState<FilingStatus>('single');
  const [filersAge65Plus, setFilersAge65Plus] = useState(0);
  const [annualize, setAnnualize] = useState(true);
  const [priorYearTax, setPriorYearTax] = useState<number | ''>('');
  const [priorYearAgi, setPriorYearAgi] = useState<number | ''>('');
  const [payFrequency, setPayFrequency] = useState<number | 'auto'>('auto');

  const [data, setData] = useState<WithholdingCheckupPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      year: String(year),
      filingStatus,
      filersAge65Plus: String(filersAge65Plus),
      annualize: String(annualize),
    });
    if (priorYearTax !== '') params.set('priorYearLiability', String(priorYearTax));
    if (priorYearAgi !== '') params.set('priorYearAGI', String(priorYearAgi));
    if (payFrequency !== 'auto') params.set('payPeriodsPerYear', String(payFrequency));

    fetch(`/api/tools/withholding?${params.toString()}`)
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? 'Failed to load withholding checkup');
        }
        return (await res.json()) as WithholdingCheckupPayload;
      })
      .then(payload => {
        if (cancelled) return;
        setData(payload);
        if (!prefsLoaded) {
          setFilingStatus(payload.meta.filingStatus);
          setPrefsLoaded(true);
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, filingStatus, filersAge65Plus, annualize, priorYearTax, priorYearAgi, payFrequency]);

  const checkup = data?.checkup ?? null;
  const meta = data?.meta ?? null;
  const isCurrentYear = year === currentYear;

  const bumpNote = useMemo(() => {
    if (!checkup) return null;
    if (checkup.remainingPayPeriods === null || checkup.remainingPayPeriods <= 0) {
      return 'No pay periods remain in the year to adjust withholding.';
    }
    if (checkup.recommendedPerPaycheckBump === 0 && checkup.recommendedPerPaycheckBumpFull === 0) {
      return 'Your withholding is on pace — no per-paycheck change needed.';
    }
    return null;
  }, [checkup]);

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Withholding Checkup</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Projects your {year} year-end federal tax from year-to-date book data and compares it against
          what you have withheld — plus the IRS safe-harbor target and the estimated payments still due.
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
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Filing status
            <select
              value={filingStatus}
              onChange={e => setFilingStatus(e.target.value as FilingStatus)}
              className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {FILING_STATUSES.map(fs => (
                <option key={fs} value={fs}>{FILING_STATUS_LABELS[fs]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Filers 65+
            <select
              value={filersAge65Plus}
              onChange={e => setFilersAge65Plus(parseInt(e.target.value, 10))}
              className="bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Pay frequency
            <select
              value={String(payFrequency)}
              onChange={e => setPayFrequency(e.target.value === 'auto' ? 'auto' : parseInt(e.target.value, 10))}
              className="bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              <option value="auto">Auto{meta ? ` (${meta.payPeriodsPerYear}/yr)` : ''}</option>
              {PAY_FREQUENCIES.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Prior-year tax
            <input
              type="number"
              min={0}
              placeholder="optional"
              value={priorYearTax}
              onChange={e => setPriorYearTax(e.target.value === '' ? '' : Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Prior-year AGI
            <input
              type="number"
              min={0}
              placeholder="optional"
              value={priorYearAgi}
              onChange={e => setPriorYearAgi(e.target.value === '' ? '' : Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          {isCurrentYear && (
            <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer pb-1.5">
              <input
                type="checkbox"
                checked={annualize}
                onChange={e => setAnnualize(e.target.checked)}
                className="accent-[var(--primary)]"
              />
              Annualize YTD
            </label>
          )}
        </div>
        <p className="mt-3 text-[11px] text-foreground-muted">
          Prior-year figures enable the 100%/110% prior-year safe harbor. Income, withholding, and
          estimated payments come from your tax-category mappings — set them up in the{' '}
          <Link href="/tools/tax-estimator" className="text-primary hover:text-primary-hover underline underline-offset-2">
            Tax Estimator
          </Link>
          .
        </p>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center min-h-[240px] text-foreground-muted text-sm">
          Loading withholding checkup…
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-6 text-sm text-error">{error}</div>
      )}

      {checkup && meta && !error && (
        <>
          {!checkup.hasData ? (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-6 text-sm text-foreground-secondary">
              No mapped income or withholding was found for {year}. Map your income and tax-withholding
              accounts to tax categories in the{' '}
              <Link href="/tools/tax-estimator" className="text-primary hover:text-primary-hover underline underline-offset-2">
                Tax Estimator
              </Link>{' '}
              to run the checkup.
            </div>
          ) : (
            <>
              <WithholdingHeadline checkup={checkup} />

              {/* Gap metrics */}
              <StatGrid cols={3}>
                <MetricCard
                  label="Safe-harbor target"
                  value={formatCurrency(checkup.safeHarbor.requiredAnnualPayment)}
                  sub={checkup.safeHarborBasis}
                />
                <MetricCard
                  label="Gap to safe harbor"
                  value={formatCurrency(checkup.gapToSafeHarbor)}
                  tone={checkup.gapToSafeHarbor > 0.005 ? 'negative' : 'positive'}
                  sub={checkup.meetsSafeHarbor ? 'No penalty expected' : 'Still owed to avoid penalty'}
                />
                <MetricCard
                  label="Gap to full liability"
                  value={formatCurrency(checkup.gapToFullLiability)}
                  tone={checkup.gapToFullLiability > 0.005 ? 'negative' : 'positive'}
                  sub="To owe nothing at filing"
                />
              </StatGrid>

              {/* Safe harbor + quarterly */}
              <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Safe harbor & estimated payments</h2>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    The safe harbor is the smaller of 90% of this year&apos;s tax or {' '}
                    {checkup.safeHarbor.priorYearSafeHarbor !== null
                      ? `${checkup.safeHarbor.priorYearMultiplier === 1.1 ? '110%' : '100%'} of last year's`
                      : '100%/110% of last year&apos;s'}{' '}
                    tax. Meeting it avoids an underpayment penalty.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex items-baseline justify-between text-sm border-b border-border/60 py-1.5">
                    <span className="text-foreground-secondary">90% of projected {year} tax</span>
                    <span className="font-mono text-foreground" style={MONO}>
                      {formatCurrency(checkup.safeHarbor.ninetyPercentCurrent)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-sm border-b border-border/60 py-1.5">
                    <span className="text-foreground-secondary">
                      Prior-year safe harbor
                      {checkup.safeHarbor.priorYearMultiplier !== null
                        ? ` (${checkup.safeHarbor.priorYearMultiplier === 1.1 ? '110%' : '100%'})`
                        : ''}
                    </span>
                    <span className="font-mono text-foreground" style={MONO}>
                      {checkup.safeHarbor.priorYearSafeHarbor !== null
                        ? formatCurrency(checkup.safeHarbor.priorYearSafeHarbor)
                        : '—'}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-sm border-b border-border/60 py-1.5">
                    <span className="text-foreground-secondary">Required annual payment</span>
                    <span className="font-mono font-semibold text-foreground" style={MONO}>
                      {formatCurrency(checkup.safeHarbor.requiredAnnualPayment)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-sm border-b border-border/60 py-1.5">
                    <span className="text-foreground-secondary">Estimated payments still due</span>
                    <span
                      className={`font-mono font-semibold ${checkup.remainingEstimatedPayment > 0.005 ? 'text-negative' : 'text-positive'}`}
                      style={MONO}
                    >
                      {formatCurrency(checkup.remainingEstimatedPayment)}
                    </span>
                  </div>
                </div>

                {checkup.nextQuarter ? (
                  <div className="rounded-md border border-border bg-surface p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        Next 1040-ES voucher (Q{checkup.nextQuarter.quarter})
                      </p>
                      <p className="text-xs text-foreground-muted mt-0.5">
                        Due {formatDueDate(checkup.nextQuarter.dueDate)}
                      </p>
                    </div>
                    <p className="font-mono text-lg font-semibold text-foreground" style={MONO}>
                      {formatCurrency(checkup.nextQuarter.amount)}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-positive">
                    No further estimated payments needed to meet the safe harbor.
                  </p>
                )}

                {checkup.safeHarbor.underThousandDollarRule && (
                  <p className="text-[11px] text-foreground-muted">
                    Projected balance due after withholding is under $1,000 — no underpayment penalty
                    applies regardless of estimates.
                  </p>
                )}
              </section>

              {/* Recommendation */}
              <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Recommended paycheck adjustment</h2>
                  <p className="text-xs text-foreground-muted mt-0.5">
                    Spread across the {checkup.remainingPayPeriods ?? '—'} pay periods left this year
                    (submit a new Form W-4 to your employer).
                  </p>
                </div>
                {bumpNote ? (
                  <p className="text-sm text-foreground-secondary">{bumpNote}</p>
                ) : (
                  <StatGrid cols={2}>
                    <MetricCard
                      label="Extra withholding / paycheck — avoid penalty"
                      value={`+${formatCurrency(checkup.recommendedPerPaycheckBump ?? 0)}`}
                      tone="neutral"
                      sub="Reaches the IRS safe harbor"
                    />
                    <MetricCard
                      label="Extra withholding / paycheck — owe nothing"
                      value={`+${formatCurrency(checkup.recommendedPerPaycheckBumpFull ?? 0)}`}
                      tone="neutral"
                      sub="Fully covers the projected liability"
                    />
                  </StatGrid>
                )}
              </section>

              <p className="text-[11px] text-foreground-muted">
                Based on mapped book data {meta.startDate} → {meta.asOfDate}
                {checkup.annualized ? ` · annualized ×${(1 / meta.elapsedYearFraction).toFixed(2)}` : ''}
                {meta.payslip && meta.payslip.count > 0
                  ? ` · ${meta.payslip.count} payslip${meta.payslip.count === 1 ? '' : 's'} found`
                  : ''}
                {meta.payslip?.federalWithholding != null
                  ? ` (payslip federal withholding ${formatCurrency(meta.payslip.federalWithholding)})`
                  : ''}
                . Estimates only — not tax advice.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
