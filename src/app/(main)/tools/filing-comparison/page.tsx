'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import {
  SUPPORTED_TAX_YEARS,
  TAX_CATEGORY_LABELS,
  type BookTaxData,
  type FederalTaxResult,
  type TaxYear,
} from '@/lib/tax/types';
import {
  compareFilingStatuses,
  runBreakevenSweep,
  normalizeAllocation,
  DEFAULT_ALLOCATION,
  SWEEP_VARIABLE_LABELS,
  type AccountOwner,
  type FilingAllocationConfig,
  type FilingComparisonParams,
  type SweepVariable,
} from '@/lib/tax/filing-comparison';
import { Abbr } from '@/components/ui/Abbr';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import BreakevenChart from '@/components/tools/tax/BreakevenChart';

/* ------------------------------------------------------------------ */
/* API payload                                                         */
/* ------------------------------------------------------------------ */

interface SpouseContextPayload {
  age65: boolean;
  coveredByEmployerPlan: boolean;
  iraLimit: number | null;
}

interface ComparisonPayload {
  applicable: boolean;
  entityType?: string;
  filingStatus: 'mfj' | 'qss' | string;
  year?: number;
  bookData?: BookTaxData;
  ownerByAccount?: Record<string, AccountOwner>;
  household?: {
    selfName: string | null;
    spouseName: string | null;
    dependentsUnder17: number;
    self: SpouseContextPayload;
    spouse: SpouseContextPayload;
  };
}

const TOOL_TYPE = 'filing-comparison';

const pctFmt = (r: number) => `${(r * 100).toFixed(1)}%`;

