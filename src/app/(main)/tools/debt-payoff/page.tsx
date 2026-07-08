'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { DebtPayoffResult, DebtPlan } from '@/lib/debt-payoff';
import { DebtPayoffChart, monthToLabel } from './DebtPayoffChart';

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

const fmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const fmtFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const MONO_STYLE = { fontFeatureSettings: "'tnum'" } as const;

function formatMonths(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} mo`;
  if (m === 0) return `${y} yr`;
  return `${y} yr ${m} mo`;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Strategy = 'snowball' | 'avalanche';

interface DebtRow {
  guid: string;
  name: string;
  accountType: string;
  currency: string;
  balance: number;
  apr: string; // input state kept as string
  minPayment: string;
  include: boolean;
  source: 'saved' | 'mortgage' | 'default';
}

/* ------------------------------------------------------------------ */
/* Strategy headline card                                              */
/* ------------------------------------------------------------------ */

function StrategyCard({
  title,
  subtitle,
  plan,
  selected,
  onSelect,
}: {
  title: string;
  subtitle: string;
  plan: DebtPlan;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const clickable = onSelect !== undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!clickable}
      className={`text-left bg-surface/30 border rounded-xl p-5 transition-colors ${
        selected
          ? 'border-primary bg-primary/5'
          : clickable
            ? 'border-border hover:border-border-hover cursor-pointer'
            : 'border-border cursor-default'
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground-muted uppercase tracking-wider">{title}</p>
        {selected && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 rounded px-1.5 py-0.5">
            Selected
          </span>
        )}
      </div>
      <p className="text-2xl font-bold mt-1 font-mono text-foreground" style={MONO_STYLE}>
        {plan.capped || plan.months === null ? 'Never' : monthToLabel(plan.months)}
      </p>
      <p className="text-xs text-foreground-muted mt-1">
        {plan.capped || plan.months === null
          ? 'Not paid off within 100 years'
          : `Debt-free in ${formatMonths(plan.months)}`}
      </p>
      <div className="flex items-baseline justify-between mt-3 pt-3 border-t border-border">
        <span className="text-xs text-foreground-muted">Total interest</span>
        <span className="text-sm font-medium font-mono text-negative" style={MONO_STYLE}>
          {plan.capped ? `> ${fmt.format(plan.totalInterest)}` : fmtFull.format(plan.totalInterest)}
        </span>
      </div>
      <p className="text-[11px] text-foreground-muted mt-2">{subtitle}</p>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Payoff order list                                                   */
/* ------------------------------------------------------------------ */

