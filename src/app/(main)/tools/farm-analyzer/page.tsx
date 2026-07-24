'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { SUPPORTED_TAX_YEARS, isSupportedTaxYear, type TaxYear } from '@/lib/tax/types';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { Modal } from '@/components/ui/Modal';
import NewBookForm from '@/components/books/NewBookForm';
import { useAccounts } from '@/lib/hooks/useAccounts';
import type { Account } from '@/lib/types';

import type {
  FarmScenarioDetail,
  FarmScenarioKey,
  PuvHint,
  SalesTaxSavingsBasis,
} from '@/lib/tax/farm-analysis';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

interface FarmAccountAmount {
  accountGuid: string;
  accountName: string;
  accountPath: string;
  amount: number;
}

interface SetupResponse {
  applicable: true;
  needsSetup: true;
  year: number;
  entityType: string;
  businessActivity: string;
  assumptions: string[];
  ncNotes: string[];
  exemptCategories: string[];
}

interface AnalysisResponse {
  applicable: true;
  needsSetup: false;
  year: number;
  entityType: string;
  businessActivity: string;
  taxState: string | null;
  isFarmBusinessBook: boolean;
  ytdGross: number;
  ytdExpenses: number;
  elapsedYearFraction: number;
  incomeAccounts: FarmAccountAmount[];
  expenseAccounts: FarmAccountAmount[];
  inputs: {
    gross: number;
    expenses: number;
    equipment: number;
    purchases: number;
    salesTaxRate: number;
    priorYearFarmIncome: number | null;
    priorThreeYearFarmIncome: Array<number | null>;
    acreage: number | null;
    isFirstLlcYear: boolean;
    filingStatus: string;
    otherHouseholdOrdinaryIncome: number;
    otherHouseholdSeIncome: number;
    farmIncomeAccountGuids: string[];
    farmExpenseAccountGuids: string[];
  };
  scenarios: Record<FarmScenarioKey, FarmScenarioDetail>;
  best: Exclude<FarmScenarioKey, 'unreported_cash'>;
  scheduleFVsHobby: number;
  llcVsSoleProp: number;
  costOfCompliance: number;
  qualifiesForSalesTaxExemption: boolean;
  priorThreeYearAverage: number | null;
  conditionalFarmerPath: boolean;
  salesTaxSavingsBasis: SalesTaxSavingsBasis;
  section179Clamped: boolean;
  puvHint: PuvHint | null;
  warnings: string[];
  assumptions: string[];
  ncNotes: string[];
  exemptCategories: string[];
}

type FarmResponse = SetupResponse | AnalysisResponse;

const SCENARIO_ORDER: FarmScenarioKey[] = [
  'unreported_cash',
  'hobby',
  'schedule_f',
  'schedule_f_llc',
];

const SCENARIO_SUBTITLES: Record<FarmScenarioKey, string> = {
  unreported_cash: 'The informal status quo — shown for comparison only; not legal',
  hobby: 'Income reported as other income; expenses not deductible, no SE tax',
  schedule_f: 'Farm sole proprietorship: expenses + §179 deductible, SE tax, QBI',
  schedule_f_llc: 'Same taxes as sole prop (disregarded entity) plus NC LLC fees',
};

interface SelectedAccount {
  guid: string;
  name: string;
}