function ResultCell({ value, strong = false }: { value: number; strong?: boolean }) {
  return (
    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${strong ? 'text-foreground font-medium' : 'text-foreground-secondary'}`}>
      {formatCurrency(value)}
    </td>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function FilingComparisonPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = (SUPPORTED_TAX_YEARS as readonly number[]).includes(currentYear)
    ? (currentYear as TaxYear)
    : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  const [payload, setPayload] = useState<ComparisonPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [annualize, setAnnualize] = useState(true);

  const [allocation, setAllocation] = useState<FilingAllocationConfig>(DEFAULT_ALLOCATION);
  const [configId, setConfigId] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [sweepVariable, setSweepVariable] = useState<SweepVariable>('spouseWages');
  const [showSingleLens, setShowSingleLens] = useState(false);

  /* ---- Data ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/tax/filing-comparison?year=${year}`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load filing comparison data');
        return res.json() as Promise<ComparisonPayload>;
      })
      .then(data => {
        if (!cancelled) setPayload(data);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [year]);

  /* ---- Saved allocation config ---- */
  useEffect(() => {
    fetch(`/api/tools/config?toolType=${TOOL_TYPE}`)
      .then(res => (res.ok ? res.json() : []))
      .then((configs: Array<{ id: number; config: Record<string, unknown> }>) => {
        if (!Array.isArray(configs) || configs.length === 0) return;
        setConfigId(configs[0].id);
        const saved = configs[0].config as { allocation?: unknown; sweepVariable?: unknown };
        setAllocation(normalizeAllocation(saved.allocation));
        if (
          saved.sweepVariable === 'spouseWages' ||
          saved.sweepVariable === 'deductionsSelfPct' ||
          saved.sweepVariable === 'capitalGainRealization'
        ) {
          setSweepVariable(saved.sweepVariable);
        }
      })
      .catch(() => {});
  }, []);

  const saveAllocation = async () => {
    setSaveStatus('saving');
    try {
      const body = {
        toolType: TOOL_TYPE,
        name: 'Filing comparison allocation',
        config: { allocation, sweepVariable },
      };
      const res = configId
        ? await fetch(`/api/tools/config/${configId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: body.name, config: body.config }),
          })
        : await fetch('/api/tools/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      if (!res.ok) throw new Error('save failed');
      const saved = await res.json();
      if (saved?.id) setConfigId(saved.id);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  /* ---- Pure computation (mirrors the estimator: engines run client-side) ---- */
  const params: FilingComparisonParams | null = useMemo(() => {
    if (!payload?.applicable || !payload.bookData || !payload.household) return null;
    const elapsed = payload.bookData.elapsedYearFraction;
    const factor = annualize && elapsed < 1 ? 1 / elapsed : 1;
    return {
      bookData: payload.bookData,
      ownerByAccount: payload.ownerByAccount ?? {},
      allocation,
      year,
      jointFilingStatus: payload.filingStatus === 'qss' ? 'qss' : 'mfj',
      factor,
      dependentsUnder17: payload.household.dependentsUnder17,
      self: payload.household.self,
      spouse: payload.household.spouse,
      includeSingleBaseline: showSingleLens,
    };
  }, [payload, allocation, year, annualize, showSingleLens]);

  const comparison = useMemo(() => (params ? compareFilingStatuses(params) : null), [params]);
  const sweep = useMemo(
    () => (params ? runBreakevenSweep(params, sweepVariable) : null),
    [params, sweepVariable],
  );

  const selfLabel = payload?.household?.selfName || 'Self';
  const spouseLabel = payload?.household?.spouseName || 'Spouse';

  /* ---- Render ---- */
  return (
    <div className="space-y-6 max-w-5xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-foreground">Filing Comparison</h1>
        <p className="text-sm text-foreground-secondary max-w-3xl">
          Would filing separately beat filing jointly this year? Your book data is split into
          per-spouse columns and run through the federal engine as one{' '}
          <Abbr term="MFJ" /> return and two <Abbr term="MFS" /> returns, with a breakeven sweep
          to show where the answer flips. Federal only; estimates, not advice.
        </p>
      </header>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={year}
          onChange={e => setYear(parseInt(e.target.value, 10) as TaxYear)}
          aria-label="Tax year"
          className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
        >
          {SUPPORTED_TAX_YEARS.map(y => (
            <option key={y} value={y}>Tax year {y}</option>
          ))}
        </select>
        {payload?.bookData && payload.bookData.elapsedYearFraction < 1 && (
          <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={annualize}
              onChange={e => setAnnualize(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            Annualize <Abbr term="YTD" />
          </label>
        )}
      </div>

      {loading && (
        <div className="text-sm text-foreground-muted py-12 text-center">Loading book data…</div>
      )}
      {error && (
        <div className="text-sm text-error border border-border rounded-md p-4 bg-surface">{error}</div>
      )}

      {/* Empty state: not a jointly-filing household */}
      {!loading && !error && payload && !payload.applicable && (
        <div className="border border-border rounded-lg bg-surface p-8 text-center space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Nothing to compare here</h2>
          <p className="text-sm text-foreground-secondary max-w-xl mx-auto">
            {payload.entityType !== 'household' ? (
              <>This book belongs to a business entity, which doesn&apos;t file a personal 1040.</>
            ) : (
              <>
                The joint-vs-separate comparison only applies when your household currently files
                jointly (<Abbr term="MFJ" /> or <Abbr term="QSS" />) — your filing status is set to{' '}
                <span className="font-medium text-foreground">{payload.filingStatus}</span>.
              </>
            )}
          </p>
          <p className="text-sm text-foreground-muted">
            Filing status is managed in{' '}
            <Link href="/settings" className="text-primary hover:text-primary-hover underline underline-offset-2">
              Settings → Household &amp; entity
            </Link>.
          </p>
        </div>
      )}

      {comparison && payload?.applicable && (
        <>
          {/* Verdict */}
          <StatGrid cols={3}>
            <StatCard
              label="Filing jointly"
              value={formatCurrency(comparison.mfj.totalTax)}
              sub={`effective ${pctFmt(comparison.mfj.effectiveRate)} · marginal ${pctFmt(comparison.mfj.marginalRate)}`}
              tone={comparison.winner === 'mfj' ? 'positive' : 'default'}
            />
            <StatCard
              label="Filing separately (combined)"
              value={formatCurrency(comparison.mfsCombinedTotalTax)}
              sub={`${selfLabel}: ${formatCurrency(comparison.mfsSelf.totalTax)} · ${spouseLabel}: ${formatCurrency(comparison.mfsSpouse.totalTax)}`}
              tone={comparison.winner === 'mfs' ? 'positive' : 'default'}
            />
            <StatCard
              label={comparison.winner === 'tie' ? 'Dead heat' : comparison.winner === 'mfj' ? 'Joint saves' : 'Separate saves'}
              value={formatCurrency(Math.abs(comparison.mfsMinusMfj))}
              sub={
                comparison.winner === 'mfj'
                  ? 'filing jointly is the better choice on these numbers'
                  : comparison.winner === 'mfs'
                    ? 'filing separately wins on these numbers — read the caveats below'
                    : 'both filings land on the same total'
              }
              tone={comparison.winner === 'tie' ? 'default' : 'positive'}
            />
          </StatGrid>

          {/* Allocation */}
          <CollapsibleConfigSection
            title="Income & deduction allocation"
            summary={`unattributed income ${allocation.residualSelfPct}/${100 - allocation.residualSelfPct} · deductions ${allocation.deductionsSelfPct}/${100 - allocation.deductionsSelfPct} · children on ${allocation.ctcClaimant === 'self' ? selfLabel : spouseLabel}'s return`}
            configured
            storageKey="filingComparison.allocationOpen"
          >
            <div className="space-y-4">
              <p className="text-xs text-foreground-muted max-w-3xl">
                Amounts follow the account owner where one is set (Account → preferences → owner —
                this covers <Abbr term="W-2" /> wage and withholding accounts fed by payslips, and
                roster-linked investment accounts). Anything owned jointly or unowned splits by the
                sliders below. Community-property states are out of scope.
              </p>
              <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
                <label className="text-xs text-foreground-secondary space-y-1 block">
                  <span>
                    Unattributed income &amp; withholding: {allocation.residualSelfPct}% {selfLabel} /{' '}
                    {100 - allocation.residualSelfPct}% {spouseLabel}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={allocation.residualSelfPct}
                    onChange={e =>
                      setAllocation(a => ({ ...a, residualSelfPct: parseInt(e.target.value, 10) }))
                    }
                    className="w-full accent-[var(--primary)]"
                  />
                </label>
                <label className="text-xs text-foreground-secondary space-y-1 block">
                  <span>
                    Unattributed deductions: {allocation.deductionsSelfPct}% {selfLabel} /{' '}
                    {100 - allocation.deductionsSelfPct}% {spouseLabel}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={allocation.deductionsSelfPct}
                    onChange={e =>
                      setAllocation(a => ({ ...a, deductionsSelfPct: parseInt(e.target.value, 10) }))
                    }
                    className="w-full accent-[var(--primary)]"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                <Abbr term="CTC" /> children claimed by
                <select
                  value={allocation.ctcClaimant}
                  onChange={e =>
                    setAllocation(a => ({ ...a, ctcClaimant: e.target.value === 'spouse' ? 'spouse' : 'self' }))
                  }
                  className="bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
                >
                  <option value="self">{selfLabel}</option>
                  <option value="spouse">{spouseLabel}</option>
                </select>
                <span className="text-foreground-muted">(a child goes on exactly one separate return)</span>
              </label>

              {/* Attribution evidence */}
              {comparison.attribution.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="text-xs w-full max-w-2xl">
                    <thead>
                      <tr className="text-foreground-muted border-b border-border">
                        <th className="text-left py-1 pr-3 font-medium">Category</th>
                        <th className="text-right py-1 px-3 font-medium">{selfLabel}</th>
                        <th className="text-right py-1 px-3 font-medium">{spouseLabel}</th>
                        <th className="text-right py-1 pl-3 font-medium">Unattributed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.attribution
                        .filter(a => Math.abs(a.attributedSelf) + Math.abs(a.attributedSpouse) + Math.abs(a.unattributed) > 0.005)
                        .map(a => (
                          <tr key={a.category} className="border-b border-border/40">
                            <td className="py-1 pr-3 text-foreground-secondary">
                              {TAX_CATEGORY_LABELS[a.category]}
                            </td>
                            <td className="py-1 px-3 text-right font-mono tabular-nums text-foreground-secondary">
                              {formatCurrency(a.attributedSelf)}
                            </td>
                            <td className="py-1 px-3 text-right font-mono tabular-nums text-foreground-secondary">
                              {formatCurrency(a.attributedSpouse)}
                            </td>
                            <td className="py-1 pl-3 text-right font-mono tabular-nums text-warning">
                              {formatCurrency(a.unattributed)}
                            </td>
                          </tr>
                        ))}
                      {(Math.abs(comparison.gainsAttribution.attributedSelf) +
                        Math.abs(comparison.gainsAttribution.attributedSpouse) +
                        Math.abs(comparison.gainsAttribution.unattributed)) > 0.005 && (
                        <tr className="border-b border-border/40">
                          <td className="py-1 pr-3 text-foreground-secondary">Realized capital gains</td>
                          <td className="py-1 px-3 text-right font-mono tabular-nums text-foreground-secondary">
                            {formatCurrency(comparison.gainsAttribution.attributedSelf)}
                          </td>
                          <td className="py-1 px-3 text-right font-mono tabular-nums text-foreground-secondary">
                            {formatCurrency(comparison.gainsAttribution.attributedSpouse)}
                          </td>
                          <td className="py-1 pl-3 text-right font-mono tabular-nums text-warning">
                            {formatCurrency(comparison.gainsAttribution.unattributed)}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <button
                onClick={saveAllocation}
                disabled={saveStatus === 'saving'}
                className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Save failed — retry' : 'Save allocation'}
              </button>
            </div>
          </CollapsibleConfigSection>

          {/* Side-by-side table */}
          <section className="border border-border rounded-lg bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Side by side</h2>
              <p className="text-xs text-foreground-muted mt-0.5">
                Separate returns use the{' '}
                {comparison.mfsCombination.chosen === 'both_itemize' ? 'both-itemize' : 'both-standard-deduction'}{' '}
                combination — the cheaper of the two legal options
                {comparison.mfsCombination.bothStandardTotal !== null && (
                  <>
                    {' '}(both itemize: {formatCurrency(comparison.mfsCombination.bothItemizeTotal)},
                    both standard: {formatCurrency(comparison.mfsCombination.bothStandardTotal)})
                  </>
                )}.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-foreground-muted border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">Line</th>
                    <th className="text-right px-3 py-2 font-medium">Joint</th>
                    <th className="text-right px-3 py-2 font-medium">{selfLabel} (sep.)</th>
                    <th className="text-right px-3 py-2 font-medium">{spouseLabel} (sep.)</th>
                    <th className="text-right px-3 py-2 font-medium">Separate combined</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Total income', (r: FederalTaxResult) => r.totalIncome],
                      ['AGI', (r: FederalTaxResult) => r.agi],
                      ['Deduction taken', (r: FederalTaxResult) => r.deductionTaken],
                      ['Taxable income', (r: FederalTaxResult) => r.taxableIncome],
                      ['Ordinary tax', (r: FederalTaxResult) => r.ordinaryTax],
                      ['Capital gains tax', (r: FederalTaxResult) => r.capitalGainsTax],
                      ['Self-employment tax', (r: FederalTaxResult) => r.selfEmploymentTax],
                      ['NIIT', (r: FederalTaxResult) => r.niit],
                      ['Additional Medicare', (r: FederalTaxResult) => r.additionalMedicareTax],
                      ['Credits', (r: FederalTaxResult) => -r.credits],
                    ] as Array<[string, (r: FederalTaxResult) => number]>
                  ).map(([label, get]) => (
                    <tr key={label} className="border-b border-border/40">
                      <td className="px-4 py-1.5 text-foreground-secondary">
                        {label === 'NIIT' ? <Abbr term="NIIT" /> : label === 'AGI' ? <Abbr term="AGI" /> : label}
                      </td>
                      <ResultCell value={get(comparison.mfj)} />
                      <ResultCell value={get(comparison.mfsSelf)} />
                      <ResultCell value={get(comparison.mfsSpouse)} />
                      <ResultCell value={get(comparison.mfsSelf) + get(comparison.mfsSpouse)} />
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <td className="px-4 py-2 font-medium text-foreground">Total tax</td>
                    <ResultCell value={comparison.mfj.totalTax} strong />
                    <ResultCell value={comparison.mfsSelf.totalTax} strong />
                    <ResultCell value={comparison.mfsSpouse.totalTax} strong />
                    <ResultCell value={comparison.mfsCombinedTotalTax} strong />
                  </tr>
                  <tr>
                    <td className="px-4 py-1.5 text-foreground-muted">Effective / marginal rate</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground-muted">
                      {pctFmt(comparison.mfj.effectiveRate)} / {pctFmt(comparison.mfj.marginalRate)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground-muted">
                      {pctFmt(comparison.mfsSelf.effectiveRate)} / {pctFmt(comparison.mfsSelf.marginalRate)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground-muted">
                      {pctFmt(comparison.mfsSpouse.effectiveRate)} / {pctFmt(comparison.mfsSpouse.marginalRate)}
                    </td>
                    <td className="px-3 py-1.5" />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Divergences */}
          {comparison.divergences.length > 0 && (
            <section className="border border-border rounded-lg bg-surface p-4 space-y-3">
              <h2 className="text-sm font-semibold text-foreground">Where the outcomes diverge</h2>
              <ul className="space-y-2">
                {comparison.divergences.map(d => (
                  <li key={d.key} className="text-xs flex flex-col sm:flex-row sm:items-baseline gap-x-3 gap-y-0.5">
                    <span className="shrink-0 sm:w-64 text-foreground">{d.label}</span>
                    <span className="shrink-0 font-mono tabular-nums text-foreground-secondary">
                      {formatCurrency(d.mfj)} joint → {formatCurrency(d.mfs)} separate{' '}
                      <span className={d.delta > 0 ? 'text-negative' : 'text-positive'}>
                        ({d.delta > 0 ? '+' : ''}{formatCurrency(d.delta)})
                      </span>
                    </span>
                    <span className="text-foreground-muted">{d.explanation}</span>
                  </li>
                ))}
              </ul>
              {comparison.nonDeductibleIra.mfs > comparison.nonDeductibleIra.mfj + 0.005 && (
                <p className="text-xs text-foreground-muted border-t border-border/60 pt-2">
                  Non-deductible traditional <Abbr term="IRA" /> contributions rise from{' '}
                  <span className="font-mono">{formatCurrency(comparison.nonDeductibleIra.mfj)}</span> jointly to{' '}
                  <span className="font-mono">{formatCurrency(comparison.nonDeductibleIra.mfs)}</span> separately
                  (§219(g) 0–10k <Abbr term="MAGI" /> phase-out per separate return).
                </p>
              )}
            </section>
          )}

          {/* Marriage penalty / bonus lens */}
          <section className="border border-border rounded-lg bg-surface p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-foreground">Marriage penalty / bonus lens</h2>
              <label className="flex items-center gap-2 text-xs text-foreground-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={showSingleLens}
                  onChange={e => setShowSingleLens(e.target.checked)}
                  className="accent-[var(--primary)]"
                />
                Show hypothetical two-single baseline
              </label>
            </div>
            {showSingleLens && comparison.singleBaseline ? (
              <div className="text-xs text-foreground-secondary space-y-1">
                <p>
                  If each spouse could file single (they can&apos;t — this is a what-if, not an option),
                  the combined tax would be{' '}
                  <span className="font-mono text-foreground">{formatCurrency(comparison.singleBaseline.combinedTotalTax)}</span>{' '}
                  ({selfLabel}: {formatCurrency(comparison.singleBaseline.self.totalTax)},{' '}
                  {spouseLabel}: {formatCurrency(comparison.singleBaseline.spouse.totalTax)}).
                </p>
                <p>
                  {comparison.singleBaseline.marriagePenalty > 0.005 ? (
                    <>
                      Filing jointly costs{' '}
                      <span className="font-mono text-negative">
                        {formatCurrency(comparison.singleBaseline.marriagePenalty)}
                      </span>{' '}
                      more than the two-single baseline — a marriage <em>penalty</em> on these numbers.
                    </>
                  ) : comparison.singleBaseline.marriagePenalty < -0.005 ? (
                    <>
                      Filing jointly saves{' '}
                      <span className="font-mono text-positive">
                        {formatCurrency(-comparison.singleBaseline.marriagePenalty)}
                      </span>{' '}
                      versus the two-single baseline — a marriage <em>bonus</em> on these numbers.
                    </>
                  ) : (
                    <>Joint filing matches the two-single baseline exactly — neither penalty nor bonus.</>
                  )}
                </p>
              </div>
            ) : (
              <p className="text-xs text-foreground-muted">
                Compares your joint return against two hypothetical single returns over the same
                split — context for how much the married rate structure helps or hurts. Married
                filers cannot actually file single.
              </p>
            )}
          </section>

          {/* Breakeven sweep */}
          {sweep && (
            <section className="border border-border rounded-lg bg-surface p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-semibold text-foreground">Breakeven sweep</h2>
                <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                  Sweep
                  <select
                    value={sweepVariable}
                    onChange={e => setSweepVariable(e.target.value as SweepVariable)}
                    className="bg-background-tertiary border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
                  >
                    {(Object.keys(SWEEP_VARIABLE_LABELS) as SweepVariable[]).map(v => (
                      <option key={v} value={v}>{SWEEP_VARIABLE_LABELS[v]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="text-xs text-foreground-secondary">
                {sweep.verdict === 'crossover' ? (
                  <>
                    The answer flips at{' '}
                    {sweep.crossovers.map((x, i) => (
                      <span key={x} className="font-mono text-foreground">
                        {i > 0 && ', '}
                        {sweepVariable === 'deductionsSelfPct' ? `${Math.round(x)}%` : formatCurrency(x)}
                      </span>
                    ))}{' '}
                    — on one side of the breakeven, filing separately wins.
                  </>
                ) : sweep.verdict === 'mfj_always' ? (
                  <>Filing jointly wins across the entire swept range — no breakeven exists here.</>
                ) : sweep.verdict === 'mfs_always' ? (
                  <>Filing separately wins across the entire swept range — no breakeven exists here.</>
                ) : (
                  <>The two filings stay within pennies of each other across the whole range.</>
                )}
                {' '}Realized <Abbr term="LTCG" /> sweeps add a hypothetical extra gain on top of
                today&apos;s numbers; wage and deduction sweeps replace the current value.
              </p>
              <BreakevenChart sweep={sweep} xLabel={SWEEP_VARIABLE_LABELS[sweep.variable]} />
            </section>
          )}

          {/* Caveats — surfaced in the result, not fine print */}
          <section className="border border-warning/40 rounded-lg bg-surface p-4 space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              Before you file separately — what this comparison does <em>not</em> capture
            </h2>
            <ul className="space-y-2">
              {comparison.caveats.map(c => (
                <li key={c.id} className="text-xs flex gap-2">
                  <span
                    className={`mt-0.5 shrink-0 w-2 h-2 rounded-full ${c.applies ? 'bg-warning' : 'bg-border'}`}
                    title={c.applies ? 'Likely applies to your data' : 'General caveat'}
                  />
                  <span>
                    <span className={`font-medium ${c.applies ? 'text-warning' : 'text-foreground'}`}>
                      {c.title}
                      {c.applies && ' — likely applies to you'}
                    </span>{' '}
                    <span className="text-foreground-muted">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-foreground-muted border-t border-border/60 pt-2">
              First mention decoder: <Abbr term="EITC" /> and <Abbr term="IDR" /> are the two most
              common swing factors that live entirely outside this calculation.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