function PayoffOrderList({ plan }: { plan: DebtPlan }) {
  const byGuid = useMemo(() => new Map(plan.debts.map((d) => [d.guid, d])), [plan]);
  const ordered = plan.payoffOrder
    .map((guid) => byGuid.get(guid))
    .filter((d): d is NonNullable<typeof d> => d !== undefined);
  const unpaid = plan.debts.filter(
    (d) => d.payoffMonth === null && d.startingBalance > 0
  );

  return (
    <div className="bg-surface/30 border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-foreground mb-1">
        Payoff order — {plan.strategy === 'snowball' ? 'Snowball' : 'Avalanche'}
      </h3>
      <p className="text-xs text-foreground-muted mb-3">
        {plan.strategy === 'snowball'
          ? 'Smallest balance first; freed-up minimums roll to the next debt'
          : 'Highest APR first; freed-up minimums roll to the next debt'}
      </p>
      <ol className="divide-y divide-border">
        {ordered.map((d, i) => (
          <li key={d.guid} className="flex items-center gap-3 py-2.5">
            <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground truncate">{d.name}</p>
              {d.minPaymentBelowInterest && (
                <p className="text-xs text-negative">
                  Payment too low — balance grows under minimum payments alone
                </p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-mono text-foreground" style={MONO_STYLE}>
                {d.payoffMonth === 0 ? 'Paid off' : monthToLabel(d.payoffMonth ?? 0)}
              </p>
              <p className="text-xs font-mono text-foreground-muted" style={MONO_STYLE}>
                {fmtFull.format(d.interestPaid)} interest
              </p>
            </div>
          </li>
        ))}
        {unpaid.map((d) => (
          <li key={d.guid} className="flex items-center gap-3 py-2.5">
            <span className="shrink-0 w-6 h-6 rounded-full bg-negative/10 text-negative text-xs font-semibold flex items-center justify-center">
              !
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground truncate">{d.name}</p>
              <p className="text-xs text-negative">
                Payment too low — not paid off within 100 years
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-mono text-negative" style={MONO_STYLE}>
                {fmt.format(d.remainingBalance)} left
              </p>
              <p className="text-xs font-mono text-foreground-muted" style={MONO_STYLE}>
                {fmtFull.format(d.interestPaid)} interest
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main page                                                           */
/* ------------------------------------------------------------------ */

export default function DebtPayoffPage() {
  const [rows, setRows] = useState<DebtRow[]>([]);
  const [extraMonthly, setExtraMonthly] = useState('0');
  const [strategy, setStrategy] = useState<Strategy>('avalanche');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<DebtPayoffResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);

  /* ---------------- Load debts + saved config ---------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tools/debt-payoff');
        if (!res.ok) throw new Error('Failed to load liabilities');
        const data = await res.json();
        if (cancelled) return;
        setRows(
          (data.debts as Array<Omit<DebtRow, 'apr' | 'minPayment'> & { apr: number; minPayment: number }>).map(
            (d) => ({
              ...d,
              apr: String(d.apr ?? 0),
              minPayment: String(d.minPayment ?? 0),
            })
          )
        );
        setExtraMonthly(String(data.settings?.extraMonthly ?? 0));
        setStrategy(data.settings?.strategy === 'snowball' ? 'snowball' : 'avalanche');
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- Included debts for computation ---------------- */

  const includedDebts = useMemo(
    () =>
      rows
        .filter((r) => r.include && r.balance > 0)
        .map((r) => ({
          guid: r.guid,
          name: r.name,
          balance: r.balance,
          apr: Math.max(0, parseFloat(r.apr) || 0),
          minPayment: Math.max(0, parseFloat(r.minPayment) || 0),
        })),
    [rows]
  );
  const extra = Math.max(0, parseFloat(extraMonthly) || 0);

  /* ---------------- Compute plans (debounced, server-side) ---------------- */

  useEffect(() => {
    if (loading) return;
    if (includedDebts.length === 0) {
      setResult(null);
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setComputing(true);
      try {
        const res = await fetch('/api/tools/debt-payoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ debts: includedDebts, extraMonthly: extra }),
          signal: controller.signal,
        });
        if (res.ok) {
          setResult(await res.json());
        }
      } catch {
        /* aborted or network error — keep previous result */
      } finally {
        if (abortRef.current === controller) setComputing(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [includedDebts, extra, loading]);

  /* ---------------- Row edits ---------------- */

  const updateRow = useCallback((guid: string, patch: Partial<DebtRow>) => {
    setRows((prev) => prev.map((r) => (r.guid === guid ? { ...r, ...patch } : r)));
  }, []);

  /* ---------------- Save config ---------------- */

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      const debts: Record<string, { apr: number; minPayment: number; include: boolean }> = {};
      for (const r of rows) {
        debts[r.guid] = {
          apr: Math.max(0, Math.min(100, parseFloat(r.apr) || 0)),
          minPayment: Math.max(0, parseFloat(r.minPayment) || 0),
          include: r.include,
        };
      }
      const res = await fetch('/api/tools/debt-payoff', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debts, settings: { extraMonthly: extra, strategy } }),
      });
      if (res.ok) {
        setSaveStatus('saved');
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

  /* ---------------- Derived display values ---------------- */

  const selectedPlan = result ? result[strategy] : null;
  const comparison = result?.comparison;
  const totalOwed = includedDebts.reduce((s, d) => s + d.balance, 0);
  const totalMin = includedDebts.reduce((s, d) => s + d.minPayment, 0);

  /* ---------------- Render ---------------- */

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Debt Payoff Planner</h1>
        <p className="text-foreground-muted mt-1">
          Compare snowball vs avalanche strategies across your liabilities and see how extra
          payments change your debt-free date.
        </p>
      </header>

      {loadError && (
        <div className="p-4 bg-error/10 border border-error/30 rounded-xl text-sm text-negative">
          {loadError}
        </div>
      )}

      {/* ---------------- Debt table ---------------- */}
      <section className="bg-surface/30 border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-1">Your debts</h2>
        <p className="text-sm text-foreground-muted mb-4">
          Liability accounts from your book. Enter each debt&apos;s APR and minimum monthly
          payment, and choose which to include in the plan.
        </p>

        {loading ? (
          <p className="text-sm text-foreground-muted">Loading liability accounts...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-foreground-muted">
            No liability accounts found in this book.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-foreground-muted uppercase tracking-wider">
                  <th className="text-left font-medium py-2 pr-3 w-10">Incl.</th>
                  <th className="text-left font-medium py-2 pr-3">Debt</th>
                  <th className="text-right font-medium py-2 pr-3">Balance</th>
                  <th className="text-right font-medium py-2 pr-3 w-32">APR</th>
                  <th className="text-right font-medium py-2 w-40">Min payment / mo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.guid} className={r.include ? '' : 'opacity-50'}>
                    <td className="py-2 pr-3">
                      <input
                        type="checkbox"
                        checked={r.include}
                        onChange={(e) => updateRow(r.guid, { include: e.target.checked })}
                        aria-label={`Include ${r.name} in plan`}
                        className="accent-[var(--primary)] w-4 h-4"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <span className="text-foreground">{r.name}</span>
                      <span className="ml-2 text-xs text-foreground-muted">{r.accountType}</span>
                      {r.source === 'mortgage' && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-secondary bg-secondary-light rounded px-1.5 py-0.5">
                          Mortgage
                        </span>
                      )}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-mono ${
                        r.balance > 0 ? 'text-foreground' : 'text-foreground-muted'
                      }`}
                      style={MONO_STYLE}
                    >
                      {fmtFull.format(r.balance)}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <div className="relative inline-block w-24">
                        <input
                          type="number"
                          value={r.apr}
                          min={0}
                          max={100}
                          step={0.01}
                          onChange={(e) => updateRow(r.guid, { apr: e.target.value, source: 'saved' })}
                          aria-label={`APR for ${r.name}`}
                          className="w-full bg-input-bg border border-border rounded-lg py-1.5 pl-2 pr-7 text-right text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                          style={MONO_STYLE}
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-muted text-xs pointer-events-none">
                          %
                        </span>
                      </div>
                    </td>
                    <td className="py-2 text-right">
                      <div className="relative inline-block w-32">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-foreground-muted text-xs pointer-events-none">
                          $
                        </span>
                        <input
                          type="number"
                          value={r.minPayment}
                          min={0}
                          step={1}
                          onChange={(e) =>
                            updateRow(r.guid, { minPayment: e.target.value, source: 'saved' })
                          }
                          aria-label={`Minimum payment for ${r.name}`}
                          className="w-full bg-input-bg border border-border rounded-lg py-1.5 pl-6 pr-2 text-right text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                          style={MONO_STYLE}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              {includedDebts.length > 0 && (
                <tfoot>
                  <tr className="border-t border-border text-foreground font-medium">
                    <td className="py-2 pr-3" />
                    <td className="py-2 pr-3">
                      {includedDebts.length} debt{includedDebts.length !== 1 ? 's' : ''} included
                    </td>
                    <td className="py-2 pr-3 text-right font-mono" style={MONO_STYLE}>
                      {fmtFull.format(totalOwed)}
                    </td>
                    <td className="py-2 pr-3" />
                    <td className="py-2 text-right font-mono" style={MONO_STYLE}>
                      {fmtFull.format(totalMin)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}

        {/* ---------------- Controls ---------------- */}
        <div className="flex flex-wrap items-end gap-4 mt-6 pt-6 border-t border-border">
          <div>
            <label className="block text-sm font-medium text-foreground-muted mb-1">
              Extra monthly payment
            </label>
            <div className="relative w-40">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm pointer-events-none">
                $
              </span>
              <input
                type="number"
                value={extraMonthly}
                min={0}
                step={25}
                onChange={(e) => setExtraMonthly(e.target.value)}
                aria-label="Extra monthly payment in dollars"
                className="w-full bg-input-bg border border-border rounded-lg py-2 pl-7 pr-3 text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                style={MONO_STYLE}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground-muted mb-1">Strategy</label>
            <div className="flex gap-1 bg-input-bg border border-border rounded-lg p-1">
              <button
                type="button"
                onClick={() => setStrategy('snowball')}
                className={`text-sm py-1.5 px-4 rounded-md font-medium transition-colors ${
                  strategy === 'snowball'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground-muted hover:text-foreground'
                }`}
              >
                Snowball
              </button>
              <button
                type="button"
                onClick={() => setStrategy('avalanche')}
                className={`text-sm py-1.5 px-4 rounded-md font-medium transition-colors ${
                  strategy === 'avalanche'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground-muted hover:text-foreground'
                }`}
              >
                Avalanche
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            {saveStatus === 'saved' && <span className="text-sm text-primary">Saved</span>}
            {saveStatus === 'error' && <span className="text-sm text-negative">Failed to save</span>}
            <button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === 'saving' || loading}
              className="px-5 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saveStatus === 'saving' ? 'Saving...' : 'Save plan'}
            </button>
          </div>
        </div>
      </section>

      {/* ---------------- Results ---------------- */}
      {includedDebts.length === 0 && !loading ? (
        <p className="text-sm text-foreground-muted">
          Include at least one debt with a balance to see payoff plans.
        </p>
      ) : result && selectedPlan ? (
        <>
          {/* Global warnings for the selected plan */}
          {selectedPlan.warnings.length > 0 && (
            <div className="p-4 bg-error/10 border border-error/30 rounded-xl space-y-1">
              {selectedPlan.warnings.map((w, i) => (
                <p key={i} className="text-sm text-negative">
                  {w}
                </p>
              ))}
            </div>
          )}

          {/* Headline: both strategies side by side + baseline */}
          <section
            className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 ${computing ? 'opacity-60' : ''}`}
          >
            <StrategyCard
              title="Snowball"
              subtitle="Smallest balance first — quick wins for momentum"
              plan={result.snowball}
              selected={strategy === 'snowball'}
              onSelect={() => setStrategy('snowball')}
            />
            <StrategyCard
              title="Avalanche"
              subtitle="Highest APR first — mathematically cheapest"
              plan={result.avalanche}
              selected={strategy === 'avalanche'}
              onSelect={() => setStrategy('avalanche')}
            />
            <StrategyCard
              title="Minimum only"
              subtitle="Baseline: minimum payments, no extra, no rollover"
              plan={result.minimum}
            />
          </section>

          {/* Comparison summary */}
          {comparison && (
            <section className="bg-surface/30 border border-border rounded-xl p-4 text-sm space-y-1">
              <p className="text-foreground-secondary">
                {comparison.avalancheVsSnowball.interestSaved !== null &&
                comparison.avalancheVsSnowball.monthsSaved !== null ? (
                  comparison.avalancheVsSnowball.interestSaved > 0.005 ||
                  comparison.avalancheVsSnowball.monthsSaved > 0 ? (
                    <>
                      Avalanche saves{' '}
                      <span className="font-mono text-positive" style={MONO_STYLE}>
                        {fmtFull.format(comparison.avalancheVsSnowball.interestSaved)}
                      </span>{' '}
                      in interest and {comparison.avalancheVsSnowball.monthsSaved} month
                      {comparison.avalancheVsSnowball.monthsSaved !== 1 ? 's' : ''} vs snowball.
                    </>
                  ) : (
                    <>Snowball and avalanche perform about the same for these debts.</>
                  )
                ) : (
                  <>Comparison unavailable — one of the plans never pays off.</>
                )}
              </p>
              <p className="text-foreground-secondary">
                {comparison.avalancheVsMinimum.interestSaved !== null &&
                comparison.avalancheVsMinimum.monthsSaved !== null ? (
                  <>
                    Vs minimum payments only, avalanche saves{' '}
                    <span className="font-mono text-positive" style={MONO_STYLE}>
                      {fmtFull.format(comparison.avalancheVsMinimum.interestSaved)}
                    </span>{' '}
                    and {formatMonths(Math.max(0, comparison.avalancheVsMinimum.monthsSaved))}.
                  </>
                ) : result.minimum.capped ? (
                  <span className="text-negative">
                    With minimum payments only, these debts are never paid off.
                  </span>
                ) : null}
              </p>
            </section>
          )}

          {/* Chart + payoff order */}
          <section className={`grid grid-cols-1 lg:grid-cols-2 gap-6 ${computing ? 'opacity-60' : ''}`}>
            <DebtPayoffChart
              snowball={result.snowball}
              avalanche={result.avalanche}
              minimum={result.minimum}
            />
            <PayoffOrderList plan={selectedPlan} />
          </section>
        </>
      ) : computing ? (
        <p className="text-sm text-foreground-muted">Computing payoff plans...</p>
      ) : null}
    </div>
  );
}
