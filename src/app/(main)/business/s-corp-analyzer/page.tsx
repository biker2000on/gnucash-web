'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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

interface ScenarioDetail {
  seTaxOrFica: number;
  incomeTax: number;
  qbiDeduction: number;
  extraCosts: number;
  totalCost: number;
  netAfterTax: number;
  grossOwnerIncome: number;
  taxableIncome: number;
}

interface ScorpScenarioDetail extends ScenarioDetail {
  salaryUsed: number;
  employerFica: number;
  employeeFica: number;
  k1Income: number;
}

interface AnalysisResponse {
  applicable: true;
  year: number;
  ytdNetProfit: number;
  annualizedProfit: number;
  elapsedYearFraction: number;
  ownershipPercent: number;
  linkedHousehold: { name: string | null; filingStatus: string } | null;
  inputs: {
    salary: number;
    requestedSalary: number;
    payrollCost: number;
    prepCost: number;
    franchiseTax: number;
    filingStatus: string;
    otherHouseholdOrdinaryIncome: number;
    otherHouseholdSeIncome: number;
    pinned: boolean;
  };
  llc: ScenarioDetail;
  scorp: ScorpScenarioDetail;
  savings: number;
  breakevenProfit: number | null;
  breakevenCurve: Array<{ profit: number; savings: number }>;
  retirement: { llcEmployerMax: number; scorpEmployerMax: number };
  warnings: string[];
  assumptions: string[];
}

interface NotApplicableResponse {
  applicable: false;
  entityType: string;
}

/** Compact $ label for chart axes (e.g. $150k). */
function kLabel(n: number): string {
  return `$${Math.round(n / 1000)}k`;
}

/**
 * Lightweight inline SVG line chart of S-corp savings vs annual profit.
 * Zero line, savings polyline, vertical marker at the current annualized
 * profit, min/max axis labels. Matches DESIGN.md tokens via CSS variables.
 */