/** Multi-add account subtree picker built on the shared AccountSelector. */
function SubtreePicker({
  label,
  hint,
  accountTypes,
  selected,
  onChange,
}: {
  label: string;
  hint: string;
  accountTypes: string[];
  selected: SelectedAccount[];
  onChange: (next: SelectedAccount[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-foreground-muted mt-0.5">{hint}</span>
      </div>
      {selected.length > 0 && (
        <ul className="space-y-1">
          {selected.map((a) => (
            <li
              key={a.guid}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-background-tertiary px-3 py-1.5 text-sm text-foreground"
            >
              <span className="truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => s.guid !== a.guid))}
                className="flex items-center justify-center min-w-[28px] min-h-[28px] -my-1 rounded text-foreground-muted hover:text-negative transition-colors"
                aria-label={`Remove ${a.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <AccountSelector
        value=""
        accountTypes={accountTypes}
        placeholder="Add an account subtree…"
        onChange={(guid, name) => {
          if (!guid || selected.some((s) => s.guid === guid)) return;
          onChange([...selected, { guid, name }]);
        }}
      />
    </div>
  );
}

function ScenarioCard({
  detail,
  highlight,
}: {
  detail: FarmScenarioDetail;
  highlight: boolean;
}) {
  const rows: Array<{ label: string; value: number; paren?: boolean }> = [
    { label: 'Federal income tax', value: detail.incomeTax },
    { label: 'Self-employment tax', value: detail.seTax },
    { label: 'State income tax', value: detail.stateTax },
  ];
  if (detail.qbiDeduction > 0) {
    rows.push({ label: 'QBI deduction', value: detail.qbiDeduction, paren: true });
  }
  if (detail.section179Deduction > 0) {
    rows.push({ label: '§179 equipment write-off', value: detail.section179Deduction, paren: true });
  }
  if (detail.salesTaxSavings > 0) {
    rows.push({ label: 'Sales-tax savings', value: detail.salesTaxSavings, paren: true });
  }
  if (detail.recurringCosts > 0 || detail.oneTimeCosts > 0) {
    rows.push({ label: 'LLC fees', value: detail.recurringCosts + detail.oneTimeCosts });
  }
  const nonCompliant = !detail.compliant;
  return (
    <div
      className={`rounded-lg border p-4 space-y-3 ${
        nonCompliant
          ? 'border-negative/40 bg-negative/5'
          : highlight
            ? 'border-primary/50 bg-primary-light'
            : 'border-border bg-surface/30'
      }`}
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          {detail.label}
          {nonCompliant && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-negative border border-negative/40 rounded px-1.5 py-0.5">
              Not legal
            </span>
          )}
          {highlight && !nonCompliant && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-primary border border-primary/40 rounded px-1.5 py-0.5">
              Best
            </span>
          )}
        </h3>
        <p className="text-xs text-foreground-muted mt-0.5">
          {SCENARIO_SUBTITLES[detail.key]}
        </p>
      </div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-baseline justify-between text-xs border-b border-border/60 py-1"
          >
            <span className="text-foreground-secondary">{r.label}</span>
            <span
              className={`font-mono ${r.paren ? 'text-positive' : 'text-foreground'}`}
              style={MONO}
            >
              {r.paren ? `(${formatCurrency(r.value)})` : formatCurrency(r.value)}
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between text-sm py-1.5">
          <span className="font-semibold text-foreground">Annual cost</span>
          <span className="font-mono font-semibold text-foreground" style={MONO}>
            {formatCurrency(detail.totalCost)}
          </span>
        </div>
        <div className="flex items-baseline justify-between text-xs py-1">
          <span className="text-foreground-secondary">Farm net after tax</span>
          <span className="font-mono text-positive" style={MONO}>
            {formatCurrency(detail.netAfterTax)}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function FarmAnalyzerPage() {
  const currentYear = new Date().getFullYear();
  const defaultYear: TaxYear = isSupportedTaxYear(currentYear) ? currentYear : 2026;

  const [year, setYear] = useState<TaxYear>(defaultYear);
  // null = untouched; let the server resolve actuals / pinned values.
  const [gross, setGross] = useState<number | null>(null);
  const [expenses, setExpenses] = useState<number | null>(null);
  const [equipment, setEquipment] = useState<number | null>(null);
  const [purchases, setPurchases] = useState<number | null>(null);
  const [salesTaxPct, setSalesTaxPct] = useState<number | null>(null);
  const [priorYear, setPriorYear] = useState<number | null>(null);
  const [acreage, setAcreage] = useState<number | null>(null);
  const [firstLlcYear, setFirstLlcYear] = useState<boolean | null>(null);

  const [incomeSel, setIncomeSel] = useState<SelectedAccount[]>([]);
  const [expenseSel, setExpenseSel] = useState<SelectedAccount[]>([]);
  const [showSetup, setShowSetup] = useState(false);

  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinState, setPinState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showNc, setShowNc] = useState(false);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [graftState, setGraftState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [refreshKey, setRefreshKey] = useState(0);
  const seededRef = useRef(false);
  const { data: allAccounts = [] } = useAccounts({ flat: true });
  // Read through a ref inside the fetch effect so the account list loading
  // doesn't re-trigger the analysis fetch.
  const allAccountsRef = useRef<Account[]>([]);
  allAccountsRef.current = allAccounts as Account[];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ year: String(year) });
    if (gross !== null) params.set('gross', String(gross));
    if (expenses !== null) params.set('expenses', String(expenses));
    if (equipment !== null) params.set('equipment', String(equipment));
    if (purchases !== null) params.set('purchases', String(purchases));
    if (salesTaxPct !== null) params.set('salesTaxRate', String(salesTaxPct / 100));
    if (priorYear !== null) params.set('priorYear', String(priorYear));
    if (acreage !== null) params.set('acreage', String(acreage));
    if (firstLlcYear !== null) params.set('firstYear', firstLlcYear ? '1' : '0');

    const timer = setTimeout(() => {
      fetch(`/api/tools/farm-analysis?${params.toString()}`)
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error ?? 'Failed to load farm analysis');
          }
          return (await res.json()) as FarmResponse;
        })
        .then((payload) => {
          if (cancelled) return;
          if (payload.needsSetup) {
            setSetup(payload);
            setData(null);
            setShowSetup(true);
            return;
          }
          setSetup(null);
          setData(payload);
          if (!seededRef.current) {
            seededRef.current = true;
            setEquipment(payload.inputs.equipment);
            setPurchases(payload.inputs.purchases);
            setSalesTaxPct(Math.round(payload.inputs.salesTaxRate * 10000) / 100);
            if (payload.inputs.priorYearFarmIncome !== null) {
              setPriorYear(payload.inputs.priorYearFarmIncome);
            }
            if (payload.inputs.acreage !== null) setAcreage(payload.inputs.acreage);
            setFirstLlcYear(payload.inputs.isFirstLlcYear);
            // Seed the pickers with the pinned subtree ROOTS so reopening the
            // panel doesn't wipe the saved selection.
            const nameFor = (guid: string) => {
              const acct = allAccountsRef.current.find((a) => a.guid === guid);
              return acct?.fullname || acct?.name || guid;
            };
            setIncomeSel(
              payload.inputs.farmIncomeAccountGuids.map((g) => ({ guid: g, name: nameFor(g) })),
            );
            setExpenseSel(
              payload.inputs.farmExpenseAccountGuids.map((g) => ({ guid: g, name: nameFor(g) })),
            );
          }
        })
        .catch((err) => {
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
  }, [year, gross, expenses, equipment, purchases, salesTaxPct, priorYear, acreage, firstLlcYear, refreshKey]);

  const saveAccounts = useCallback(async () => {
    setPinState('saving');
    try {
      const res = await fetch('/api/tools/farm-analysis', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          farmIncomeAccountGuids: incomeSel.map((a) => a.guid),
          farmExpenseAccountGuids: expenseSel.map((a) => a.guid),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'save failed');
      }
      setPinState('saved');
      setShowSetup(false);
      setRefreshKey((k) => k + 1);
      setTimeout(() => setPinState('idle'), 2000);
    } catch {
      setPinState('error');
      setTimeout(() => setPinState('idle'), 3000);
    }
  }, [incomeSel, expenseSel]);

  const pinInputs = async () => {
    if (!data) return;
    setPinState('saving');
    try {
      const res = await fetch('/api/tools/farm-analysis', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          equipment: equipment ?? data.inputs.equipment,
          purchases: purchases ?? data.inputs.purchases,
          salesTaxRate: (salesTaxPct ?? data.inputs.salesTaxRate * 100) / 100,
          // null explicitly CLEARS a pinned value (empty field = unknown).
          priorYearFarmIncome: priorYear,
          acreage,
          isFirstLlcYear: firstLlcYear ?? data.inputs.isFirstLlcYear,
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

  const graftFarmAccounts = async () => {
    setGraftState('saving');
    try {
      const res = await fetch('/api/tools/farm-analysis/graft', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? 'graft failed');
      setGraftState('saved');
      setRefreshKey((key) => key + 1);
    } catch {
      setGraftState('error');
    }
  };

  const best = data?.best;
  const scheduleFSaves = (data?.scheduleFVsHobby ?? 0) > 0;

  const setupPanel = (
    <section className="rounded-lg border border-border bg-surface/30 p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Farm accounts</h2>
        <p className="text-xs text-foreground-muted mt-0.5">
          Pick the income and expense subtrees that represent the farm in this book —
          each selection includes all its child accounts. Actuals are annualized from
          the year-to-date totals.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <SubtreePicker
          label="Farm income accounts"
          hint="e.g. Income:Farm or Income:Honey Sales"
          accountTypes={['INCOME']}
          selected={incomeSel}
          onChange={setIncomeSel}
        />
        <SubtreePicker
          label="Farm expense accounts"
          hint="e.g. Expenses:Farm — feed, treatments, jars, equipment"
          accountTypes={['EXPENSE']}
          selected={expenseSel}
          onChange={setExpenseSel}
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={saveAccounts}
          disabled={incomeSel.length === 0 || pinState === 'saving'}
          className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          {pinState === 'saving' ? 'Saving…' : 'Save farm accounts'}
        </button>
        {data && (
          <button
            onClick={() => setShowSetup(false)}
            className="text-sm text-foreground-secondary hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        )}
        {pinState === 'error' && (
          <span className="text-sm text-negative">Save failed — check the selection.</span>
        )}
      </div>
    </section>
  );

  return (
    <div className="space-y-6 max-w-[1200px]">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Farm &amp; Apiary Analyzer</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Weighs formalizing your farm — hobby reporting vs Schedule F vs an NC LLC —
          using your actual income and expenses. Covers self-employment tax, the
          NC qualifying-farmer sales-tax exemption, §179 equipment write-offs, and
          LLC costs.
        </p>
      </header>

      {setup && setupPanel}
      {data && showSetup && setupPanel}

      {data && !showSetup && (
        <div className="rounded-lg border border-border bg-surface/30 p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Tax year
              <select
                value={year}
                onChange={(e) => setYear(parseInt(e.target.value, 10) as TaxYear)}
                className="bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
              >
                {SUPPORTED_TAX_YEARS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Gross farm income / yr
              <input
                type="number" min={0} step={500}
                value={gross ?? data.inputs.gross}
                onChange={(e) => setGross(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Operating expenses / yr
              <input
                type="number" min={0} step={250}
                value={expenses ?? data.inputs.expenses}
                onChange={(e) => setExpenses(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Equipment purchases (§179)
              <input
                type="number" min={0} step={250}
                value={equipment ?? data.inputs.equipment}
                onChange={(e) => setEquipment(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Taxable farm purchases / yr
              <input
                type="number" min={0} step={250}
                value={purchases ?? data.inputs.purchases}
                onChange={(e) => setPurchases(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Sales tax %
              <input
                type="number" min={0} max={12} step={0.25}
                value={salesTaxPct ?? Math.round(data.inputs.salesTaxRate * 10000) / 100}
                onChange={(e) => setSalesTaxPct(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-20 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Prior-year farm income
              <input
                type="number" min={0} step={500}
                value={priorYear ?? data.inputs.priorYearFarmIncome ?? ''}
                placeholder="unknown"
                onChange={(e) => {
                  const v = e.target.value;
                  setPriorYear(v === '' ? null : Math.max(0, parseFloat(v) || 0));
                }}
                className="w-32 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
              Acres in production
              <input
                type="number" min={0} step={1}
                value={acreage ?? data.inputs.acreage ?? ''}
                placeholder="—"
                onChange={(e) => {
                  const v = e.target.value;
                  setAcreage(v === '' ? null : Math.max(0, parseFloat(v) || 0));
                }}
                className="w-24 bg-background-tertiary border border-border rounded-md px-2 py-1.5 text-sm text-right font-mono text-foreground focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground-secondary pb-1.5">
              <input
                type="checkbox"
                checked={firstLlcYear ?? data.inputs.isFirstLlcYear}
                onChange={(e) => setFirstLlcYear(e.target.checked)}
                className="accent-primary"
              />
              First LLC year (+{formatCurrency(125)} formation)
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setShowSetup(true)}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
              >
                Farm accounts…
              </button>
              <button
                onClick={pinInputs}
                disabled={pinState === 'saving'}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
              >
                {pinState === 'saving' ? 'Pinning…' : pinState === 'saved' ? 'Pinned ✓' : pinState === 'error' ? 'Pin failed' : 'Pin these inputs'}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-foreground-muted">
            Gross income and expenses default to annualized actuals from your selected farm
            accounts ({formatCurrency(data.ytdGross)} income / {formatCurrency(data.ytdExpenses)}{' '}
            expenses YTD ÷ {data.elapsedYearFraction.toFixed(2)} of the year elapsed). Edit any
            number to explore what-ifs.
            {data.priorThreeYearAverage !== null && (
              <> NC three-year average: {formatCurrency(data.priorThreeYearAverage)}.</>
            )}
          </p>
        </div>
      )}

      {loading && !data && !setup && (
        <div className="flex items-center justify-center min-h-[240px]">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="text-foreground-secondary text-sm">Loading farm analysis…</span>
          </div>
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
              scheduleFSaves ? 'border-positive/40 bg-positive/5' : 'border-border bg-surface/30'
            }`}
          >
            <p className="text-xs uppercase tracking-wider text-foreground-muted">Verdict</p>
            <p className="mt-1 text-2xl font-bold text-foreground">
              {scheduleFSaves ? (
                <>
                  Filing Schedule F would cost{' '}
                  <span className="font-mono text-positive" style={MONO}>
                    {formatCurrency(data.scheduleFVsHobby)}
                  </span>{' '}
                  less per year than hobby treatment.
                </>
              ) : (
                <>
                  Hobby treatment is{' '}
                  <span className="font-mono text-foreground" style={MONO}>
                    {formatCurrency(Math.abs(data.scheduleFVsHobby))}
                  </span>{' '}
                  cheaper than Schedule F at these numbers.
                </>
              )}
            </p>
            <p className="mt-2 text-sm text-foreground-secondary">
              The LLC itself changes nothing about taxes — it adds{' '}
              <span className="font-mono" style={MONO}>{formatCurrency(data.llcVsSoleProp)}</span>
              {data.inputs.isFirstLlcYear ? ' this year' : '/year'} in state fees and buys
              liability protection. Going fully legitimate costs about{' '}
              <span className="font-mono" style={MONO}>{formatCurrency(data.costOfCompliance)}</span>
              /year vs unreported cash
              {data.salesTaxSavingsBasis !== 'none'
                ? ' — partially offset by the qualifying-farmer sales-tax exemption'
                : ''}
              . Filing {data.inputs.filingStatus.toUpperCase()}
              {data.taxState ? ` in ${data.taxState}` : ''}, on{' '}
              {formatCurrency(data.inputs.gross)} gross farm income.
            </p>
          </section>

          {data.warnings.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 space-y-1.5">
              {data.warnings.map((w, i) => (
                <p key={i} className="text-sm text-foreground-secondary">{w}</p>
              ))}
            </div>
          )}

          {/* Scenario grid */}
          <h2 className="sr-only">Scenario comparison</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {SCENARIO_ORDER.map((key) => (
              <ScenarioCard
                key={key}
                detail={data.scenarios[key]}
                highlight={key === best}
              />
            ))}
          </div>

          {/* PUV hint */}
          {data.puvHint && (
            <section
              className={`rounded-lg border p-4 ${
                data.puvHint.eligible
                  ? 'border-positive/40 bg-positive/5'
                  : 'border-border bg-surface/30'
              }`}
            >
              <h2 className="text-sm font-semibold text-foreground">
                Present-use value property tax
              </h2>
              <p className="text-sm text-foreground-secondary mt-1">{data.puvHint.note}</p>
            </section>
          )}

          {/* NC explainer */}
          <section className="rounded-lg border border-border bg-surface/30">
            <button
              onClick={() => setShowNc((v) => !v)}
              className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold text-foreground"
            >
              North Carolina farm rules (E-595QF, exempt purchases, honey sales)
              <span className="text-foreground-muted" aria-hidden>{showNc ? '−' : '+'}</span>
            </button>
            {showNc && (
              <div className="px-5 pb-4 space-y-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1.5">
                    Purchases exempt with a qualifying-farmer certificate
                  </h3>
                  <ul className="space-y-1 list-disc list-inside">
                    {data.exemptCategories.map((c, i) => (
                      <li key={i} className="text-xs text-foreground-secondary">{c}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1.5">
                    Things to know
                  </h3>
                  <ul className="space-y-1 list-disc list-inside">
                    {data.ncNotes.map((n, i) => (
                      <li key={i} className="text-xs text-foreground-secondary">{n}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>

          {/* Assumptions */}
          <section className="rounded-lg border border-border bg-surface/30">
            <button
              onClick={() => setShowAssumptions((v) => !v)}
              className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold text-foreground"
            >
              Model assumptions
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

          {/* CTA */}
          {!data.isFarmBusinessBook && (
            <section className="rounded-lg border border-border bg-surface/30 p-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Ready to formalize?</h2>
                <p className="text-xs text-foreground-muted mt-0.5">
                  Create a dedicated farm book with a Schedule F chart of accounts (honey
                  sales, feed, treatments, jars, equipment) — as a sole proprietorship or LLC.
                </p>
              </div>
              <button
                onClick={graftFarmAccounts}
                disabled={graftState === 'saving'}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors disabled:opacity-50"
              >
                {graftState === 'saving'
                  ? 'Adding…'
                  : graftState === 'saved'
                    ? 'Farm accounts added ✓'
                    : graftState === 'error'
                      ? 'Could not add accounts'
                      : 'Add farm accounts here'}
              </button>
              <button
                onClick={() => setNewBookOpen(true)}
                className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary-hover transition-colors"
              >
                Create farm book
              </button>
            </section>
          )}

          <p className="text-[11px] text-foreground-muted">
            Estimates only — not tax or legal advice. Consult a CPA before choosing an entity
            structure or claiming farm tax treatment.
          </p>
        </>
      )}

      <Modal isOpen={newBookOpen} onClose={() => setNewBookOpen(false)} title="Create Farm Book" size="lg">
        <div className="p-6">
          <NewBookForm
            defaultEntityType="llc_single"
            defaultBusinessActivity="farm"
            onSuccess={() => setNewBookOpen(false)}
            onCancel={() => setNewBookOpen(false)}
          />
        </div>
      </Modal>
    </div>
  );
}