function BreakevenChart({
  curve,
  currentProfit,
}: {
  curve: Array<{ profit: number; savings: number }>;
  currentProfit: number;
}) {
  const W = 660;
  const H = 240;
  const PAD = { left: 56, right: 16, top: 12, bottom: 28 };

  const chart = useMemo(() => {
    if (curve.length < 2) return null;
    const xs = curve.map(p => p.profit);
    const ys = curve.map(p => p.savings);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    let yMin = Math.min(0, ...ys);
    let yMax = Math.max(0, ...ys);
    if (yMax === yMin) yMax = yMin + 1;
    const yPadAmt = (yMax - yMin) * 0.08;
    yMin -= yPadAmt;
    yMax += yPadAmt;

    const x = (p: number) => PAD.left + ((p - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
    const y = (s: number) => PAD.top + (1 - (s - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

    const points = curve.map(p => `${x(p.profit).toFixed(1)},${y(p.savings).toFixed(1)}`).join(' ');
    const markerX = currentProfit >= xMin && currentProfit <= xMax ? x(currentProfit) : null;
    return { points, zeroY: y(0), markerX, xMin, xMax, yMin, yMax, x, y };
  }, [curve, currentProfit]);

  if (!chart) return null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto"
      role="img"
      aria-label="S-corp savings versus annual profit"
    >
      {/* zero line */}
      <line
        x1={PAD.left} x2={W - PAD.right} y1={chart.zeroY} y2={chart.zeroY}
        stroke="var(--border)" strokeWidth={1}
      />
      <text
        x={PAD.left - 8} y={chart.zeroY + 4} textAnchor="end"
        fontSize={11} fill="var(--foreground-muted)" fontFamily="JetBrains Mono, monospace"
      >
        $0
      </text>
      {/* top/bottom y labels */}
      <text x={PAD.left - 8} y={PAD.top + 8} textAnchor="end" fontSize={11} fill="var(--foreground-muted)" fontFamily="JetBrains Mono, monospace">
        {kLabel(chart.yMax)}
      </text>
      <text x={PAD.left - 8} y={H - PAD.bottom} textAnchor="end" fontSize={11} fill="var(--foreground-muted)" fontFamily="JetBrains Mono, monospace">
        {kLabel(chart.yMin)}
      </text>
      {/* x labels */}
      <text x={PAD.left} y={H - 8} textAnchor="start" fontSize={11} fill="var(--foreground-muted)" fontFamily="JetBrains Mono, monospace">
        {kLabel(chart.xMin)}
      </text>
      <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize={11} fill="var(--foreground-muted)" fontFamily="JetBrains Mono, monospace">
        {kLabel(chart.xMax)}
      </text>
      {/* current-profit marker */}
      {chart.markerX !== null && (
        <>
          <line
            x1={chart.markerX} x2={chart.markerX} y1={PAD.top} y2={H - PAD.bottom}
            stroke="var(--secondary)" strokeWidth={1} strokeDasharray="4 3"
          />
          <text
            x={chart.markerX + 4} y={PAD.top + 12} fontSize={11}
            fill="var(--secondary)" fontFamily="JetBrains Mono, monospace"
          >
            you
          </text>
        </>
      )}
      {/* savings curve */}
      <polyline
        points={chart.points}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ScenarioCard({
  title,
  subtitle,
  detail,
  employmentTaxLabel,
  highlight,
}: {
  title: string;
  subtitle: string;
  detail: ScenarioDetail;
  employmentTaxLabel: string;
  highlight: boolean;
}) {
  const rows: Array<{ label: string; value: number; tone?: 'muted' }> = [
    { label: employmentTaxLabel, value: detail.seTaxOrFica },
    { label: 'Federal income tax', value: detail.incomeTax },
    { label: 'QBI deduction', value: -detail.qbiDeduction, tone: 'muted' },
    { label: 'Extra costs', value: detail.extraCosts },
  ];
  return (
    <div
      className={`rounded-lg border p-5 space-y-3 ${
        highlight ? 'border-primary/50 bg-primary-light' : 'border-border bg-surface/30'
      }`}
    >
      <div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-xs text-foreground-muted mt-0.5">{subtitle}</p>
      </div>
      <div className="space-y-1">
        {rows.map(r => (
          <div key={r.label} className="flex items-baseline justify-between text-sm border-b border-border/60 py-1.5">
            <span className="text-foreground-secondary">{r.label}</span>
            <span
              className={`font-mono ${r.tone === 'muted' ? 'text-foreground-secondary' : 'text-foreground'}`}
              style={MONO}
            >
              {r.label === 'QBI deduction'
                ? `(${formatCurrency(Math.abs(r.value))})`
                : formatCurrency(r.value)}
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between text-sm py-1.5">
          <span className="font-semibold text-foreground">Total cost</span>
          <span className="font-mono font-semibold text-foreground" style={MONO}>
            {formatCurrency(detail.totalCost)}
          </span>
        </div>
        <div className="flex items-baseline justify-between text-sm py-1.5">
          <span className="text-foreground-secondary">Owner net after tax</span>
          <span className="font-mono font-semibold text-positive" style={MONO}>
            {formatCurrency(detail.netAfterTax)}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function SCorpAnalyzerPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  // null = "not touched yet; let the server resolve pinned/default values"
  const [salary, setSalary] = useState<number | null>(null);
  const [payrollCost, setPayrollCost] = useState<number | null>(null);
  const [prepCost, setPrepCost] = useState<number | null>(null);
  const [franchiseTax, setFranchiseTax] = useState<number | null>(null);

  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [notApplicable, setNotApplicable] = useState<NotApplicableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinState, setPinState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showAssumptions, setShowAssumptions] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ year: String(year) });
    if (salary !== null) params.set('salary', String(salary));
    if (payrollCost !== null) params.set('payrollCost', String(payrollCost));
    if (prepCost !== null) params.set('prepCost', String(prepCost));
    if (franchiseTax !== null) params.set('franchiseTax', String(franchiseTax));

    const timer = setTimeout(() => {
      fetch(`/api/business/s-corp-analysis?${params.toString()}`)
        .then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error ?? 'Failed to load S-corp analysis');
          }
          return (await res.json()) as AnalysisResponse | NotApplicableResponse;
        })
        .then(payload => {
          if (cancelled) return;
          if (!payload.applicable) {
            setNotApplicable(payload);
            return;
          }
          setData(payload);
          // Seed the inputs once from the server-resolved (pinned) values so
          // the controls show what the analysis actually used.
          if (!seededRef.current) {
            seededRef.current = true;
            setSalary(payload.inputs.salary);
            setPayrollCost(payload.inputs.payrollCost);
            setPrepCost(payload.inputs.prepCost);
            setFranchiseTax(payload.inputs.franchiseTax);
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
  }, [year, salary, payrollCost, prepCost, franchiseTax]);

  const pinInputs = async () => {
    if (!data) return;
    setPinState('saving');
    try {
      const res = await fetch('/api/business/s-corp-analysis', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          salary: salary ?? data.inputs.salary,
          payrollCost: payrollCost ?? data.inputs.payrollCost,
          prepCost: prepCost ?? data.inputs.prepCost,
          franchiseTax: franchiseTax ?? data.inputs.franchiseTax,
        }),
      });
      if (!res.ok) throw new Error('pin failed');
      setPinState('saved');
      setTimeout(() => setPinState('idle'), 2000);
    } catch {
      setPinState('error');
      setTimeout(() => setPinState('idle'), 3000);
    }
  };

  if (notApplicable) {
    const entityLabel = ENTITY_TYPE_LABELS[notApplicable.entityType] ?? notApplicable.entityType;
    return (
      <div className="space-y-6 max-w-[1100px]">
        <header>
          <h1 className="text-3xl font-bold text-foreground">S-Corp Election Analyzer</h1>
          <p className="text-foreground-muted mt-1 text-sm">
            Compares the total tax cost of operating as an LLC/sole proprietorship versus an
            S-corp at your current profit run rate.
          </p>
        </header>
        <div className="rounded-lg border border-border bg-surface/30 p-6 space-y-3">
          <p className="text-sm text-foreground-secondary">
            The S-corp analysis applies to pass-through business books (sole proprietorship,
            LLC, or an existing S-corp). This book is a {entityLabel}, so the election
            comparison doesn&apos;t apply here.
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

  const salaryMax = data ? Math.max(0, Math.round(data.annualizedProfit)) : 200_000;
  const effSalary = salary ?? data?.inputs.salary ?? 0;
  const savesMoney = (data?.savings ?? 0) > 0;

  return (
    <div className="space-y-6 max-w-[1100px]">
      <header>
        <h1 className="text-3xl font-bold text-foreground">S-Corp Election Analyzer</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Compares the total federal cost of your pass-through profit as an LLC (SE tax on
          everything) versus an S-corp (payroll tax on a reasonable salary, distributions
          tax-free of employment tax) — including QBI and the S-corp&apos;s extra running costs.
        </p>
      </header>

      {/* Inputs */}
      <div className="rounded-lg border border-border bg-surface/30 p-4 space-y-3">
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
            Reasonable salary
            <input
              type="number"
              min={0}
              step={1000}
              value={effSalary}
              onChange={e => setSalary(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Payroll service / yr
            <input
              type="number"
              min={0}
              step={50}
              value={payrollCost ?? data?.inputs.payrollCost ?? 600}
              onChange={e => setPayrollCost(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-28 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            Extra tax prep / yr
            <input
              type="number"
              min={0}
              step={50}
              value={prepCost ?? data?.inputs.prepCost ?? 800}
              onChange={e => setPrepCost(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-28 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
            State franchise tax / yr
            <input
              type="number"
              min={0}
              step={50}
              value={franchiseTax ?? data?.inputs.franchiseTax ?? 200}
              onChange={e => setFranchiseTax(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-28 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
            />
          </label>
          <button
            onClick={pinInputs}
            disabled={pinState === 'saving' || !data}
            className="ml-auto px-3 py-1.5 text-sm rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
          >
            {pinState === 'saving' ? 'Pinning…' : pinState === 'saved' ? 'Pinned ✓' : pinState === 'error' ? 'Pin failed' : 'Pin these inputs'}
          </button>
        </div>
        {/* Salary slider */}
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={Math.max(salaryMax, effSalary, 1000)}
            step={1000}
            value={effSalary}
            onChange={e => setSalary(parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--primary)]"
            aria-label="Reasonable salary slider"
          />
          <span className="font-mono text-xs text-foreground-secondary w-24 text-right" style={MONO}>
            {formatCurrency(effSalary)}
          </span>
        </div>
        <p className="text-[11px] text-foreground-muted">
          The salary must be defensible market-rate compensation for the work you actually
          perform — the IRS can reclassify distributions as wages if it&apos;s set too low.
        </p>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center min-h-[240px] text-foreground-muted text-sm">
          Loading S-corp analysis…
        </div>
      )}

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg p-6 text-sm text-error">{error}</div>
      )}

      {data && !error && (
        <>
          {/* Verdict hero */}
          <section
            className={`rounded-lg border p-6 ${
              savesMoney ? 'border-positive/40 bg-positive/5' : 'border-border bg-surface/30'
            }`}
          >
            <p className="text-xs uppercase tracking-wider text-foreground-muted">Verdict</p>
            <p className="mt-1 text-2xl font-bold text-foreground">
              {savesMoney ? (
                <>
                  An S-corp would save you about{' '}
                  <span className="font-mono text-positive" style={MONO}>{formatCurrency(data.savings)}</span>
                  /year at your current run rate.
                </>
              ) : (
                <>
                  An S-corp would cost you about{' '}
                  <span className="font-mono text-negative" style={MONO}>{formatCurrency(Math.abs(data.savings))}</span>
                  /year more at your current run rate.
                </>
              )}
            </p>
            <p className="mt-2 text-sm text-foreground-secondary">
              Based on {formatCurrency(data.annualizedProfit)} annualized net profit
              ({formatCurrency(data.ytdNetProfit)} YTD ÷ {data.elapsedYearFraction.toFixed(2)} of the
              year elapsed), a {formatCurrency(data.scorp.salaryUsed)} salary,
              {' '}{data.ownershipPercent}% ownership, filing{' '}
              {data.inputs.filingStatus.toUpperCase()}
              {data.linkedHousehold ? ` with household "${data.linkedHousehold.name ?? 'linked book'}"` : ''}.
            </p>
          </section>

          {data.warnings.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 space-y-1">
              {data.warnings.map((w, i) => (
                <p key={i} className="text-sm text-foreground-secondary">{w}</p>
              ))}
            </div>
          )}

          {/* Side-by-side scenarios */}
          <div className="grid gap-4 md:grid-cols-2">
            <ScenarioCard
              title="Stay LLC / sole prop"
              subtitle="All profit flows through Schedule C/K-1 with SE tax"
              detail={data.llc}
              employmentTaxLabel="Self-employment tax"
              highlight={!savesMoney}
            />
            <ScenarioCard
              title="Elect S-corp"
              subtitle={`Salary ${formatCurrency(data.scorp.salaryUsed)} + K-1 distributions ${formatCurrency(data.scorp.k1Income)}`}
              detail={data.scorp}
              employmentTaxLabel="Payroll taxes (both halves)"
              highlight={savesMoney}
            />
          </div>

          {/* Breakeven */}
          <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">Breakeven curve</h2>
              <p className="text-xs text-foreground-muted mt-0.5">
                Annual S-corp savings swept across profit levels, holding your salary strategy
                (salary as a share of profit, $30k floor) constant.
              </p>
            </div>
            <BreakevenChart curve={data.breakevenCurve} currentProfit={data.annualizedProfit} />
            <p className="text-sm text-foreground-secondary">
              {data.breakevenProfit !== null ? (
                <>
                  Breakeven &asymp;{' '}
                  <span className="font-mono text-foreground" style={MONO}>
                    {formatCurrency(data.breakevenProfit)}
                  </span>{' '}
                  net profit; you&apos;re at{' '}
                  <span className="font-mono text-foreground" style={MONO}>
                    {formatCurrency(data.annualizedProfit)}
                  </span>{' '}
                  annualized.
                </>
              ) : (
                <>
                  The S-corp never breaks even over the swept profit range with these costs —
                  at{' '}
                  <span className="font-mono text-foreground" style={MONO}>
                    {formatCurrency(data.annualizedProfit)}
                  </span>{' '}
                  annualized profit, staying an LLC is cheaper.
                </>
              )}
            </p>
          </section>

          {/* Retirement impact */}
          <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-3">
            <h2 className="text-base font-semibold text-foreground">Retirement impact</h2>
            <StatGrid cols={2}>
              <StatCard
                label="Solo 401(k) employer max — LLC"
                value={formatCurrency(data.retirement.llcEmployerMax)}
                sub="~20% of net SE earnings"
              />
              <StatCard
                label="Solo 401(k) employer max — S-corp"
                value={formatCurrency(data.retirement.scorpEmployerMax)}
                sub="25% of W-2 salary"
              />
            </StatGrid>
            <p className="text-[11px] text-foreground-muted">
              A lower S-corp salary shrinks the employer contribution base — see the{' '}
              <Link href="/business/retirement-planner" className="text-primary hover:text-primary-hover underline underline-offset-2">
                Retirement Planner
              </Link>{' '}
              for the full capacity picture.
            </p>
          </section>

          {/* Assumptions */}
          <section className="rounded-lg border border-border bg-surface/30">
            <button
              onClick={() => setShowAssumptions(v => !v)}
              className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold text-foreground"
            >
              Warnings &amp; assumptions
              <span className="text-foreground-muted" aria-hidden>{showAssumptions ? '−' : '+'}</span>
            </button>
            {showAssumptions && (
              <ul className="px-5 pb-4 space-y-2 list-disc list-inside">
                {data.assumptions.map((a, i) => (
                  <li key={i} className="text-xs text-foreground-secondary">{a}</li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-[11px] text-foreground-muted">
            Estimates only — not tax advice. Consult a CPA before making an S-corp election
            (Form 2553).
          </p>
        </>
      )}
    </div>
  );
}
